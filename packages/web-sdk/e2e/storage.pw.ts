import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { STRINGS } from "../src/ui/strings";

// Built by `bun run build:e2e-storage`; the test scripts run from the package root.
const BUNDLE = readFileSync(resolve("e2e/.build/storage.bundle.js"), "utf8");
const ORIGIN = "http://tinycloud-ui.test";
const STORAGE_MANAGE_URL = "https://account.tinycloud.xyz/storage";
const KNOWN_USED = 1073741824;
const KNOWN_LIMIT = 5368709120;

// The panel's background token in each scheme.
const PANEL_BACKGROUND = {
  light: "rgb(255, 255, 255)",
  dark: "rgb(21, 21, 23)",
} as const;

type Scheme = "light" | "dark";
type StorageConfig =
  | { kind: "known"; manageUrl: string }
  | { kind: "unlimited"; state: "ok" | "full" }
  | { kind: "needs_permission" }
  | { kind: "unavailable" };

interface HarnessWindow {
  __tc: {
    configure(config: StorageConfig): void;
    mount(): boolean;
    setEpisode(on: boolean): void;
  };
  tc?: { ui: { open(): void; close(): void } };
}

const SCHEMES: readonly Scheme[] = ["light", "dark"];
const KNOWN: StorageConfig = { kind: "known", manageUrl: STORAGE_MANAGE_URL };

async function mountHarness(page: Page, scheme: Scheme, config: StorageConfig) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/storage.bundle.js") {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: BUNDLE });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><html><body><script src="/storage.bundle.js"></script></body></html>',
    });
  });
  await page.goto(`${ORIGIN}/`);
  await remount(page, config);
}

// Applies a storage config and mounts the UI with it. A remount replaces the
// previous client, so the panel starts closed again.
async function remount(page: Page, config: StorageConfig) {
  await page.evaluate((next) => {
    const tc = (window as unknown as HarnessWindow).__tc;
    tc.configure(next);
    tc.mount();
  }, config);
}

const launcher = (page: Page) => page.getByRole("button", { name: "TinyCloud settings", exact: true });
const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const section = (page: Page) => panel(page).locator('[data-section="storage"]');

async function openPanel(page: Page) {
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open());
  await expect(panel(page)).toBeVisible();
}

async function closePanel(page: Page) {
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.close());
  await expect(panel(page)).toBeHidden();
}

async function setEpisode(page: Page, on: boolean) {
  await page.evaluate((value) => (window as unknown as HarnessWindow).__tc.setEpisode(value), on);
}

// The section's usage line is the second `busy` paragraph; it renders only after
// the status read resolves, so waiting on it waits for the load.
function usageLine(page: Page): Locator {
  return section(page).locator("p.busy").nth(1);
}

for (const scheme of SCHEMES) {
  test(`${scheme}: a known status shows the meter at its usage`, async ({ page }) => {
    await mountHarness(page, scheme, KNOWN);
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();

    const meter = section(page).locator(".storage-bar");
    await expect(meter).toBeVisible();
    const width = await meter.locator("span").evaluate((el) => (el as HTMLElement).style.width);
    expect(width).toBe(`${Math.round((KNOWN_USED * 100) / KNOWN_LIMIT)}%`);
  });

  test(`${scheme}: unlimited never shows the full state`, async ({ page }) => {
    await mountHarness(page, scheme, { kind: "unlimited", state: "full" });
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();

    await expect(section(page)).not.toContainText(STRINGS["storage.state.full"]);
    await expect(section(page).locator(".storage-bar")).toBeHidden();
    await expect(panel(page).locator(".status")).toBeHidden();
    await expect(launcher(page).locator(".dot")).toBeHidden();
  });

  for (const config of [{ kind: "needs_permission" }, { kind: "unavailable" }] as const) {
    test(`${scheme}: ${config.kind} shows a neutral line with no numbers`, async ({ page }) => {
      await mountHarness(page, scheme, config);
      await openPanel(page);
      await expect(section(page).locator("p.note")).toBeVisible();

      await expect(section(page).locator("p.busy:visible")).toHaveCount(0);
      await expect(section(page).locator(".storage-bar")).toBeHidden();
      expect(await section(page).innerText()).not.toMatch(/\d/);
    });
  }

  test(`${scheme}: a storage-full episode shows a toast that links to the storage page`, async ({ page }) => {
    await mountHarness(page, scheme, KNOWN);
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();

    await setEpisode(page, true);
    const toast = page.locator(".toast--warning");
    await expect(toast.locator(".toast__message")).toHaveText(STRINGS["storage.full"]);
    await expect(toast.locator("a")).toHaveAttribute("href", STORAGE_MANAGE_URL);
  });

  test(`${scheme}: a full episode stays on the launcher and the header after close and reopen`, async ({ page }) => {
    await mountHarness(page, scheme, KNOWN);
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();
    await closePanel(page);

    await setEpisode(page, true);
    await expect(launcher(page).locator('.dot[data-status="storage_full"]')).toBeVisible();

    await openPanel(page);
    await expect(panel(page).locator(".header .status")).toHaveText(STRINGS["status.storage_full"]);
    await expect(section(page).locator("p.busy").nth(0)).toHaveText(STRINGS["storage.state.full"]);
    // A full episode drops the numbers: the usage line and the meter are gone.
    await expect(section(page).locator("p.busy:visible")).toHaveCount(1);
    await expect(section(page).locator(".storage-bar")).toBeHidden();
  });

  test(`${scheme}: Manage storage links to an https manageUrl, else to the constant`, async ({ page }) => {
    await mountHarness(page, scheme, { kind: "known", manageUrl: "https://billing.tinycloud.test/storage" });
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();
    await expect(section(page).locator("a")).toHaveAttribute("href", "https://billing.tinycloud.test/storage");

    await remount(page, { kind: "known", manageUrl: "http://billing.tinycloud.test/storage" });
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();
    await expect(section(page).locator("a")).toHaveAttribute("href", STORAGE_MANAGE_URL);
  });

  test(`${scheme}: status text clears 4.5:1 against the panel`, async ({ page }) => {
    const rows: ContrastRow[] = [];

    await mountHarness(page, scheme, KNOWN);
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();
    const background = await panel(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    rows.push(await textRow("known word", section(page).locator("p.busy").nth(0), background));
    rows.push(await textRow("known usage", usageLine(page), background));

    await remount(page, { kind: "needs_permission" });
    await openPanel(page);
    await expect(section(page).locator("p.note")).toBeVisible();
    rows.push(await textRow("needs_permission note", section(page).locator("p.note"), background));

    await remount(page, KNOWN);
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();
    await setEpisode(page, true);
    await expect(panel(page).locator(".header .status")).toHaveText(STRINGS["status.storage_full"]);
    rows.push(await textRow("header status (full)", panel(page).locator(".header .status"), background));
    rows.push(await textRow("full word", section(page).locator("p.busy").nth(0), background));

    console.log(`contrast text ${scheme}: ${JSON.stringify(rows)}`);
    expect(rows.filter((r) => !r.opaque || r.ratio < 4.5)).toEqual([]);
  });

  test(`${scheme}: meter track and fill clear 3:1 against their neighbours (WCAG 1.4.11)`, async ({ page }) => {
    await mountHarness(page, scheme, KNOWN);
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();
    const background = await panel(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    const track = section(page).locator(".storage-bar");
    const trackColor = await track.evaluate((el) => getComputedStyle(el).backgroundColor);
    const fillColor = await track.locator("span").evaluate((el) => getComputedStyle(el).backgroundColor);
    const rows = [row("meter track vs panel", trackColor, background), row("meter fill vs track", fillColor, trackColor)];
    console.log(`contrast meter ${scheme}: ${JSON.stringify(rows)}`);
    expect(rows.filter((r) => !r.opaque || r.ratio < 3)).toEqual([]);
  });
}

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
} as const;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

for (const scheme of SCHEMES) {
  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    test(`${scheme} ${viewportName}: a full-state toast clears the open panel and Manage storage stays hit-testable`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mountHarness(page, scheme, KNOWN);
      await openPanel(page);
      await expect(usageLine(page)).toBeVisible();

      await setEpisode(page, true);
      const toast = page.locator(".toast--warning");
      await expect(toast).toBeVisible();
      const toastBox = await toast.boundingBox();
      const panelBox = await panel(page).boundingBox();
      if (!toastBox || !panelBox) throw new Error("toast or panel has no layout box");
      expect(overlaps(toastBox, panelBox), `toast ${JSON.stringify(toastBox)} overlaps panel ${JSON.stringify(panelBox)}`).toBe(false);

      const manage = section(page).getByRole("link", { name: STRINGS["storage.manage"], exact: true });
      await expect(manage).toBeVisible();
      const hitsLink = await manage.evaluate((el) => {
        const r = el.getBoundingClientRect();
        // The UI lives in an open shadow root, so ask the root node: document.elementFromPoint would return the host.
        const root = el.getRootNode() as Document | ShadowRoot;
        const hit = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit !== null && (hit === el || el.contains(hit));
      });
      const manageBox = await manage.boundingBox();
      console.log(`storage geometry ${scheme} ${viewportName}: toast=${JSON.stringify(toastBox)} panel=${JSON.stringify(panelBox)} manage=${JSON.stringify(manageBox)} hit=${hitsLink}`);
      expect(hitsLink).toBe(true);
    });
  }
}

for (const scheme of SCHEMES) {
  test(`${scheme}: a full episode names the state once in the open panel`, async ({ page }) => {
    await mountHarness(page, scheme, KNOWN);
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();

    await setEpisode(page, true);
    await expect(panel(page).getByText(STRINGS["status.storage_full"], { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(section(page).getByText(STRINGS["storage.state.full"], { exact: true }).filter({ visible: true })).toHaveCount(0);
  });
}

for (const scheme of SCHEMES) {
  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    test(`${scheme} ${viewportName}: Manage storage is at least 44px tall`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mountHarness(page, scheme, KNOWN);
      await openPanel(page);
      await expect(usageLine(page)).toBeVisible();

      const manage = section(page).getByRole("link", { name: STRINGS["storage.manage"], exact: true });
      await expect(manage).toBeVisible();
      const box = await manage.boundingBox();
      if (!box) throw new Error("Manage storage has no layout box");
      expect(box.height, `Manage storage is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
    });
  }
}

interface ContrastRow {
  label: string;
  ratio: number;
  opaque: boolean;
}

async function textRow(label: string, locator: Locator, background: string): Promise<ContrastRow> {
  const color = await locator.evaluate((el) => getComputedStyle(el).color);
  return row(label, color, background);
}

function row(label: string, foreground: string, background: string): ContrastRow {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  return {
    label,
    ratio: Math.round(contrast(fg.rgb, bg.rgb) * 100) / 100,
    opaque: fg.alpha === 1 && bg.alpha === 1,
  };
}

// Parses `rgb(r, g, b)` and `rgba(r, g, b, a)` as computed by the browser.
function parseColor(css: string): { rgb: Rgb; alpha: number } {
  const [r = NaN, g = NaN, b = NaN, a = 1] = (css.match(/[\d.]+/g) ?? []).map(Number);
  return { rgb: [r, g, b], alpha: a };
}

// WCAG 2.x relative luminance and contrast ratio.
type Rgb = [number, number, number];

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
