import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { STORAGE_PANEL_STRINGS } from "../src/ui/sections/storage.strings";
import { STRINGS } from "../src/ui/strings";

// Built by `bun run build:e2e-storage`; the test scripts run from the package root.
const BUNDLE = readFileSync(resolve("e2e/.build/storage.bundle.js"), "utf8");
const ORIGIN = "http://tinycloud-ui.test";
const STORAGE_MANAGE_URL = "https://account.tinycloud.xyz/storage";

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

// The page's used-amount figure renders only after the status read resolves, so waiting on it waits for the load.
function usageLine(page: Page): Locator {
  return section(page).locator(".storage-fig");
}

for (const scheme of SCHEMES) {
  test(`${scheme}: a storage-full episode shows a toast that links to the storage page`, async ({ page }) => {
    await mountHarness(page, scheme, KNOWN);
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();

    await setEpisode(page, true);
    const toast = page.locator(".toast--info");
    await expect(toast.locator(".toast__message")).toHaveText(STRINGS["storage.full"]);
    await expect(toast.locator("a")).toHaveAttribute("href", STORAGE_MANAGE_URL);
  });

  test(`${scheme}: an own-storage-full episode lights the launcher and the body says Full too`, async ({ page }) => {
    await mountHarness(page, scheme, KNOWN);
    await openPanel(page);
    await expect(usageLine(page)).toBeVisible();
    await expect(section(page).locator(".storage-st")).toHaveText("Normal");

    await closePanel(page);
    await setEpisode(page, true);
    await expect(launcher(page).locator('.dot[data-status="storage_full"]')).toBeVisible();

    await openPanel(page);
    await expect(panel(page).locator(".head .status")).toHaveText(STRINGS["status.storage_full"]);
    // The body agrees with the launcher and the header: Full, in plain words, and no numbers from the last read.
    await expect(section(page).locator(".storage-st")).toHaveText("Full");
    await expect(section(page).locator(".storage-banner")).toContainText("Storage full: you can't add more data right now.");
    await expect(section(page).locator('[role="meter"]')).toHaveCount(0);
    await expect(section(page).locator(".storage-fig")).toHaveCount(0);

    // It also turns Full while the panel is open, and back when the episode ends.
    await setEpisode(page, false);
    await expect(section(page).locator(".storage-st")).toHaveText("Normal");
    await setEpisode(page, true);
    await expect(section(page).locator(".storage-st")).toHaveText("Full");
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
      // On the page the link's accessible name is its text plus the screen-reader hint.
      const manage = section(page).getByRole("link", {
        name: `${STRINGS["storage.manage"]} ${STORAGE_PANEL_STRINGS["storage.page.manage_hint"]}`,
        exact: true,
      });
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
