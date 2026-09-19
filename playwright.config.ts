import { defineConfig, devices } from "@playwright/test";

// End-to-end smoke layer (issue #9). Deliberately small: it proves the app
// boots, the signed-in pages render, and login works — the wiring that
// tests/unit/** and tests/db/** can't see because they never run a browser
// against a real server. It is NOT a broad behavioural suite; assertions about
// the numbers on a page belong in tests/db/**.
//
// Prerequisites the runner does NOT set up for you: a built app (`npm run
// build`) and a migrated + seeded database (`npm run db:migrate`, `npm run
// seed:demo`). The CI job (.github/workflows/ci.yml) does all three before
// invoking this; locally, do the same once and then `npm run test:e2e`.

const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = `http://localhost:${PORT}`;

// Which browser to drive. Unset (local) uses Playwright's bundled Chromium.
// CI sets E2E_BROWSER_CHANNEL=chrome to drive the runner's preinstalled Google
// Chrome instead: Playwright's own browser download hangs on the GitHub
// runner's network (the CDN fetch completes but the install then stalls to the
// job timeout), and a named channel launches an already-installed browser with
// nothing to download. Same Chromium engine either way.
const BROWSER_CHANNEL = process.env.E2E_BROWSER_CHANNEL;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // One seeded database and one RAM session store back the whole run, so a
  // single worker keeps specs from racing each other's session.
  workers: 1,
  // A retry absorbs a cold-start flake in CI without hiding it — a test that
  // only passes on retry still shows as flaky in the report.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    // Applies to every project, so the login-setup project drives the same
    // browser as the specs. Omitted when unset (bundled Chromium).
    ...(BROWSER_CHANNEL ? { channel: BROWSER_CHANNEL } : {}),
  },
  projects: [
    // Logs in once and saves the session for the authed spec to reuse.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      // login.spec.ts overrides this to a signed-out state; smoke.spec.ts
      // opts into the saved session. Set here so the setup artifact is the
      // project's default and an authed spec can't forget to load it.
      testIgnore: /auth\.setup\.ts/,
    },
  ],
  // Serves the already-built app. Reuses a server a developer already has
  // running locally; always starts a fresh one in CI.
  webServer: {
    command: "npm run start",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
