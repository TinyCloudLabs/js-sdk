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
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Stay signed in", exact: true })).toBeFocused();

    // Read the description from Chromium's own accessibility tree, not from the DOM attributes.
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const box = nodes.find((node) => node.role?.value === "alertdialog" && !node.ignored);
    expect(box, "alertdialog in the accessibility tree").toBeDefined();
    expect(box?.description?.value).toBe("Sign out of TinyCloud on this device?");
  });
}
