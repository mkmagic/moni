#!/usr/bin/env node
// PROTOTYPE — throwaway live Schwab Trader API evidence collector for issue #39.
//
// It writes nothing and does not use Moni's database. App credentials, the
// redirected authorization URL, OAuth tokens, and account data stay in RAM.
// Final output contains only field names, row counts, and contract results.
import { randomBytes, timingSafeEqual } from "node:crypto";

import { analyzeAccountsResponse, type SchwabInventory } from "./model";

const AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const ACCOUNTS_URL = "https://api.schwabapi.com/trader/v1/accounts?fields=positions";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024;
const MAX_ACCOUNT_RESPONSE_BYTES = 50 * 1024 * 1024;

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

class SafeProbeError extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
  }
}

function clearFrame(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
}

function printHelp(): void {
  console.log(`Schwab Trader API POC

Question:
  Can one owner-operated Schwab Trader API - Individual app provide Moni's
  complete investment snapshot contract, and what credential authority remains?

Boundary:
  The Schwab brokerage account, developer profile, and app must have the same
  owner. This POC does not establish permission to connect another Moni user's
  Schwab account. That requires Trader API - Commercial.

Schwab setup:
  1. Register as an Individual Developer at https://developer.schwab.com/.
  2. Request Trader API - Individual access.
  3. Create an app subscribed to Accounts and Trading Production.
  4. Register an exact callback URL. Schwab's guide permits multiple callback
     URLs but requires the redirect_uri used here to match one exactly.
  5. Wait until the app is approved/active and copy its App Key and Secret.

Run:
  npm run poc:schwab-trader

The command prompts without putting credentials or the authorization response
in argv, shell history, or environment variables. It opens no listener and
persists nothing: after Schwab redirects, paste the entire address-bar URL into
the hidden terminal prompt.`);
}

async function readHiddenInput(label: string, maxLength: number): Promise<Buffer> {
  if (!process.stdin.isTTY) throw new SafeProbeError("interactive_tty_required");

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const input = Buffer.alloc(maxLength);
    let length = 0;
    process.stdout.write(`${label} (input hidden): `);
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const fail = (code: string): void => {
      input.fill(0);
      cleanup();
      process.stdout.write("\n");
      reject(new SafeProbeError(code));
    };

    const finish = (): void => {
      if (length === 0) {
        fail("empty_input");
        return;
      }
      const result = Buffer.from(input.subarray(0, length));
      input.fill(0);
      cleanup();
      process.stdout.write("\n");
      resolve(result);
    };

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          chunk.fill(0);
          fail("cancelled");
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          chunk.fill(0);
          finish();
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          if (length > 0) {
            length -= 1;
            input[length] = 0;
          }
          continue;
        }
        if (byte < 0x20) continue;
        if (length >= maxLength) {
          chunk.fill(0);
          fail("input_too_long");
          return;
        }
        input[length] = byte;
        length += 1;
      }
      chunk.fill(0);
    };

    stdin.on("data", onData);
  });
}

function bufferText(buffer: Buffer): string {
  return buffer.toString("utf8");
}

function assertAllowedUrl(value: URL, expected: string): void {
  const allowed = new URL(expected);
  if (
    value.protocol !== "https:" ||
    value.hostname !== allowed.hostname ||
    value.port !== allowed.port ||
    value.pathname !== allowed.pathname
  ) {
    throw new SafeProbeError("unexpected_request_destination");
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number.parseInt(declaredLength, 10) > maximumBytes) {
    throw new SafeProbeError("response_too_large");
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maximumBytes) {
    body.fill(0);
    throw new SafeProbeError("response_too_large");
  }
  return body;
}

function findJsonStringValue(body: Buffer, key: string): { start: number; end: number } | null {
  const marker = Buffer.from(`"${key}"`, "ascii");
  const keyOffset = body.indexOf(marker);
  marker.fill(0);
  if (keyOffset < 0) return null;

  let offset = keyOffset + key.length + 2;
  while (offset < body.length && /\s/.test(String.fromCharCode(body[offset]))) offset += 1;
  if (body[offset] !== 0x3a) return null;
  offset += 1;
  while (offset < body.length && /\s/.test(String.fromCharCode(body[offset]))) offset += 1;
  if (body[offset] !== 0x22) return null;

  const start = offset + 1;
  offset = start;
  while (offset < body.length) {
    if (body[offset] === 0x5c) throw new SafeProbeError("escaped_oauth_token_unsupported");
    if (body[offset] === 0x22) return { start, end: offset };
    offset += 1;
  }
  return null;
}

function extractAndRedactJsonSecret(body: Buffer, key: string): Buffer | null {
  const range = findJsonStringValue(body, key);
  if (!range) return null;

  const value = Buffer.from(body.subarray(range.start, range.end));
  body.fill(0x78, range.start, range.end);
  return value;
}

function parseCallback(
  callbackInput: Buffer,
  registeredCallback: Buffer,
  expectedState: Buffer,
): Buffer {
  let callbackText = bufferText(callbackInput);
  let registeredText = bufferText(registeredCallback);

  try {
    const callback = new URL(callbackText);
    const registered = new URL(registeredText);
    if (
      callback.protocol !== registered.protocol ||
      callback.host !== registered.host ||
      callback.pathname !== registered.pathname
    ) {
      throw new SafeProbeError("callback_url_mismatch");
    }

    const returnedState = callback.searchParams.get("state");
    const code = callback.searchParams.get("code");
    const error = callback.searchParams.get("error");
    if (error) throw new SafeProbeError("authorization_denied");
    if (!returnedState || !code) throw new SafeProbeError("callback_missing_code_or_state");

    const returnedStateBuffer = Buffer.from(returnedState, "utf8");
    try {
      if (
        returnedStateBuffer.length !== expectedState.length ||
        !timingSafeEqual(returnedStateBuffer, expectedState)
      ) {
        throw new SafeProbeError("oauth_state_mismatch");
      }
    } finally {
      returnedStateBuffer.fill(0);
    }
    return Buffer.from(code, "utf8");
  } finally {
    callbackText = "";
    registeredText = "";
  }
}

async function exchangeCode(
  clientId: Buffer,
  clientSecret: Buffer,
  callback: Buffer,
  code: Buffer,
): Promise<{
  accessToken: Buffer;
  refreshToken: Buffer | null;
  tokenMetadata: Record<string, unknown>;
}> {
  const destination = new URL(TOKEN_URL);
  assertAllowedUrl(destination, TOKEN_URL);

  let credentialsText = `${bufferText(clientId)}:${bufferText(clientSecret)}`;
  let authorization = `Basic ${Buffer.from(credentialsText, "utf8").toString("base64")}`;
  let formText = `grant_type=authorization_code&code=${encodeURIComponent(
    bufferText(code),
  )}&redirect_uri=${encodeURIComponent(bufferText(callback))}`;

  try {
    const response = await fetch(destination, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formText,
    });
    if (!response.ok) throw new SafeProbeError(`token_http_${response.status}`);

    const body = await readBoundedResponse(response, MAX_TOKEN_RESPONSE_BYTES);
    try {
      const accessToken = extractAndRedactJsonSecret(body, "access_token");
      const refreshToken = extractAndRedactJsonSecret(body, "refresh_token");
      if (!accessToken || accessToken.length === 0) {
        refreshToken?.fill(0);
        throw new SafeProbeError("token_response_missing_access_token");
      }

      const metadata: unknown = JSON.parse(body.toString("utf8"));
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        accessToken.fill(0);
        refreshToken?.fill(0);
        throw new SafeProbeError("invalid_token_response");
      }
      return {
        accessToken,
        refreshToken,
        tokenMetadata: metadata as Record<string, unknown>,
      };
    } finally {
      body.fill(0);
    }
  } finally {
    credentialsText = "";
    authorization = "";
    formText = "";
  }
}

async function fetchAccounts(accessToken: Buffer): Promise<{
  body: Buffer;
  responseDate: string | null;
}> {
  const destination = new URL(ACCOUNTS_URL);
  assertAllowedUrl(destination, ACCOUNTS_URL);
  let authorization = `Bearer ${bufferText(accessToken)}`;

  try {
    const response = await fetch(destination, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        Authorization: authorization,
      },
    });
    if (!response.ok) throw new SafeProbeError(`accounts_http_${response.status}`);

    return {
      body: await readBoundedResponse(response, MAX_ACCOUNT_RESPONSE_BYTES),
      responseDate: response.headers.get("date"),
    };
  } finally {
    authorization = "";
  }
}

function renderInventory(
  inventory: SchwabInventory,
  tokenMetadata: Record<string, unknown>,
  refreshTokenPresent: boolean,
): void {
  clearFrame();
  console.log(`${bold}Schwab Trader API POC — issue #39${reset}`);
  console.log(
    `${dim}Owner-only Individual app; account data and OAuth secrets remained in this process.${reset}\n`,
  );
  console.log(`${bold}OAuth exchange${reset}: succeeded`);
  console.log(`${bold}access token${reset}: received`);
  console.log(`${bold}refresh token${reset}: ${refreshTokenPresent ? "received" : "absent"}`);
  console.log(
    `${bold}expiry metadata${reset}: ${
      typeof tokenMetadata.expires_in === "number" ? "received" : "absent"
    }`,
  );
  console.log(
    `${bold}scope metadata${reset}: ${
      typeof tokenMetadata.scope === "string" ? "received" : "absent"
    }`,
  );

  console.log(`\n${bold}Redacted account inventory${reset}`);
  console.log(`response bytes held in RAM: ${inventory.responseBytes}`);
  console.log(`Schwab HTTP Date header: ${inventory.responseDateHeader}`);
  console.log(`accounts: ${inventory.accountCount}`);
  console.log(`positions: ${inventory.positionCount}`);
  console.log(`account fields: ${inventory.accountFields.join(", ") || "(none observed)"}`);
  console.log(`position fields: ${inventory.positionFields.join(", ") || "(none observed)"}`);
  console.log(`instrument fields: ${inventory.instrumentFields.join(", ") || "(none observed)"}`);
  console.log(
    `current-balance fields: ${inventory.currentBalanceFields.join(", ") || "(none observed)"}`,
  );

  console.log(`\n${bold}Source-contract evidence${reset}`);
  for (const result of inventory.checks) {
    const marker = result.status === "proven" ? "✓" : "?";
    console.log(`${marker} ${result.status.padEnd(8)} ${result.name} — ${result.evidence}`);
  }

  const complete = inventory.checks.every((result) => result.status === "proven");
  console.log(
    `\n${bold}field verdict${reset}: ${
      complete
        ? "snapshot field contract proven for this account/app sample"
        : "snapshot field contract remains unproven; inspect the unproven source facts"
    }`,
  );
  console.log(
    `${bold}authority verdict${reset}: treat the credential as trading-capable Tier 0; the subscribed product is Accounts and Trading, not a proven read-only scope`,
  );
  console.log(
    `${dim}No app secret, authorization code, token, account number, field value, raw response, or callback URL was printed or persisted.${reset}`,
  );
  console.log(
    `${dim}Residual: Node's HTTP APIs require immutable header/body strings for the app secret, authorization code, and access token; this throwaway process exits immediately after the probe.${reset}`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  let clientId: Buffer | null = null;
  let clientSecret: Buffer | null = null;
  let callback: Buffer | null = null;
  let callbackResult: Buffer | null = null;
  let code: Buffer | null = null;
  let accessToken: Buffer | null = null;
  let refreshToken: Buffer | null = null;
  let accountBody: Buffer | null = null;
  const state = randomBytes(32).toString("base64url");
  const stateBuffer = Buffer.from(state, "ascii");

  try {
    console.log(`${bold}Schwab Trader API POC — issue #39${reset}`);
    console.log(`${dim}All prompts are hidden and nothing is written to disk.${reset}\n`);
    clientId = await readHiddenInput("App Key", 512);
    clientSecret = await readHiddenInput("App Secret", 1024);
    callback = await readHiddenInput("Exact registered callback URL", 2048);

    const callbackUrl = new URL(bufferText(callback));
    if (callbackUrl.protocol !== "https:") throw new SafeProbeError("https_callback_required");

    const authorizationUrl = new URL(AUTHORIZE_URL);
    assertAllowedUrl(authorizationUrl, AUTHORIZE_URL);
    authorizationUrl.searchParams.set("client_id", bufferText(clientId));
    authorizationUrl.searchParams.set("redirect_uri", callbackUrl.toString());
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("state", state);

    console.log(`\nOpen this one-time URL in your browser and authorize only your own account:`);
    console.log(authorizationUrl.toString());
    console.log(
      `${dim}After Schwab redirects, copy the entire address-bar URL. A browser error at a loopback callback is acceptable.${reset}`,
    );
    callbackResult = await readHiddenInput("Redirected URL", 16 * 1024);
    code = parseCallback(callbackResult, callback, stateBuffer);
    callbackResult.fill(0);
    callbackResult = null;

    const tokenResult = await exchangeCode(clientId, clientSecret, callback, code);
    accessToken = tokenResult.accessToken;
    refreshToken = tokenResult.refreshToken;
    code.fill(0);
    code = null;

    const accountResult = await fetchAccounts(accessToken);
    accountBody = accountResult.body;
    const accountSource = accountBody.toString("utf8");
    const inventory = analyzeAccountsResponse(
      accountSource,
      accountBody.length,
      accountResult.responseDate,
    );
    renderInventory(inventory, tokenResult.tokenMetadata, refreshToken !== null);
  } catch (error) {
    clearFrame();
    const safeCode =
      error instanceof SafeProbeError
        ? error.safeCode
        : error instanceof DOMException && error.name === "TimeoutError"
          ? "request_timeout"
          : "unexpected_failure";
    console.error(`${bold}Schwab Trader API POC failed${reset}`);
    console.error(`safe failure code: ${safeCode}`);
    process.exitCode = 1;
  } finally {
    clientId?.fill(0);
    clientSecret?.fill(0);
    callback?.fill(0);
    callbackResult?.fill(0);
    code?.fill(0);
    accessToken?.fill(0);
    refreshToken?.fill(0);
    accountBody?.fill(0);
    stateBuffer.fill(0);
  }
}

await main();
