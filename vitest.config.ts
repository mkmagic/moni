import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" path mapping. Needed so
    // tests/db/**/*.test.ts can import src modules (e.g. "@/db/client") the
    // same way the app does — vitest doesn't read tsconfig `paths` itself.
    alias: {
      "@": path.join(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // T2–T7 land the actual DB test suite; an empty tests/db/ shouldn't fail
    // this scaffolding task's `npm test` run.
    passWithNoTests: true,
  },
});
