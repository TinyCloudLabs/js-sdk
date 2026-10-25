import { expect, test, type Page } from "@playwright/test";
import { routeUiHarness } from "./fixtures/ui-route";
import { mockupRows } from "./fixtures/delegations-seed";
import type { StubSeed } from "../src/ui/stub/index";

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
  __tc: { mount(ui?: Record<string, unknown>): boolean; setManifestName(name: string | undefined): boolean; setSignedIn(value: boolean): boolean };
  tc?: { ui: { open(section?: string): void; openPage(section?: string): void } };
}

const NAME_40 = "Quarterly Planning Notebook For Team Pro";
const panel = (page: Page) => page.locator("#tinycloud-ui-panel");

async function open(page: Page, viewport: { width: number; height: number }, layout: "drawer" | "page", name: string | undefined, signedIn = true, seed?: StubSeed) {
  await page.setViewportSize(viewport);
  if (seed) await page.addInitScript((data) => Reflect.set(window, "__TC_STUB_SEED__", data), seed);
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate((n) => (window as unknown as HarnessWindow).__tc.setManifestName(n), name);
  await page.evaluate((value) => (window as unknown as HarnessWindow).__tc.setSignedIn(value), signedIn);
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

const NAMES = [
  "TC-848 Delta Quality Assurance Display Name 2026",
  "A".repeat(60),
  "Twenty Letter App ID",
];
const LAYOUTS = [
  { label: "drawer 1280", viewport: { width: 1280, height: 800 }, layout: "drawer" as const },
  { label: "drawer 1440", viewport: { width: 1440, height: 900 }, layout: "drawer" as const },
  { label: "page 601", viewport: { width: 601, height: 800 }, layout: "page" as const },
  { label: "page 640", viewport: { width: 640, height: 800 }, layout: "page" as const },
  { label: "page 700", viewport: { width: 700, height: 800 }, layout: "page" as const },
  { label: "page 768", viewport: { width: 768, height: 800 }, layout: "page" as const },
  { label: "page 1024", viewport: { width: 1024, height: 800 }, layout: "page" as const },
  { label: "page 1280", viewport: { width: 1280, height: 800 }, layout: "page" as const },
  { label: "phone 360", viewport: { width: 360, height: 740 }, layout: "page" as const },
];

for (const c of LAYOUTS) {
  for (const signedIn of [true, false]) {
    for (const name of NAMES) {
      test(`${c.label}, ${signedIn ? "signed in" : "signed out"}: ${name} stays within the panel`, async ({ page }) => {
        await open(page, c.viewport, c.layout, name, signedIn);
        const bounds = await panel(page).evaluate((el) => {
          const panelBox = el.getBoundingClientRect();
          const title = (el.querySelector(".title") as HTMLElement).getBoundingClientRect();
          const head = (el.querySelector(".head") as HTMLElement).getBoundingClientRect();
          const titleElement = el.querySelector(".title") as HTMLElement;
          const headerElement = el.querySelector(".head") as HTMLElement;
          const ctx = el.querySelector(".ctx") as HTMLElement;
          const style = getComputedStyle(ctx);
          const controls = [...el.querySelectorAll<HTMLElement>(".head-actions > button")]
            .filter((button) => getComputedStyle(button).display !== "none")
            .map((button) => {
              const rect = button.getBoundingClientRect();
              return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
            });
          return {
            width: el.clientWidth,
            scrollWidth: el.scrollWidth,
            headWidth: headerElement.clientWidth,
            headScrollWidth: headerElement.scrollWidth,
            titleWidth: titleElement.clientWidth,
            titleScrollWidth: titleElement.scrollWidth,
            titleLeft: title.left,
            titleRight: title.right,
            panelLeft: panelBox.left,
            panelRight: panelBox.right,
            headTop: head.top,
            headBottom: head.bottom,
            titleBottom: title.bottom,
            contextHeight: ctx.getBoundingClientRect().height,
            lineHeight: parseFloat(style.lineHeight),
            whiteSpace: style.whiteSpace,
            textOverflow: style.textOverflow,
            controls,
          };
        });
        expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width);
        expect(bounds.headScrollWidth).toBeLessThanOrEqual(bounds.headWidth);
        expect(bounds.titleScrollWidth).toBeLessThanOrEqual(bounds.titleWidth);
        expect(bounds.titleLeft).toBeGreaterThanOrEqual(bounds.panelLeft);
        expect(bounds.titleRight).toBeLessThanOrEqual(bounds.panelRight);
        expect(bounds.whiteSpace).toBe("nowrap");
        expect(bounds.textOverflow).toBe("ellipsis");
        expect(bounds.contextHeight).toBeLessThanOrEqual(bounds.lineHeight + 1);
        expect(bounds.controls).toHaveLength(c.viewport.width > 600 ? 2 : 1);
        if (c.layout === "page" && c.viewport.width > 600) {
          await expect(panel(page).locator(".head-actions > button").last()).toHaveAttribute("aria-label", `Back to ${name}`);
        }
        for (const button of bounds.controls) {
          expect(button.left).toBeGreaterThanOrEqual(bounds.panelLeft);
          expect(button.right).toBeLessThanOrEqual(bounds.panelRight);
          expect(button.top).toBeGreaterThanOrEqual(bounds.headTop);
          expect(button.top).toBeLessThan(bounds.titleBottom);
          expect(button.bottom).toBeLessThanOrEqual(bounds.headBottom + 1);
        }
      });
    }
  }
}

for (const section of ["delegations", "storage"] as const) {
  test(`drawer ${section} and its controls fit with a long app name`, async ({ page }) => {
    await open(page, { width: 1280, height: 800 }, "drawer", NAMES[0]);
    await page.evaluate((id) => (window as unknown as HarnessWindow).tc?.ui.open(id), section);
    await expect(panel(page).locator(".sec-title")).toHaveText(section === "storage" ? "Storage" : "Delegations");
    expect(await panel(page).evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(await panel(page).evaluate((el) => el.clientWidth));
    if (section === "delegations") {
      await panel(page).getByRole("button", { name: "Revoke access for Stub grant" }).click();
      await expect(panel(page).locator('[role="alertdialog"]')).toBeVisible();
      expect(await panel(page).evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(await panel(page).evaluate((el) => el.clientWidth));
    }
  });
}

/** Visible section content must not paint to the right of the panel, including inside scrollable cards. */
async function expectContentFits(page: Page, section: string): Promise<void> {
  const overflow = await panel(page).evaluate((el, id) => {
    const right = el.getBoundingClientRect().right;
    const main = el.querySelector<HTMLElement>(".main");
    const sectionEl = el.querySelector<HTMLElement>(`section[data-section="${id}"]`);
    if (!main || !sectionEl) return { missing: id };
    const overwide = [el, main, ...sectionEl.querySelectorAll<HTMLElement>("*")]
      .filter((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().right > right + 1)
      .map((node) => ({ tag: node.tagName, className: node.className, right: node.getBoundingClientRect().right }));
    const scrolling = [el, main, ...sectionEl.querySelectorAll<HTMLElement>(".dl-card,.confirm,.drawer")]
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => ({ tag: node.tagName, className: node.className, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
    return { overwide, scrolling };
  }, section);
  expect(overflow).toEqual({ overwide: [], scrolling: [] });
}

const HOSTILE_CID = `bafy${"z".repeat(120)}`;
const HOSTILE_DID = `did:key:z${"A".repeat(120)}`;
const HOSTILE_RESOURCE = `tinycloud:pkh:eip155:1:0x088eeB2074778d16B281f57${"a".repeat(60)}:applications/tc848-qa-early//notes/${"x".repeat(60)}`;
const hostileSeed: StubSeed = {
  delegations: {
    rows: mockupRows().map((row, index) => index === 0
      ? { ...row, cid: HOSTILE_CID, delegateDid: HOSTILE_DID, label: { text: "A".repeat(60), source: "stub" },
          resources: [{ resource: HOSTILE_RESOURCE, actions: Array.from({ length: 13 }, (_, n) => `tinycloud.capabilities/action${n}`) }] }
      : row),
  },
  nodes: { state: "ready", data: [{
    source: "stub", origin: `https://${"node".repeat(35)}.invalid`, kind: "hosted",
    active: true, nodeDid: HOSTILE_DID, status: "ok", spaces: [HOSTILE_RESOURCE],
  }] },
  storage: { state: "ready", data: {
    source: "stub", usedBytes: 2048, limitBytes: 4096, state: "ok",
    perSpace: [{ source: "stub", space: HOSTILE_DID, usage: { usedBytes: 2048, limitBytes: null } }],
  } },
  localNode: { source: "stub", connection: "found", url: `https://${"local".repeat(35)}.invalid`,
    identity: { origin: `https://${"local".repeat(35)}.invalid`, nodeDid: HOSTILE_DID } },
};

for (const c of [
  { label: "drawer 1280", viewport: { width: 1280, height: 800 }, layout: "drawer" as const },
  { label: "drawer 1440", viewport: { width: 1440, height: 900 }, layout: "drawer" as const },
  { label: "page 601", viewport: { width: 601, height: 800 }, layout: "page" as const },
  { label: "page 768", viewport: { width: 768, height: 800 }, layout: "page" as const },
  { label: "page 1280", viewport: { width: 1280, height: 800 }, layout: "page" as const },
]) {
  test(`${c.label}: hostile delegation strings, chips, confirmation and details remain readable`, async ({ page }) => {
    await open(page, c.viewport, c.layout, NAMES[1], true, hostileSeed);
    await page.evaluate((layout) => {
      const ui = (window as unknown as HarnessWindow).tc?.ui;
      if (layout === "page") ui?.openPage("delegations");
      else ui?.open("delegations");
    }, c.layout);
    const section = panel(page).locator('section[data-section="delegations"]');
    const first = section.locator(".dl-card").first();
    await expect(first.locator(".dl-chip")).toHaveCount(13);
    await expect(first).toBeVisible();
    await expectContentFits(page, "delegations");
    await first.getByRole("button", { name: /^Revoke access/ }).click();
    const confirm = section.locator('[role="alertdialog"]');
    await expect(confirm).toBeVisible();
    await expectContentFits(page, "delegations");
    const boxes = await confirm.evaluate((el) => {
      const panelRight = el.closest(".panel")!.getBoundingClientRect().right;
      return [...el.querySelectorAll<HTMLElement>('[id$="-b"],button')].map((node) => ({
        text: node.textContent,
        right: node.getBoundingClientRect().right,
        panelRight,
      }));
    });
    expect(boxes.some((box) => box.text?.includes("will stop being able to"))).toBe(true);
    expect(boxes.some((box) => box.text === "Keep access")).toBe(true);
    expect(boxes.some((box) => box.text === "Revoke access")).toBe(true);
    for (const box of boxes) expect(box.right).toBeLessThanOrEqual(box.panelRight);
    await confirm.getByRole("button", { name: "Keep access" }).click();
    await first.getByRole("button", { name: /^See details/ }).click();
    await expect(section.locator(".drawer").first()).toBeVisible();
    await expectContentFits(page, "delegations");
  });
}

for (const signedIn of [true, false]) {
  test(`drawer sections keep their content inside the panel when ${signedIn ? "signed in" : "signed out"}`, async ({ page }) => {
    await open(page, { width: 1280, height: 800 }, "drawer", NAMES[1], signedIn, hostileSeed);
    const sections = signedIn
      ? ["account", "nodes", "storage", "local-tinycloud", "local-copy", "activity"]
      : ["account", "nodes", "local-tinycloud", "local-copy", "activity"];
    for (const id of sections) {
      await page.evaluate((section) => (window as unknown as HarnessWindow).tc?.ui.open(section), id);
      await expect(panel(page).locator(`section[data-section="${id}"]`)).toBeVisible();
      await expectContentFits(page, id);
    }
  });
}
