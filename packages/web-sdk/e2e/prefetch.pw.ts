import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { loadBuild, routeUiHarness } from "./fixtures/ui-route";

// Real-browser checks for the panel prefetch: the lazy real adapter over a fake node.
// Built by `bun run build:e2e-prefetch`. Every test fails on a page or console error.
const ORIGIN = "http://tinycloud-ui.test";
const ENTRY = "prefetch-harness-entry.js";
const FILES = loadBuild(resolve("e2e/.build/prefetch"));
const READS = ["spaces.list", "applications.list", "delegations.query", "storage.status"];

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

interface Call {
  readonly name: string;
  readonly at: number;
}
interface HarnessWindow {
  __tc: {
    mount(): number;
    arm(): Promise<boolean>;
    reset(): boolean;
    open(): number;
    calls(): Call[];
  };
}

const launcher = (page: Page) => page.getByRole("button", { name: "TinyCloud settings", exact: true });
const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const arm = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow).__tc.arm());
const reset = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow).__tc.reset());
const open = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow).__tc.open());
const calls = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow).__tc.calls());

// `blockIdle` makes requestIdleCallback never fire, so only an intent can start the pull.
async function boot(page: Page, blockIdle = false) {
  if (blockIdle) {
    await page.addInitScript(() => {
      window.requestIdleCallback = () => 0;
    });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  const requested = await routeUiHarness(
    page,
    () => `<!doctype html><html><body><script type="module" src="/${ENTRY}"></script></body></html>`,
    FILES,
  );
  await page.goto(`${ORIGIN}/`);
  const mountedAt = await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
  await expect(launcher(page)).toBeVisible();
  return { requested, mountedAt };
}

test("sign-in arm pulls all three reads after idle; the panel opens from memory", async ({ page }, testInfo) => {
  const { requested, mountedAt } = await boot(page);
  await arm(page);

  await expect.poll(async () => (await calls(page)).map((c) => c.name), { timeout: 8000 }).toEqual(
    expect.arrayContaining(READS),
  );
  const firstRead = Math.min(...(await calls(page)).map((c) => c.at));
  testInfo.annotations.push({ type: "mount→first read (ms)", description: (firstRead - mountedAt).toFixed(1) });

  // The lazy entry loaded for the arm; the panel itself did not.
  expect(requested.some((n) => /^panel-data-entry-/.test(n))).toBe(true);
  expect(requested.some((n) => /^panel-entry-/.test(n))).toBe(false);
  await expect(panel(page)).toBeHidden();

  const namesBeforeOpen = (await calls(page)).map((c) => c.name);
  const openedAt = await open(page);
  await expect(panel(page)).toBeVisible();
  const visibleAt = await page.evaluate(() => performance.now());
  testInfo.annotations.push({ type: "open→visible (ms, approx)", description: (visibleAt - openedAt).toFixed(1) });
  await page.waitForTimeout(500);
  expect((await calls(page)).map((c) => c.name)).toEqual(namesBeforeOpen);
  await page.screenshot({ path: testInfo.outputPath("prefetch-open.png") });

  await panel(page).getByRole("button", { name: "Storage", exact: true }).click();
  await page.waitForTimeout(300);
  expect((await calls(page)).map((c) => c.name)).toEqual(namesBeforeOpen);
  await page.screenshot({ path: testInfo.outputPath("prefetch-storage.png") });
  await testInfo.attach("prefetch-storage", { path: testInfo.outputPath("prefetch-storage.png"), contentType: "image/png" });
  await testInfo.attach("prefetch-open", { path: testInfo.outputPath("prefetch-open.png"), contentType: "image/png" });
});

test("launcher hover starts the pull without waiting for idle", async ({ page }) => {
  await boot(page, true);
  await arm(page);
  await page.waitForTimeout(300);
  expect(await calls(page)).toEqual([]);

  const hoverAt = await page.evaluate(() => performance.now());
  await launcher(page).hover();
  await expect.poll(async () => (await calls(page)).map((c) => c.name), { timeout: 3000 }).toEqual(
    expect.arrayContaining(READS),
  );
  const first = Math.min(...(await calls(page)).map((c) => c.at));
  expect(first).toBeGreaterThanOrEqual(hoverAt);
});

test("sign-out before the pull cancels it; a later hover starts nothing", async ({ page }) => {
  await boot(page, true);
  await arm(page);
  await page.waitForTimeout(100);
  await reset(page);

  await launcher(page).hover();
  await page.waitForTimeout(500);
  expect(await calls(page)).toEqual([]);
});
