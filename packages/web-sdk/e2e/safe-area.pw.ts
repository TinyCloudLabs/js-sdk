import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { routeUiHarness } from "./fixtures/ui-route";

// TC-2130: on a phone the panel keeps its header out from under the status bar and notch, and the
// close control stays reachable. Chromium cannot give env(safe-area-inset-*) a value through
// page.emulateMedia, so the insets come from the DevTools command Emulation.setSafeAreaInsetsOverride.
// Set TC2130_SHOTS=<dir> to also write screenshots there.

const ORIGIN = "http://tinycloud-ui.test";
const SHOTS = process.env.TC2130_SHOTS;

interface Insets { top: number; right: number; bottom: number; left: number }
const CASES = [
  { name: "portrait-390x844", viewport: { width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } },
  { name: "landscape-844x390", viewport: { width: 844, height: 390 }, insets: { top: 0, right: 47, bottom: 21, left: 47 } },
];

interface HarnessWindow {
  __tc: { mount(ui?: Record<string, unknown>): boolean; setSignedIn(value: boolean): boolean };
  tc?: { ui: { open(section?: string): void } };
}

test.use({ hasTouch: true, isMobile: true });

const panel = (page: Page) => page.locator("#tinycloud-ui-panel");

async function openPhone(page: Page, viewport: { width: number; height: number }, insets: Insets): Promise<CDPSession> {
  await page.setViewportSize(viewport);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  // viewport-fit=cover is what lets a real iPhone report non-zero insets.
  await page.evaluate(() => {
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1, viewport-fit=cover";
    document.head.append(meta);
  });
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.setSignedIn(true));
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open());
  await expect(panel(page).locator(".menu-btn")).toBeVisible();
  await panel(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
  return cdp;
}

async function swipe(cdp: CDPSession, x: number, y: number, dy: number): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 6; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * step) / 6 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

for (const c of CASES) {
  test(`${c.name}: the header and the close control sit inside the safe area`, async ({ page }) => {
    await openPhone(page, c.viewport, c.insets);
    if (SHOTS) {
      // Red bands mark the emulated insets (status bar / notch / home indicator / landscape sides).
      await page.evaluate((i) => {
        const bands = document.createElement("div");
        bands.style.cssText = `position:fixed;inset:0;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:solid rgba(255,0,0,.4);border-width:${i.top}px ${i.right}px ${i.bottom}px ${i.left}px`;
        document.body.append(bands);
      }, c.insets);
      await page.screenshot({ path: `${SHOTS}/${c.name}.png` });
    }
    const box = await panel(page).evaluate((el) => {
      const rect = (selector: string) => {
        const r = (el.querySelector(selector) as HTMLElement).getBoundingClientRect();
        return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
      };
      return { head: rect(".head"), brand: rect(".brand"), close: rect('.head-actions > button[aria-label]:last-child'), position: getComputedStyle(el.querySelector(".head") as HTMLElement).position };
    });
    expect(box.head.top).toBeGreaterThanOrEqual(c.insets.top);
    expect(box.close.top).toBeGreaterThanOrEqual(c.insets.top);
    expect(box.brand.left).toBeGreaterThanOrEqual(c.insets.left);
    expect(box.close.right).toBeLessThanOrEqual(c.viewport.width - c.insets.right);
    expect(box.close.width).toBeGreaterThanOrEqual(44);
    expect(box.close.height).toBeGreaterThanOrEqual(44);
    expect(box.position).toBe("sticky");
    // The close control answers a tap there.
    await page.touchscreen.tap(box.close.left + box.close.width / 2, box.close.top + box.close.height / 2);
    await expect(panel(page)).toBeHidden();
  });
}

test("a 60px swipe down on the header closes the panel; a 30px one does not", async ({ page }) => {
  const c = CASES[0]!;
  const cdp = await openPhone(page, c.viewport, c.insets);
  const y = c.insets.top + 34;
  await swipe(cdp, 150, y, 30);
  await expect(panel(page)).toBeVisible();
  await swipe(cdp, 150, y, 80);
  await expect(panel(page)).toBeHidden();
});

test("Escape closes the panel", async ({ page }) => {
  const c = CASES[0]!;
  await openPhone(page, c.viewport, c.insets);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
});

test("with no insets the header sits at the top edge", async ({ page }) => {
  await openPhone(page, { width: 390, height: 844 }, { top: 0, right: 0, bottom: 0, left: 0 });
  const top = await panel(page).evaluate((el) => (el.querySelector(".head") as HTMLElement).getBoundingClientRect().top);
  expect(top).toBe(0);
});
