// Domain layer for `connections` — one row per linked institution login
// (data-model.md §5). `credentials_ct` is Tier-0: AEAD'd under the caller's
// CREDENTIAL key (CK), never the data key (DK) — a scrape must be able to
// decrypt it without the DK/unlock-window machinery that gates ordinary
// Tier-1 reads (threat-model.md §5, docs plan Decision #1). Nothing here
// ever touches DK.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, max } from "drizzle-orm";
import { withUser, type UserTransaction } from "@/db/client";
import { accountBalanceSnapshots, accounts, connections, syncRuns } from "@/db/schema";
import { encryptField, decryptField, type AadContext } from "@/lib/crypto";
import { getConnectorDefinition, isConnectorId, type ConnectorId } from "@/lib/connectors";

export interface ConnectionView {
  id: string;
  connectorId: string;
  displayName: string | null;
  status: string;
  /**
   * How current the connection's data is. For a credentialed fetch this is the
   * stored `last_sync_at` — when Moni last pulled it. For a file import there
   * is no meaningful "fetch time": the number that matters is the date the
   * uploaded file itself is *as of* (a Q2 pension report is current as of June
   * 30 however recently it was uploaded), so this reports the latest such date
   * across the connection's imported snapshots instead. Null when nothing has
   * been fetched or imported yet.
   */
  lastSyncAt: Date | null;
  mode: "credentialed_fetch" | "user_mediated_import";
}

export interface DecryptedConnection {
  id: string;
  connectorId: string;
  credentials: Record<string, string>;
}

/** Thrown when a connector id isn't in the registry (src/lib/connectors). */
export class UnknownConnectorError extends Error {
  constructor(connectorId: string) {
    super(`Unknown connector id "${connectorId}"`);
    this.name = "UnknownConnectorError";
  }
}

/** Thrown when the credentials object's keys don't exactly match the
 * connector's registered login fields — fail closed, never store a
 * partial/mismatched credential set (docs/design/conventions.md). */
export class InvalidCredentialsShapeError extends Error {
  constructor(connectorId: string) {
    super(`Credentials for connector "${connectorId}" don't match its registered login fields`);
    this.name = "InvalidCredentialsShapeError";
  }
}

/** Thrown when credentials are requested for an import-only connection. */
export class ConnectionCredentialsUnavailableError extends Error {
  constructor() {
    super("This connection does not store credentials");
  }
}

function assertValidCredentialsShape(
  connectorId: ConnectorId,
  credentials: Record<string, string>,
): void {
  const def = getConnectorDefinition(connectorId);
  if (!def) throw new UnknownConnectorError(connectorId);

  const expectedKeys = def.loginFields.map((f) => f.key).sort();
  const actualKeys = Object.keys(credentials).sort();
  const matches =
    expectedKeys.length === actualKeys.length && expectedKeys.every((k, i) => k === actualKeys[i]);
  if (!matches) throw new InvalidCredentialsShapeError(connectorId);
}

function toView(row: typeof connections.$inferSelect): ConnectionView {
  return {
    id: row.id,
    connectorId: row.connectorId,
    displayName: row.displayName,
    status: row.status,
    lastSyncAt: row.lastSyncAt,
    mode: row.mode,
  };
}

/**
 * The most recent date the imported data is *as of*, per import connection —
 * `max(account_balance_snapshots.date)` over the connection's accounts. Both
 * import kinds write that column with the file's own date (a long-term-savings
 * report's report date, a positions CSV's source date), so it is the single
 * source of truth for import freshness and needs no denormalised copy on the
 * connection row. Connections with no snapshot yet are simply absent from the
 * map (→ null lastSyncAt → "Never synced").
 */
async function latestImportedDataDate(
  tx: UserTransaction,
  connectionIds: string[],
): Promise<Map<string, Date>> {
  const rows = await tx
    .select({ connectionId: accounts.connectionId, latest: max(accountBalanceSnapshots.date) })
    .from(accountBalanceSnapshots)
    .innerJoin(accounts, eq(accounts.id, accountBalanceSnapshots.accountId))
    .where(inArray(accounts.connectionId, connectionIds))
    .groupBy(accounts.connectionId);
  const byConnection = new Map<string, Date>();
  for (const row of rows) {
    // `date` is a calendar date; anchor it at UTC midnight for the timestamp field.
    if (row.connectionId && row.latest)
      byConnection.set(row.connectionId, new Date(`${row.latest}T00:00:00Z`));
  }
  return byConnection;
}

export async function listConnections(userId: string): Promise<ConnectionView[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx.select().from(connections).orderBy(connections.createdAt);
    const importIds = rows.filter((r) => r.mode === "user_mediated_import").map((r) => r.id);
    const importedAsOf = importIds.length
      ? await latestImportedDataDate(tx, importIds)
      : new Map<string, Date>();
    return rows.map((row) =>
      row.mode === "user_mediated_import"
        ? { ...toView(row), lastSyncAt: importedAsOf.get(row.id) ?? null }
        : toView(row),
    );
  });
}

export async function getConnection(
  userId: string,
  connectionId: string,
): Promise<ConnectionView | null> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);
    const row = rows[0];
    return row ? toView(row) : null;
  });
}

/** First connection matching `connectorId` for this user, or null. Used to
 * reuse an existing linked login rather than creating a duplicate one. */
export async function findConnectionByConnector(
  userId: string,
  connectorId: string,
): Promise<ConnectionView | null> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select()
      .from(connections)
      .where(eq(connections.connectorId, connectorId))
      .limit(1);
    const row = rows[0];
    return row ? toView(row) : null;
  });
}

/**
 * Creates a connection, encrypting `credentials` under the caller's
 * credential key (CK) BEFORE the first write — no plaintext-at-rest window,
 * ever (docs/security/security-design-principles.md §4). The row id is
 * generated first because the AAD binds to it (trap #1: AAD needs the row id
 * before the INSERT, docs plan §E.1).
 */
export async function createConnection(
  userId: string,
  connectorId: ConnectorId,
  credentials: Record<string, string> | null,
  credentialKey: Buffer | null,
  displayName?: string,
): Promise<{ id: string }> {
  const definition = getConnectorDefinition(connectorId);
  if (!definition) throw new UnknownConnectorError(connectorId);
  if (definition.mode === "credentialed_fetch") {
    if (!credentials || !credentialKey) throw new InvalidCredentialsShapeError(connectorId);
    assertValidCredentialsShape(connectorId, credentials);
  } else if (credentials !== null || credentialKey !== null) {
    throw new ConnectionCredentialsUnavailableError();
  }

  const id = randomUUID();
  const aad: AadContext = { rowId: id, column: "credentials_ct", version: 1 };
  let credentialsCt: Buffer | null = null;
  if (credentials && credentialKey) {
    const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
    try {
      credentialsCt = encryptField(credentialKey, plaintext, aad);
    } finally {
      plaintext.fill(0);
    }
  }

  return withUser(userId, async (tx) => {
    await tx.insert(connections).values({
      id,
      ownerId: userId,
      connectorId,
      displayName: displayName ?? null,
      credentialsCt,
      mode: definition.mode,
      status: "active",
    });
    return { id };
  });
}

/** Removes reusable source access but retains the financial record. */
export async function disconnectConnection(
  userId: string,
  connectionId: string,
): Promise<"disconnected" | "not_found" | "sync_running"> {
  return withUser(userId, async (tx) => {
    const row = (
      await tx
        .select({ id: connections.id })
        .from(connections)
        .where(eq(connections.id, connectionId))
        .for("update")
        .limit(1)
    )[0];
    if (!row) return "not_found";
    const running = await tx
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(and(eq(syncRuns.connectionId, connectionId), eq(syncRuns.status, "running")))
      .limit(1);
    if (running[0]) return "sync_running";
    await tx
      .update(connections)
      .set({ credentialsCt: null, status: "disconnected" })
      .where(eq(connections.id, connectionId));
    return "disconnected";
  });
}

/**
 * Renames a connection. `display_name` is plaintext, and `connections` has
 * exactly one ciphertext column (`credentials_ct`), so this deliberately does
 * NOT bump `version`: the row version is shared by every ciphertext column on
 * it, and bumping it here would silently break the AAD on credentials nobody
 * re-encrypted (docs plan §E.2 — trap #3).
 */
export async function renameConnection(
  userId: string,
  connectionId: string,
  displayName: string | null,
): Promise<boolean> {
  const trimmed = displayName?.trim() ?? "";
  return withUser(userId, async (tx) => {
    const updated = await tx
      .update(connections)
      .set({ displayName: trimmed === "" ? null : trimmed })
      .where(eq(connections.id, connectionId))
      .returning({ id: connections.id });
    return updated.length > 0;
  });
}

/**
 * Replaces a connection's stored bank credentials — the remedy for a typo at
 * connect time, which previously required manual SQL.
 *
 * Re-encrypts under CK at the BUMPED version and writes both in one
 * statement, so the stored AAD and ciphertext can never disagree. Because
 * `credentials_ct` is the row's only ciphertext column, bumping the version
 * here is complete by construction — but the read-modify-write still happens
 * inside a single transaction so a concurrent sync can't decrypt at a version
 * that has already moved (docs plan §E.2).
 *
 * Returns false when the connection doesn't exist for this user (RLS filters
 * a cross-tenant id to zero rows, same as every other read here).
 */
export async function updateConnectionCredentials(
  userId: string,
  connectionId: string,
  credentials: Record<string, string>,
  credentialKey: Buffer,
): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({
        connectorId: connections.connectorId,
        mode: connections.mode,
        version: connections.version,
      })
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);
    const row = rows[0];
    if (!row) return false;
    if (row.mode !== "credentialed_fetch") throw new ConnectionCredentialsUnavailableError();

    const connectorId = row.connectorId;
    if (!isConnectorId(connectorId)) throw new UnknownConnectorError(connectorId);
    assertValidCredentialsShape(connectorId, credentials);

    const nextVersion = row.version + 1;
    const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
    let credentialsCt: Buffer;
    try {
      credentialsCt = encryptField(credentialKey, plaintext, {
        rowId: connectionId,
        column: "credentials_ct",
        version: nextVersion,
      });
    } finally {
      plaintext.fill(0);
    }

    await tx
      .update(connections)
      .set({ credentialsCt, version: nextVersion, status: "active" })
      .where(eq(connections.id, connectionId));
    return true;
  });
}

/**
 * Decrypts a connection's stored credentials under the caller's credential
 * key — the only place this ciphertext is ever opened. Returns null if the
 * connection doesn't exist for this user (RLS silently filters a
 * cross-tenant id, domain-layer.md §5).
 */
export async function getDecryptedCredentials(
  userId: string,
  connectionId: string,
  credentialKey: Buffer,
): Promise<DecryptedConnection | null> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.mode !== "credentialed_fetch" || !row.credentialsCt) {
      throw new ConnectionCredentialsUnavailableError();
    }

    const plaintext = decryptField(credentialKey, Buffer.from(row.credentialsCt), {
      rowId: row.id,
      column: "credentials_ct",
      version: row.version,
    });
    try {
      return {
        id: row.id,
        connectorId: row.connectorId,
        credentials: JSON.parse(plaintext.toString("utf8")) as Record<string, string>,
      };
    } finally {
      plaintext.fill(0);
    }
  });
}

/**
 * Reads a connection's `credentials_ct` and its AAD `version` WITHOUT
 * decrypting — the ciphertext-only counterpart to `getDecryptedCredentials`,
 * for the bank sync path (issue #92). The parent hands `{ ciphertext, version }`
 * plus CK to the disposable fetcher, which decrypts it itself; the parent never
 * sees plaintext credentials. Returns null if the connection doesn't exist for
 * this user (RLS-filtered cross-tenant id); throws
 * `ConnectionCredentialsUnavailableError` for an import-only connection, exactly
 * like `getDecryptedCredentials`.
 */
export async function getEncryptedCredentials(
  userId: string,
  connectionId: string,
): Promise<{ ciphertext: Buffer; version: number } | null> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({
        mode: connections.mode,
        credentialsCt: connections.credentialsCt,
        version: connections.version,
      })
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.mode !== "credentialed_fetch" || !row.credentialsCt) {
      throw new ConnectionCredentialsUnavailableError();
    }
    return { ciphertext: Buffer.from(row.credentialsCt), version: row.version };
  });
}
