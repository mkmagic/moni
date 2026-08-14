// The pure categorization engine — normalization and rule matching, with no
// database in sight. The DB-backed half (locking, changelog, learning,
// ingest wiring) lives in tests/db/categorization.test.ts.
import { describe, expect, it } from "vitest";
import { normalizeDescription } from "@/lib/categorization/normalize";
import {
  evaluate,
  evaluateBuiltins,
  scoreRule,
  type CompiledRule,
} from "@/lib/categorization/matcher";

describe("normalizeDescription", () => {
  it("collapses the card-suffix noise Israeli issuers append", () => {
    // The same merchant, three ways a bank might report it.
    expect(normalizeDescription("שופרסל דיל 1234")).toBe(normalizeDescription("שופרסל  דיל-5678"));
    expect(normalizeDescription("שופרסל דיל 1234")).toBe("שופרסל דיל");
  });

  it("keeps short digit runs that are part of the name", () => {
    expect(normalizeDescription("כביש 6 - צפון")).toBe("כביש 6 צפון");
  });

  it("lowercases Latin merchant names", () => {
    expect(normalizeDescription("NETFLIX.COM")).toBe("netflix com");
  });

  it("strips geresh variants so quoting style doesn't split a merchant", () => {
    expect(normalizeDescription("ג׳פניקה")).toBe(normalizeDescription("ג'פניקה"));
  });

  it("strips one bank prefix, leaving the merchant at the start", () => {
    expect(normalizeDescription("תשלום ועד בית")).toBe("ועד בית");
  });

  it("does not strip a prefix that is the whole description", () => {
    // "תשלום" alone has no trailing merchant — stripping would empty it.
    expect(normalizeDescription("תשלום")).toBe("תשלום");
  });

  it("returns empty string for punctuation-only input", () => {
    expect(normalizeDescription("--- ***")).toBe("");
  });
});

describe("evaluateBuiltins", () => {
  it("matches a Hebrew supermarket to groceries", () => {
    expect(evaluateBuiltins(normalizeDescription("שופרסל דיל 1234"), "asset")?.categoryKey).toBe(
      "food-groceries",
    );
  });

  it("prefers the longest keyword, so a specific merchant beats a generic one", () => {
    // "רמי לוי תקשורת" is cellular; the bare "רמי לוי" is groceries.
    expect(evaluateBuiltins(normalizeDescription("רמי לוי תקשורת"), "asset")?.categoryKey).toBe(
      "housing-cellular",
    );
    expect(evaluateBuiltins(normalizeDescription("רמי לוי שיווק"), "asset")?.categoryKey).toBe(
      "food-groceries",
    );
  });

  it("matches Israeli-specific charges the generic taxonomies miss", () => {
    expect(
      evaluateBuiltins(normalizeDescription("ארנונה עיריית תל אביב"), "asset")?.categoryKey,
    ).toBe("housing-arnona");
    expect(evaluateBuiltins(normalizeDescription("ועד בית"), "asset")?.categoryKey).toBe(
      "housing-vaad-bayit",
    );
    expect(evaluateBuiltins(normalizeDescription("חברת הגיחון בעמ"), "asset")?.categoryKey).toBe(
      "housing-water",
    );
    expect(evaluateBuiltins(normalizeDescription("ביטוח לאומי"), "asset")?.categoryKey).toBe(
      "income-national-insurance",
    );
  });

  it("reads a card issuer as a settlement on a bank account and a fee on the card", () => {
    const settlement = normalizeDescription("ישראכרט");
    // On the checking account it is the monthly payoff — a transfer. Counting
    // it as spending would double-count every purchase it settles.
    expect(evaluateBuiltins(settlement, "asset")?.categoryKey).toBe("transfers-card-payment");
    // On the card itself the same text is a real charge, and must not be
    // silently dropped out of the expense totals.
    expect(evaluateBuiltins(settlement, "liability")?.categoryKey).not.toBe(
      "transfers-card-payment",
    );
  });

  it("does not read a payment to a person named מיכאל as a card settlement", () => {
    // Matching is substring-based with no word boundary, which is why the
    // bare "כאל" is deliberately absent from the settlement keywords.
    expect(evaluateBuiltins(normalizeDescription("העברה למיכאל"), "asset")).toBeNull();
  });

  it("returns null for an unknown merchant and for empty input", () => {
    expect(evaluateBuiltins(normalizeDescription("חנות כלשהי בלתי מזוהה"), "asset")).toBeNull();
    expect(evaluateBuiltins("", "asset")).toBeNull();
  });
});

// --- rule matching ---------------------------------------------------------

function rule(over: Partial<CompiledRule> & Pick<CompiledRule, "id">): CompiledRule {
  return {
    name: `rule-${over.id}`,
    categoryId: `cat-${over.id}`,
    effectiveDate: null,
    conditions: [],
    ...over,
  };
}

const candidate = {
  description: normalizeDescription("שופרסל דיל 1234"),
  amount: "-250.00",
  accountId: "acct-1",
  date: "2026-07-01",
};

describe("evaluate", () => {
  it("matches a description contains rule", () => {
    const r = rule({
      id: "a",
      conditions: [{ conditionType: "description", operator: "contains", value: "שופרסל" }],
    });
    expect(evaluate(candidate, [r])?.categoryId).toBe("cat-a");
  });

  it("ranks an exact rule above a contains rule regardless of array order", () => {
    const loose = rule({
      id: "loose",
      conditions: [{ conditionType: "description", operator: "contains", value: "שופרסל" }],
    });
    const exact = rule({
      id: "exact",
      conditions: [{ conditionType: "description", operator: "equals", value: "שופרסל דיל" }],
    });
    expect(evaluate(candidate, [loose, exact])?.categoryId).toBe("cat-exact");
    expect(evaluate(candidate, [exact, loose])?.categoryId).toBe("cat-exact");
    expect(scoreRule(exact)).toBeGreaterThan(scoreRule(loose));
  });

  it("breaks a score tie on rule id, deterministically", () => {
    const conditions = [
      { conditionType: "description" as const, operator: "contains" as const, value: "שופרסל" },
    ];
    const a = rule({ id: "aaa", conditions });
    const b = rule({ id: "bbb", conditions });
    expect(evaluate(candidate, [b, a])?.categoryId).toBe("cat-aaa");
    expect(evaluate(candidate, [a, b])?.categoryId).toBe("cat-aaa");
  });

  it("ANDs multiple top-level conditions", () => {
    const r = rule({
      id: "a",
      conditions: [
        { conditionType: "description", operator: "contains", value: "שופרסל" },
        { conditionType: "account", operator: "eq", value: "acct-2" },
      ],
    });
    expect(evaluate(candidate, [r])).toBeNull();
  });

  it("honors an `any` group", () => {
    const r = rule({
      id: "a",
      conditions: [
        {
          conditionType: "group",
          operator: "any",
          value: "",
          children: [
            { conditionType: "description", operator: "contains", value: "רמי לוי" },
            { conditionType: "description", operator: "contains", value: "שופרסל" },
          ],
        },
      ],
    });
    expect(evaluate(candidate, [r])?.categoryId).toBe("cat-a");
  });

  it("compares amounts on absolute value, so sign convention can't flip a rule", () => {
    const r = rule({
      id: "a",
      conditions: [{ conditionType: "amount", operator: "gt", value: "200" }],
    });
    expect(evaluate(candidate, [r])?.categoryId).toBe("cat-a");
    expect(evaluate({ ...candidate, amount: "250.00" }, [r])?.categoryId).toBe("cat-a");
  });

  it("does not apply a rule to entries dated before its effective_date", () => {
    const r = rule({
      id: "a",
      effectiveDate: "2026-07-15",
      conditions: [{ conditionType: "description", operator: "contains", value: "שופרסל" }],
    });
    expect(evaluate(candidate, [r])).toBeNull();
    expect(evaluate({ ...candidate, date: "2026-07-20" }, [r])?.categoryId).toBe("cat-a");
  });

  it("never matches a rule with no conditions or an empty group", () => {
    expect(evaluate(candidate, [rule({ id: "a" })])).toBeNull();
    const emptyGroup = rule({
      id: "b",
      conditions: [{ conditionType: "group", operator: "any", value: "", children: [] }],
    });
    expect(evaluate(candidate, [emptyGroup])).toBeNull();
  });

  it("returns null when nothing matches", () => {
    const r = rule({
      id: "a",
      conditions: [{ conditionType: "description", operator: "contains", value: "רמי לוי" }],
    });
    expect(evaluate(candidate, [r])).toBeNull();
  });
});
