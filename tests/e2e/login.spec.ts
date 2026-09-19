import { test, expect } from "@playwright/test";
import { DEMO_USER } from "./fixtures";

// The login flow, exercised from a genuinely signed-out browser. An explicit
// empty storage state overrides whatever the setup project saved, so these
// never inherit a session.
test.use({ storageState: { cookies: [], origins: [] } });

test("login page renders its form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.getByRole("button", { name: /unlock moni/i })).toBeVisible();
});

test("a signed-out visit to a protected page redirects to login", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});

test("wrong credentials are rejected without leaving the login page", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#email", DEMO_USER.email);
  await page.fill("#password", "not-the-password");
  await page.getByRole("button", { name: /unlock moni/i }).click();
  await expect(page.getByText(/invalid credentials/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("correct credentials unlock the dashboard", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#email", DEMO_USER.email);
  await page.fill("#password", DEMO_USER.password);
  await page.getByRole("button", { name: /unlock moni/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});
