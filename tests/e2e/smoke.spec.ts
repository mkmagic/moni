import { test, expect } from "@playwright/test";
import { STORAGE_STATE, AUTHED_ROUTES } from "./fixtures";

// Reuse the session the setup project unlocked, so these run as a signed-in
// user without repeating the login per test.
test.use({ storageState: STORAGE_STATE });

for (const route of AUTHED_ROUTES) {
  test(`${route} renders the app shell without a server error`, async ({ page }) => {
    const response = await page.goto(route);

    // A 5xx, or a bounce back to /login, is exactly the regression this suite
    // exists to catch when an agent's change breaks a page's server render.
    expect(response?.status(), `HTTP status for ${route}`).toBeLessThan(400);
    await expect(page).toHaveURL(new RegExp(`${route}(?:[/?]|$)`));

    // The signed-in chrome mounted. The sidebar's Log out control is on every
    // authed page, so it's the one landmark proving we rendered the real shell
    // rather than an error boundary or the login page. `.first()` picks the
    // always-visible desktop rail over its (hidden) mobile-drawer twin.
    await expect(page.getByRole("button", { name: /log out/i }).first()).toBeVisible();
  });
}
