import { test as setup, expect } from "@playwright/test";
import { STORAGE_STATE, DEMO_USER } from "./fixtures";

// Runs once before the authed smoke spec (declared as its project dependency
// in playwright.config.ts) and saves the signed-in browser state to disk.
//
// There is no cookie shortcut: login unwraps a per-user data key that lives
// only in the server's RAM session store (src/lib/auth/session-store.ts), so
// the browser has to go through the real login form to get a usable session.
// That session cookie is `Secure`, which browsers honour over http://localhost
// (a "potentially trustworthy" origin) — so no HTTPS terminator is needed for
// the suite to hold a session.
setup("authenticate", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#email", DEMO_USER.email);
  await page.fill("#password", DEMO_USER.password);
  await page.getByRole("button", { name: /unlock moni/i }).click();

  // Landing on the dashboard is the proof the key was unwrapped and the
  // session cookie round-trips; the Log out control confirms the authed shell.
  await page.waitForURL("**/dashboard");
  await expect(page.getByRole("button", { name: /log out/i }).first()).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
