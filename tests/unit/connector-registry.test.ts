// Drift gate for src/lib/connectors/registry.ts (task 9's stated
// verification): each registry entry's login-field KEYS, in order, must
// equal the real israeli-bank-scrapers library's `SCRAPERS[id].loginFields`
// — so a library upgrade that reorders or renames a connector's credential
// fields fails this test instead of silently producing a scraper call with
// the wrong argument shape.
import { describe, expect, it } from "vitest";
import { SCRAPERS } from "israeli-bank-scrapers";
import { CONNECTOR_REGISTRY } from "@/lib/connectors/registry";
import { SCRAPER_BACKED_KINDS } from "@/lib/connectors/types";

describe("CONNECTOR_REGISTRY matches israeli-bank-scrapers' SCRAPERS", () => {
  const scrapersById = SCRAPERS as unknown as Record<
    string,
    { name: string; loginFields: string[] }
  >;

  // An allowlist of the scraper-backed kinds, not a denylist of the one kind
  // that isn't. A denylist quietly stops gating the moment a connector kind is
  // added that the library has never heard of — and then asserts the library
  // has an entry for it, which fails for the wrong reason.
  for (const [id, def] of Object.entries(CONNECTOR_REGISTRY).filter(([, definition]) =>
    SCRAPER_BACKED_KINDS.includes(definition.kind),
  )) {
    it(`${id}: field keys (in order) match SCRAPERS["${id}"].loginFields`, () => {
      const libEntry = scrapersById[id];
      expect(libEntry, `SCRAPERS has no entry for "${id}"`).toBeDefined();
      expect(def.loginFields.map((f) => f.key)).toEqual(libEntry.loginFields);
    });
  }

  it("oneZero is deliberately excluded (needs OTP, which this registry can't express)", () => {
    expect(Object.prototype.hasOwnProperty.call(CONNECTOR_REGISTRY, "oneZero")).toBe(false);
    // Confirms the exclusion is a deliberate choice, not an oversight — the
    // library really does define it.
    expect(scrapersById.oneZero).toBeDefined();
  });

  it("defines exactly the supported investment connectors", () => {
    expect(
      Object.values(CONNECTOR_REGISTRY).filter((definition) => definition.kind === "investment"),
    ).toEqual([
      expect.objectContaining({
        id: "ibkr_flex",
        mode: "credentialed_fetch",
        loginFields: [
          expect.objectContaining({ key: "flexToken" }),
          expect.objectContaining({ key: "queryId" }),
        ],
      }),
      expect.objectContaining({
        id: "schwab_positions_csv",
        mode: "user_mediated_import",
        loginFields: [],
      }),
      expect.objectContaining({
        id: "snaptrade",
        mode: "credentialed_fetch",
        loginFields: [
          expect.objectContaining({ key: "clientId" }),
          expect.objectContaining({ key: "consumerKey" }),
        ],
      }),
    ]);
  });

  it("defines exactly the supported long-term-savings connectors", () => {
    expect(
      Object.values(CONNECTOR_REGISTRY).filter(
        (definition) => definition.kind === "long_term_savings",
      ),
    ).toEqual([
      expect.objectContaining({
        id: "harel_pension_quarterly",
        institutionLabel: "Harel",
        product: "pension",
        // A quarterly report is uploaded by the user; there is nothing to log
        // in to and therefore no credential to hold.
        mode: "user_mediated_import",
        loginFields: [],
      }),
    ]);
  });

  it("carries a product on every long-term-savings connector and on no other", () => {
    for (const definition of Object.values(CONNECTOR_REGISTRY)) {
      expect(definition.product !== undefined, `${definition.id} (${definition.kind})`).toBe(
        definition.kind === "long_term_savings",
      );
    }
  });
});
