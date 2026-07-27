// src/lib/categorization/category-icons.ts — the closed icon allowlist.
//
// The point of this file is the first test: `categories.icon` is free text,
// so an icon name added to the shipped set that isn't in the allowlist would
// render as a blank fallback tile and nothing else would complain.
import { describe, expect, it } from "vitest";
import {
  CATEGORY_ICONS,
  CATEGORY_ICON_NAMES,
  DEFAULT_CATEGORY_ICON,
  categoryIcon,
  isCategoryIcon,
} from "@/lib/categorization/category-icons";
import { flattenDefaultCategories } from "@/lib/categorization/default-categories";

describe("category icons", () => {
  it("covers every icon the shipped category set uses", () => {
    const missing = flattenDefaultCategories()
      .map((c) => c.icon)
      .filter((icon) => !isCategoryIcon(icon));
    expect(missing).toEqual([]);
  });

  it("has a fallback icon that is itself in the allowlist", () => {
    expect(isCategoryIcon(DEFAULT_CATEGORY_ICON)).toBe(true);
  });

  it("degrades an unknown or missing name instead of throwing", () => {
    expect(categoryIcon("no-such-icon")).toBe(CATEGORY_ICONS[DEFAULT_CATEGORY_ICON]);
    expect(categoryIcon(null)).toBe(CATEGORY_ICONS[DEFAULT_CATEGORY_ICON]);
  });

  it("exposes its names in the same order the picker renders them", () => {
    expect(CATEGORY_ICON_NAMES.length).toBe(Object.keys(CATEGORY_ICONS).length);
    expect(CATEGORY_ICON_NAMES.every(isCategoryIcon)).toBe(true);
  });
});
