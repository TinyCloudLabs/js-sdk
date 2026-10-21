import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Built by `bun run build:e2e-ui`; the test scripts run from the package root.
const BUNDLE = readFileSync(resolve("e2e/.build/ui.bundle.js"), "utf8");
const ORIGIN = "http://tinycloud-ui.test";

// The panel's shadow root is closed in production. Open it so Playwright can
// reach the panel's controls; the rendered output is unchanged.
const OPEN_SHADOW_ROOTS = `(() => {
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    return attach.call(this, { ...init, mode: "open" });
  };
})();`;

interface HarnessWindow {
  __tc: { mount(): boolean };
  tc?: { ui: { open(): void } };
}

// Expected surfaces, matching the panel's background token in each scheme.
const PANEL_BACKGROUND = {
  light: "rgb(255, 255, 255)",
  dark: "rgb(21, 21, 23)",
} as const;

async function mountHarness(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await page.addInitScript(OPEN_SHADOW_ROOTS);
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
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: panel is clickable, Hide hides the launcher, and open() restores it`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountHarness(page, scheme);

    const launcher = page.getByRole("button", { name: "TinyCloud settings", exact: true });
    const panel = page.locator("#tinycloud-ui-panel");

    await launcher.click();
    await expect(panel).toBeVisible();

    // The panel must receive pointer events and paint its own surface. A
    // missing `.panel` class left it with pointer-events:none and no background.
    const computed = await panel.evaluate((el) => {
      const style = getComputedStyle(el);
      return { pointerEvents: style.pointerEvents, background: style.backgroundColor };
    });
    expect(computed.pointerEvents).toBe("auto");
    expect(computed.background).toBe(PANEL_BACKGROUND[scheme]);

    // Playwright's click waits until the target is the hit-test element at the
    // button centre. A click-through panel makes this click time out.
    await page.getByRole("button", { name: "Hide button", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(launcher).toBeHidden();

    await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open());
    await expect(panel).toBeVisible();
    await expect(launcher).toBeVisible();
  });
}
