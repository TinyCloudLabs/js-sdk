import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { STRINGS } from "../src/ui/strings";
import { row, textRow, type ContrastRow } from "./fixtures/contrast";

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
const section = (page: Page) => panel(page).locator('section[data-section="storage"]');

async function openPanel(page: Page) {
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open("storage"));
  await expect(panel(page)).toBeVisible();
  // The stand-in shares the panel id and shows first; wait for the lazy shell before reading the section.
  await expect(panel(page).locator(".nav-i").first()).toBeAttached();
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
    const toast = page.locator(".toast--info");
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
    await expect(panel(page).locator(".head .status")).toHaveText(STRINGS["status.storage_full"]);
    await expect(section(page).locator("p.busy").nth(0)).toHaveText(STRINGS["storage.state.full"]);
    // A full episode drops the numbers, and the panel word is hidden because the header already shows it.
    await expect(section(page).locator("p.busy:visible")).toHaveCount(0);
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
    await expect(panel(page).locator(".head .status")).toHaveText(STRINGS["status.storage_full"]);
    rows.push(await textRow("header status (full)", panel(page).locator(".head .status"), background));
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

interface ToastGeometry {
  toastBox: Box | null;
  panelBox: Box | null;
  manageBox: Box | null;
  hitsLink: boolean;
  settled: boolean;
}

/** One sample of the toast, panel and Manage link. `settled` is true when the toast clears the panel and the link is hit. */
async function readToastGeometry(toast: Locator, panelLocator: Locator, manage: Locator): Promise<ToastGeometry> {
  const toastBox = await toast.boundingBox();
  const panelBox = await panelLocator.boundingBox();
  const manageBox = await manage.boundingBox();
  const hitsLink = await manage.evaluate((el) => {
    const r = el.getBoundingClientRect();
    // The UI lives in an open shadow root, so ask the root node: document.elementFromPoint would return the host.
    const root = el.getRootNode() as Document | ShadowRoot;
    const hit = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  });
  const settled = toastBox !== null && panelBox !== null && hitsLink;
  return { toastBox, panelBox, manageBox, hitsLink, settled };
}

for (const scheme of SCHEMES) {
  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    test(`${scheme} ${viewportName}: a full-state toast leaves Manage storage hit-testable in the open panel`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mountHarness(page, scheme, KNOWN);
      await openPanel(page);
      await expect(usageLine(page)).toBeVisible();

      await setEpisode(page, true);
      const toast = page.locator(".toast--info");
      await expect(toast).toBeVisible();
      const manage = section(page).getByRole("link", { name: STRINGS["storage.manage"], exact: true });
      await expect(manage).toBeVisible();

      // The panel animates in (tc-in) and resizes through a ResizeObserver. Sample only after its
      // animations finish, so the hit-test measures the resting layout rather than a transient frame.
      let geometry: ToastGeometry | undefined;
      await expect
        .poll(
          async () => {
            await panel(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
            geometry = await readToastGeometry(toast, panel(page), manage);
            return geometry.settled;
          },
          { timeout: 5000 },
        )
        .toBe(true);
      if (!geometry?.toastBox || !geometry.panelBox) throw new Error("toast or panel has no layout box");
      console.log(
        `storage geometry ${scheme} ${viewportName}: toast=${JSON.stringify(geometry.toastBox)} panel=${JSON.stringify(geometry.panelBox)} manage=${JSON.stringify(geometry.manageBox)} hit=${geometry.hitsLink}`,
      );
      expect(geometry.hitsLink).toBe(true);
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
