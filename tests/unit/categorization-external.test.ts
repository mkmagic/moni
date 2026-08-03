import { describe, expect, it } from "vitest";
import {
  blocksEgress,
  guarded,
  ResponseSchema,
  SYSTEM_PROMPT,
  leafCatalog,
  UNKNOWN,
  type Answer,
} from "@/lib/categorization/external";
import { DEFAULT_CATEGORIES } from "@/lib/categorization/default-categories";

describe("external categorization pure functions", () => {
  it("blocksEgress filters out P2P and transfer strings while permitting merchant names", () => {
    expect(blocksEgress("ביט העברה מישראל כהן")).toBe(true);
    expect(blocksEgress("פייבוקס העברת כספים")).toBe(true);
    expect(blocksEgress("העברה לישראל כהן")).toBe(true);
    
    // Check that it catches prefixes even with spaces (raw unnormalized form)
    expect(blocksEgress("העברה ל ישראל כהן")).toBe(true);
    expect(blocksEgress("Paybox Transfer")).toBe(true); // mixed case

    expect(blocksEgress("שופרסל דיל")).toBe(false);
    expect(blocksEgress("רמי לוי תקשורת")).toBe(false);
  });

  it("guarded drops low confidence and keeps medium/high confidence", () => {
    const lowAnswer: Answer = {
      key: "food-groceries",
      brand: "Shufersal",
      confidence: "low",
      why: "guess",
    };
    expect(guarded(lowAnswer)).toBe(UNKNOWN);

    const medAnswer: Answer = {
      key: "food-groceries",
      brand: "Shufersal",
      confidence: "medium",
      why: "recognized",
    };
    expect(guarded(medAnswer)).toBe("food-groceries");

    const highAnswer: Answer = {
      key: "food-groceries",
      brand: "Shufersal",
      confidence: "high",
      why: "exact",
    };
    expect(guarded(highAnswer)).toBe("food-groceries");
  });

  it("guarded keeps a high-confidence answer with an empty brand (generic strings regression)", () => {
    const genericAnswer: Answer = {
      key: "financial-bank-fees",
      brand: "",
      confidence: "high",
      why: "generic fee",
    };
    expect(guarded(genericAnswer)).toBe("financial-bank-fees");
  });

  it("ResponseSchema parses responses with missing why, brand, or confidence with defaults", () => {
    const input = {
      results: [
        {
          i: 0,
          key: "food-groceries",
        },
      ],
    };

    const parsed = ResponseSchema.parse(input);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toEqual({
      i: 0,
      key: "food-groceries",
      brand: "",
      confidence: "low",
      why: "",
    });
  });

  it("an off-list key is rejected by guarded (returns UNKNOWN)", () => {
    const invalidAnswer: Answer = {
      key: "non-existent-category-key",
      brand: "Fake Brand",
      confidence: "high",
      why: "hallucinated",
    };
    expect(guarded(invalidAnswer)).toBe(UNKNOWN);
  });

  it("SYSTEM_PROMPT contains every leaf key from DEFAULT_CATEGORIES and no user category names", () => {
    const leaves = leafCatalog();
    for (const leaf of leaves) {
      expect(SYSTEM_PROMPT).toContain(leaf.key);
    }
    // Verify SYSTEM_PROMPT contains no raw group top-level names without their keys
    for (const group of DEFAULT_CATEGORIES) {
      // Prompt should list keys, e.g. "food-groceries"
      for (const child of group.children) {
        expect(SYSTEM_PROMPT).toContain(child.key);
      }
    }
  });
});
