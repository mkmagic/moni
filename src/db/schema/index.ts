// Drizzle table definitions (T2 — Drizzle schema), organized by domain area
// per docs/design/data-model.md §5. Re-exported here so
// `src/db/client.ts` can `import * as schema from "@/db/schema"`.
export * from "./identity";
export * from "./connectors";
export * from "./accounts";
export * from "./ledger";
export * from "./classification";
export * from "./dashboard";
export * from "./budget";
export * from "./reference";
export * from "./investments";
export * from "./long-term-savings";
export * from "./household";
