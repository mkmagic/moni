/**
 * Turns a worker's safe failure code into something a person can act on.
 *
 * Workers deliberately surface opaque codes so a provider's own error text can
 * never carry credentials or portfolio data into a log or a page. That leaves
 * the code as the only signal, so the mapping to advice lives here — shared by
 * the connections list and the investments screen so both say the same thing.
 */

// IBKR's Flex Web Service reports these numerically; the worker prefixes them
// with the request phase (`send_flex_1012`, `retrieve_flex_1019`).
const IBKR_FLEX_CODES: Record<string, string> = {
  "1003": "The broker has no statement available for this query yet. Try again later.",
  "1010":
    "Interactive Brokers no longer supports this legacy query. Recreate it as an Activity Flex Query.",
  "1011": "This Flex Web Service account is inactive. Re-enable it in Client Portal.",
  "1012":
    "Your Flex token has expired. Create a new token in Client Portal and update the credentials for this connection.",
  "1013":
    "Interactive Brokers refused this server's IP address. Update the token's IP restriction in Client Portal.",
  "1014": "This Flex query is invalid. Check the query ID in this connection's credentials.",
  "1015":
    "Your Flex token is invalid. Create a new token in Client Portal and update the credentials for this connection.",
  "1016": "The account behind this Flex query is invalid.",
  "1017": "The broker rejected the reference code for this report. Retry the sync.",
  "1018": "Too many requests have used this Flex token. Wait a few minutes and retry.",
  "1019": "The broker is still generating the statement. Retry in a moment.",
  "1020": "Interactive Brokers could not validate the request. Confirm the token and query ID.",
  "1021": "The broker could not return the statement right now. Retry the sync.",
};

const CODES: Record<string, string> = {
  provider_rejected:
    "The broker rejected the request — most often an expired Flex token. Create a new token in Client Portal and update the credentials for this connection.",
  send_unexpected_response: "The broker returned an unexpected response. Retry the sync.",
  send_invalid_reference_code: "The broker returned an unusable reference code. Retry the sync.",
  retrieve_unexpected_response:
    "The broker returned an unexpected response while sending the report. Retry the sync.",
  retrieve_attempts_exhausted:
    "The broker did not finish generating the report in time. Retry the sync.",
  redirect_rejected: "The broker redirected the request, which is refused for safety.",
  source_too_large: "The broker's report was larger than Moni will accept.",
  invalid_credentials:
    "This connection is missing its Flex token or query ID. Edit it to add them.",
  incomplete_snapshot: "The broker's report was missing data Moni needs to value the account.",
  incomplete_coverage: "The broker's report did not cover every account in the query.",
  identity_conflict: "The broker's report contradicted itself and was not accepted.",
  unsupported_source_shape: "Moni could not read the broker's report format.",
  unvalued_position: "The broker reported a holding with no price or value.",
  blank_input: "The statement file was empty.",
  missing_fx: "No Bank of Israel exchange rate was available for the report's dates.",
  invalid_fx: "The Bank of Israel returned an unusable exchange rate.",
  invalid_sync:
    "This sync run no longer matches its connection, so the snapshot was not accepted. Start a new sync.",
  promotion_failed:
    "Moni could not save the snapshot it fetched. The broker's data arrived fine, so retry the sync; if it keeps failing, restart with MONI_SYNC_DIAGNOSTIC=1 to log the underlying fault.",
  source_worker_failed: "The sync did not complete. Retry it.",
  source_worker_start_failed: "Moni could not start the sync. Retry it.",
};

/** Returns actionable advice for a failure code, or the raw code when unrecognized. */
export function syncErrorMessage(code: string | null | undefined): string {
  if (!code) return "Last sync failed";
  const flex = /^(?:send|retrieve)_flex_(\d+)$/.exec(code.trim());
  if (flex) return IBKR_FLEX_CODES[flex[1]] ?? `The broker rejected the request (code ${flex[1]}).`;
  return CODES[code.trim()] ?? code;
}
