import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("demo FX provenance", () => {
  it("does not label deterministic demo rates as Bank of Israel observations", async () => {
    const source = await readFile(join(process.cwd(), "scripts/seed-demo.ts"), "utf8");

    expect(source).toContain('const DEMO_FX_SOURCE = "demo-fixed"');
    expect(source).not.toContain('const FX_SOURCE = "boi"');
  });
});
