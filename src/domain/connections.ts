// Domain layer for `connections` — one row per linked institution login
// (data-model.md §5). `credentials_ct` is Tier-0: AEAD'd under the caller's
// CREDENTIAL key (CK), never the data key (DK) — a scrape must be able to
// decrypt it without the DK/unlock-window machinery that gates ordinary
// Tier-1 reads (threat-model.md §5, docs plan Decision #1). Nothing here
// ever touches DK.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { connections } from "@/db/schema";
import { encryptField, decryptField, type AadContext } from "@/lib/crypto";
import { getConnectorDefinition, isConnectorId, type ConnectorId } from "@/lib/connectors";

export interface ConnectionView {
  id: string;
  connectorId: string;
  displayName: string | null;
  status: string;
  lastSyncAt: Date | null;
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
  };
}

export async function listConnections(userId: string): Promise<ConnectionView[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx.select().from(connections).orderBy(connections.createdAt);
    return rows.map(toView);
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
  credentials: Record<string, string>,
  credentialKey: Buffer,
  displayName?: string,
): Promise<{ id: string }> {
  assertValidCredentialsShape(connectorId, credentials);

  const id = randomUUID();
  const aad: AadContext = { rowId: id, column: "credentials_ct", version: 1 };
  const credentialsCt = encryptField(
    credentialKey,
    Buffer.from(JSON.stringify(credentials), "utf8"),
    aad,
  );

  return withUser(userId, async (tx) => {
    await tx.insert(connections).values({
      id,
      ownerId: userId,
      connectorId,
      displayName: displayName ?? null,
      credentialsCt,
      status: "active",
    });
    return { id };
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
      .select({ connectorId: connections.connectorId, version: connections.version })
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1);
    const row = rows[0];
    if (!row) return false;

    const connectorId = row.connectorId;
    if (!isConnectorId(connectorId)) throw new UnknownConnectorError(connectorId);
    assertValidCredentialsShape(connectorId, credentials);

    const nextVersion = row.version + 1;
    const credentialsCt = encryptField(
      credentialKey,
      Buffer.from(JSON.stringify(credentials), "utf8"),
      { rowId: connectionId, column: "credentials_ct", version: nextVersion },
    );

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

    const plaintext = decryptField(credentialKey, Buffer.from(row.credentialsCt), {
      rowId: row.id,
      column: "credentials_ct",
      version: row.version,
    });
    return {
      id: row.id,
      connectorId: row.connectorId,
      credentials: JSON.parse(plaintext.toString("utf8")) as Record<string, string>,
    };
  });
}
