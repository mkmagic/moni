// Shared constants for the e2e smoke suite (tests/e2e/**). Kept in one file so
// the setup project, the guest spec, and the authed spec can't drift on where
// the saved session lives or which user they log in as.

/** Where the setup project writes the signed-in browser state that the authed
 * smoke spec reuses. Gitignored (see .gitignore) — it holds a live session
 * cookie and is regenerated on every run. */
export const STORAGE_STATE = "playwright/.auth/user.json";

/**
 * The seeded demo user the suite signs in as (scripts/seed-demo.ts mints both
 * demo users through the real registration path, so this is a genuine unlock,
 * not a faked session). Overridable by env so the suite can point at a
 * different seed without a code change.
 */
export const DEMO_USER = {
  email: process.env.E2E_USER_EMAIL ?? "yossi@moni.demo",
  password: process.env.E2E_USER_PASSWORD ?? "moni-demo",
};

/**
 * The signed-in destinations a newcomer meets from the sidebar. The smoke
 * suite only asserts each one renders its app shell without a server error or
 * an auth bounce — it makes no claim about the numbers on the page. Asserting
 * the data is the job of tests/db/**, which can do it far more cheaply than a
 * browser.
 */
export const AUTHED_ROUTES = [
  "/dashboard",
  "/transactions",
  "/budget",
  "/accounts",
  "/investments",
  "/long-term-savings",
  "/settings",
] as const;
