import { expect, test, type Locator, type Page } from "@playwright/test";
import { routeUiHarness } from "./fixtures/ui-route";

const ORIGIN = "http://tinycloud-ui.test";

interface HarnessWindow {
  __tc: {
    mount(ui?: unknown): boolean;
    toast(kind: string): string;
    showReceipt(): Promise<boolean>;
  };
  __copied: string[];
  tc?: { ui: { open(): void; openPage(): void; close(): void } };
}

const panel = (page: Page) => page.locator("#tinycloud-ui-panel");

async function mountHarness(page: Page, scheme: "light" | "dark", viewport: { width: number; height: number }) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize(viewport);
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
}

// open() returns before the lazy panel mounts; wait for its nav so the toast region exists.
async function openPanel(page: Page, layout: "drawer" | "page") {
  await page.evaluate((target) => {
    const ui = (window as unknown as HarnessWindow).tc?.ui;
    if (target === "page") ui?.openPage();
    else ui?.open();
  }, layout);
  await expect(panel(page).locator(".nav-i").first()).toBeAttached();
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox();
  if (!found) throw new Error("element has no box");
  return found;
}

// The entry animation moves the toast; measure once it has stopped.
async function settled(locator: Locator): Promise<void> {
  await locator.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)).then(() => undefined));
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const VIEWPORTS = [
  { name: "desktop sidebar", viewport: { width: 1280, height: 800 }, layout: "drawer" },
  { name: "desktop page", viewport: { width: 1280, height: 800 }, layout: "page" },
  { name: "phone 390", viewport: { width: 390, height: 844 }, layout: "drawer" },
  { name: "phone 360", viewport: { width: 360, height: 740 }, layout: "drawer" },
] as const;

for (const scheme of ["light", "dark"] as const) {
  for (const { name, viewport, layout } of VIEWPORTS) {
    test.describe(`${scheme} ${name}`, () => {
      test("a toast is drawn once, above the panel, with a 44px labelled Dismiss", async ({ page }) => {
        await mountHarness(page, scheme, viewport);
        await openPanel(page, layout);
        await page.evaluate(() => (window as unknown as HarnessWindow).__tc.toast("success"));

        await expect(page.locator(".toast")).toHaveCount(1);
        await expect(page.locator(".toasts")).toHaveCount(0);
        const toast = page.locator(".toast--success");
        await expect(toast).toBeVisible();

        await settled(toast);
        const dismiss = toast.getByRole("button", { name: "Dismiss", exact: true });
        const dismissBox = await box(dismiss);
        expect(dismissBox.width).toBeGreaterThanOrEqual(44);
        expect(dismissBox.height).toBeGreaterThanOrEqual(44);

        // The dismiss button is the hit-test target at its centre, so the panel does not paint over it.
        const hit = await dismiss.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const root = el.getRootNode() as ShadowRoot;
          return el.contains(root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        });
        expect(hit).toBe(true);

        const toastBox = await box(toast);
        expect(toastBox.x).toBeGreaterThanOrEqual(0);
        expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(viewport.width);
        expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(viewport.height);

        await dismiss.click();
        await expect(page.locator(".toast")).toHaveCount(0);
      });

      test("a receipt slip lists its rows, copies them, and never covers Close or Sections", async ({ page }) => {
        await mountHarness(page, scheme, viewport);
        await page.evaluate(() => {
          const w = window as unknown as HarnessWindow;
          w.__copied = [];
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text: string) => {
                w.__copied.push(text);
              },
            },
          });
        });
        await openPanel(page, layout);
        expect(await page.evaluate(() => (window as unknown as HarnessWindow).__tc.showReceipt())).toBe(true);

        const slip = page.locator(".slip");
        await expect(slip).toBeVisible();
        await expect(slip.locator("div")).toHaveText(["Close rcpt_EXAMPLE_a1b2", "Back to bafkreiEXAMPLE"]);

        await settled(page.locator(".toast").first());
        const copy = page.getByRole("button", { name: "Copy receipt", exact: true });
        expect((await box(copy)).height).toBeGreaterThanOrEqual(44);

        const toastBox = await box(page.locator(".toast").first());
        expect(toastBox.x).toBeGreaterThanOrEqual(0);
        expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(viewport.width);
        expect(toastBox.y).toBeGreaterThanOrEqual(0);
        expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(viewport.height);

        const close = panel(page).locator(".head-actions > button").last();
        expect(overlaps(toastBox, await box(close)), "toast covers Close").toBe(false);
        if (viewport.width <= 600) {
          const sections = panel(page).getByRole("button", { name: "Sections", exact: true });
          expect(overlaps(toastBox, await box(sections)), "toast covers Sections").toBe(false);
        }

        await copy.click();
        await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).__copied)).toEqual([
          "Close rcpt_EXAMPLE_a1b2\nBack to bafkreiEXAMPLE",
        ]);
        await expect(page.locator(".toast", { hasText: "Copied" })).toBeVisible();
      });
    });
  }
}
