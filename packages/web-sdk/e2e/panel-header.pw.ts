import { expect, test, type Page } from "@playwright/test";
import { routeUiHarness } from "./fixtures/ui-route";

const ORIGIN = "http://tinycloud-ui.test";

// Every test fails on an uncaught page error or a console error (errors=0).
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

interface HarnessWindow {
  __tc: { mount(ui?: Record<string, unknown>): boolean; setManifestName(name: string | undefined): boolean };
  tc?: { ui: { open(section?: string): void; openPage(section?: string): void } };
}

const NAME_40 = "Quarterly Planning Notebook For Team Pro";
const panel = (page: Page) => page.locator("#tinycloud-ui-panel");

async function open(page: Page, viewport: { width: number; height: number }, layout: "drawer" | "page", name: string | undefined) {
  await page.setViewportSize(viewport);
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate((n) => (window as unknown as HarnessWindow).__tc.setManifestName(n), name);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
  await page.evaluate((l) => {
    const ui = (window as unknown as HarnessWindow).tc?.ui;
    if (l === "page") ui?.openPage();
    else ui?.open();
  }, layout);
  await expect(panel(page).locator(".nav-i").first()).toBeAttached();
  // Measure once the slide-in has finished: a transform in flight skews every box.
  await panel(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
}

interface Geometry {
  readonly head: { top: number; bottom: number; height: number };
  readonly brand: { left: number; right: number; top: number; bottom: number };
  readonly ctx: { right: number; clipped: boolean; text: string };
  readonly actions: { left: number; right: number; top: number; bottom: number };
  readonly headRight: number;
  readonly navTop: number;
}

async function geometry(page: Page): Promise<Geometry> {
  return panel(page).evaluate((el) => {
    const box = (selector: string) => {
      const target = el.querySelector(selector) as HTMLElement;
      const r = target.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, el: target };
    };
    const head = box(".head");
    const brand = box(".brand");
    const ctx = box(".ctx");
    const actions = box(".head-actions");
    const nav = box(".nav");
    return {
      head: { top: head.top, bottom: head.bottom, height: head.height },
      brand: { left: brand.left, right: brand.right, top: brand.top, bottom: brand.bottom },
      ctx: { right: ctx.right, clipped: ctx.el.scrollWidth > ctx.el.clientWidth, text: ctx.el.textContent ?? "" },
      actions: { left: actions.left, right: actions.right, top: actions.top, bottom: actions.bottom },
      headRight: head.right,
      navTop: nav.top,
    };
  });
}

const CASES = [
  { label: "drawer 420", viewport: { width: 1280, height: 800 }, layout: "drawer" as const, clips: false },
  { label: "page", viewport: { width: 1280, height: 800 }, layout: "page" as const, clips: false },
  { label: "phone 360", viewport: { width: 360, height: 740 }, layout: "page" as const, clips: true },
];

for (const c of CASES) {
  test(`${c.label}: a 40-character app name keeps the title, context and actions in one row`, async ({ page }) => {
    expect(NAME_40).toHaveLength(40);
    await open(page, c.viewport, c.layout, undefined);
    const short = await geometry(page);

    await page.reload();
    await open(page, c.viewport, c.layout, NAME_40);
    const long = await geometry(page);

    expect(long.ctx.text).toBe(`in ${NAME_40}`);
    // One row: the header is no taller and the nav below has not moved.
    expect(long.head.height).toBeLessThanOrEqual(short.head.height + 1);
    expect(long.navTop).toBeCloseTo(short.navTop, 0);
    // The actions stay level with the title block and inside the header, to its right.
    expect(long.actions.top).toBeGreaterThanOrEqual(long.head.top);
    expect(long.actions.bottom).toBeLessThanOrEqual(long.head.bottom + 1);
    expect(long.actions.top).toBeLessThan(long.brand.bottom);
    expect(long.actions.left).toBeGreaterThanOrEqual(long.brand.right - 1);
    expect(long.actions.right).toBeLessThanOrEqual(long.headRight + 0.5);
    // The context is what gives way: it never leaves its box, and is ellipsised where the room is short.
    expect(long.ctx.right).toBeLessThanOrEqual(long.brand.right + 0.5);
    if (c.clips) expect(long.ctx.clipped).toBe(true);
  });
}
