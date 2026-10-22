import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Built by `bun run build:e2e-ui`; the test scripts run from the package root.
const BUNDLE = readFileSync(resolve("e2e/.build/ui.bundle.js"), "utf8");
const ORIGIN = "http://tinycloud-ui.test";

interface HarnessWindow {
  __tc: { mount(ui?: Record<string, unknown>): boolean };
  tc?: {
    ui: {
      open(section?: string): void;
      openPage(section?: string): void;
    };
  };
}

async function mountHarness(page: Page, scheme: "light" | "dark", ui?: Record<string, unknown>) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/ui.bundle.js") {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: BUNDLE });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><html><body><script src="/ui.bundle.js"></script></body></html>',
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate((option) => (window as unknown as HarnessWindow).__tc.mount(option), ui);
}

const launcher = (page: Page) => page.getByRole("button", { name: "TinyCloud settings", exact: true });
const panel = (page: Page) => page.locator("#tinycloud-ui-panel");

async function openDrawer(page: Page, section?: string) {
  await page.evaluate((s) => (window as unknown as HarnessWindow).tc?.ui.open(s), section);
}

async function openPageLayout(page: Page, section?: string) {
  await page.evaluate((s) => (window as unknown as HarnessWindow).tc?.ui.openPage(s), section);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme}`, () => {
    test("open() shows a non-modal drawer with the signed-in nav and Overview active", async ({ page }) => {
      await mountHarness(page, scheme);
      await openDrawer(page);

      const dialog = panel(page);
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("role", "dialog");
      await expect(dialog).toHaveAttribute("aria-modal", "false");
      await expect(dialog).toHaveAttribute("aria-label", "TinyCloud settings");
      await expect(dialog).toHaveAttribute("data-layout", "drawer");

      // The harness is signed in and developer mode is off, so Activity is not offered.
      await expect(dialog.locator(".nav-l")).toHaveText(["Overview", "Local TinyCloud", "Local copy", "Delegations", "Nodes", "Storage"]);
      await expect(dialog.getByRole("button", { name: "Activity", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(dialog.locator('section[data-section="account"]')).toBeVisible();
    });

    test("nav switches the visible section and moves aria-current", async ({ page }) => {
      await mountHarness(page, scheme);
      await openDrawer(page);

      const dialog = panel(page);
      await dialog.getByRole("button", { name: "Nodes", exact: true }).click();

      await expect(dialog.getByRole("button", { name: "Nodes", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(dialog.getByRole("button", { name: "Overview", exact: true })).not.toHaveAttribute("aria-current", "page");
      await expect(dialog.locator('section[data-section="nodes"]')).toBeVisible();
      await expect(dialog.locator('section[data-section="account"]')).toBeHidden();
    });

    test("open(section) selects the named section", async ({ page }) => {
      await mountHarness(page, scheme);
      await openDrawer(page, "storage");

      await expect(panel(page).locator('section[data-section="storage"]')).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "Storage", exact: true })).toHaveAttribute("aria-current", "page");
    });

    test("Escape on the panel closes it and returns focus to the launcher", async ({ page }) => {
      await mountHarness(page, scheme);
      await openDrawer(page);

      const dialog = panel(page);
      await dialog.getByRole("button", { name: "Overview", exact: true }).focus();
      await page.keyboard.press("Escape");

      await expect(dialog).toBeHidden();
      await expect(launcher(page)).toBeFocused();
    });

    test("Escape outside the panel does not close it", async ({ page }) => {
      await mountHarness(page, scheme);
      await openDrawer(page);

      // The launcher sits outside the panel element, so its keydown must not
      // reach the panel's Escape handler.
      await launcher(page).focus();
      await page.keyboard.press("Escape");

      await expect(panel(page)).toBeVisible();
    });

    test("page layout toggles to the sidebar and back", async ({ page }) => {
      await mountHarness(page, scheme);
      await openPageLayout(page);

      const dialog = panel(page);
      await expect(dialog).toHaveAttribute("data-layout", "page");

      await dialog.getByRole("button", { name: "Show as sidebar", exact: true }).click();
      await expect(dialog).toHaveAttribute("data-layout", "drawer");

      await dialog.getByRole("button", { name: "Open full page", exact: true }).click();
      await expect(dialog).toHaveAttribute("data-layout", "page");
    });

    test("ui.mode sidebar keeps the drawer and hides the page control", async ({ page }) => {
      await mountHarness(page, scheme, { mode: "sidebar" });
      await openPageLayout(page);

      const dialog = panel(page);
      await expect(dialog).toHaveAttribute("data-layout", "drawer");
      await expect(dialog.getByRole("button", { name: "Open full page", exact: true })).toHaveCount(0);
    });

    test("ui.mode page opens the full-page layout without a sidebar control", async ({ page }) => {
      await mountHarness(page, scheme, { mode: "page" });
      await openDrawer(page);

      const dialog = panel(page);
      await expect(dialog).toHaveAttribute("data-layout", "page");
      await expect(dialog.getByRole("button", { name: "Show as sidebar", exact: true })).toHaveCount(0);
    });
  });
}
