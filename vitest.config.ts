import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // T2–T7 land the actual DB test suite; an empty tests/db/ shouldn't fail
    // this scaffolding task's `npm test` run.
    passWithNoTests: true,
  },
});
