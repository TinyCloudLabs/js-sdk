import { expect, test } from "@playwright/test";
import { routeUiHarness } from "./fixtures/ui-route";

const ORIGIN = "http://tinycloud-ui.test";

interface HarnessWindow {
  __tc: { mount(ui?: unknown): boolean };
  tc?: { ui: { open(): void } };
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: confirmBox exposes its question as the accessible description in a real browser`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await routeUiHarness(page);
    await page.goto(`${ORIGIN}/`);
    await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
    await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open());
    const panel = page.locator("#tinycloud-ui-panel");
    await panel.getByRole("button", { name: "Sign out", exact: true }).click();

    // The same box backs the Sign-out, Revoke and Wipe confirms.
    const dialog = page.getByRole("alertdialog", { description: "Sign out of TinyCloud on this device?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Stay signed in", exact: true })).toBeFocused();
  });
}
