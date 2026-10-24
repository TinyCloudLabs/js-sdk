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
    control(next: { rtt?: number; deny?: string[]; fail?: string[] }): boolean;
    hold(closed: boolean): boolean;
    age(ms: number): number;
    close(): boolean;
    calls(): Call[];
  };
}

const launcher = (page: Page) => page.getByRole("button", { name: "TinyCloud settings", exact: true });
const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const arm = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow).__tc.arm());
const reset = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow).__tc.reset());
const open = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow).__tc.open());
const calls = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow).__tc.calls());
const setFaults = (page: Page, next: { rtt?: number; deny?: string[]; fail?: string[] }) =>
  page.evaluate((n) => (window as unknown as HarnessWindow).__tc.control(n), next);
const age = (page: Page, ms: number) => page.evaluate((m) => (window as unknown as HarnessWindow).__tc.age(m), ms);
const close = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow).__tc.close());
const hold = (page: Page, closed: boolean) =>
  page.evaluate((c) => (window as unknown as HarnessWindow).__tc.hold(c), closed);
const callCount = async (page: Page, name: string) => (await calls(page)).filter((c) => c.name === name).length;
const delegationsNav = (page: Page) => panel(page).getByRole("button", { name: "Delegations", exact: true });
const storageNav = (page: Page) => panel(page).getByRole("button", { name: "Storage", exact: true });
// At phone width the section nav is the Sections menu. The panel keeps the last section, so when Delegations is already open there is nothing to pick.
// A reopened panel can paint in the previous width's layout for a moment before it settles into the new one, so a nav seen
// by one check can be gone by the next click; the whole step runs again until it lands.
async function goDelegations(page: Page) {
  const menuButton = panel(page).getByRole("button", { name: "Sections", exact: true });
  await expect(delegationsNav(page).or(menuButton)).toBeVisible();
  await expect(async () => {
    if (await panel(page).locator('section[data-section="delegations"]').isVisible()) return;
    if (await delegationsNav(page).isVisible()) {
      await delegationsNav(page).click({ timeout: 1000 });
      return;
    }
    await menuButton.click({ timeout: 1000 });
    await delegationsNav(page).click({ timeout: 1000 });
  }).toPass({ timeout: 8000 });
}

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

// Prefetch has run; the delegations snapshot is then 3 min old, so the next open revalidates it.
async function armAndAge(page: Page) {
  await boot(page);
  await arm(page);
  await expect.poll(async () => (await calls(page)).map((c) => c.name), { timeout: 8000 }).toEqual(
    expect.arrayContaining(READS),
  );
  await age(page, 180_000);
}

test("stale delegations: Updating while the revalidate is in flight, then Updated with one re-query", async ({ page }) => {
  await armAndAge(page);
  await hold(page, true);
  const before = await callCount(page, "delegations.query");
  await open(page);
  await delegationsNav(page).click();
  await expect(panel(page).getByText("Updating…", { exact: true })).toBeVisible();
  await hold(page, false);
  await expect(panel(page).getByText("Updated just now", { exact: true })).toBeVisible({ timeout: 5000 });
  expect(await callCount(page, "delegations.query")).toBe(before + 1);
});

test("failed refresh keeps the snapshot and says so", async ({ page }) => {
  await armAndAge(page);
  await setFaults(page, { fail: ["delegations.query"] });
  const before = await callCount(page, "delegations.query");
  await open(page);
  await delegationsNav(page).click();
  await expect(panel(page).getByText("Couldn't refresh. Showing data from 3 min ago.", { exact: true })).toBeVisible({
    timeout: 5000,
  });
  expect(await callCount(page, "delegations.query")).toBe(before + 1);
});

test("denied delegations shows needs-permission for that section only", async ({ page }) => {
  await armAndAge(page);
  await setFaults(page, { deny: ["delegations.query"] });
  await open(page);
  await delegationsNav(page).click();
  await expect(panel(page).getByText("This session doesn't have access to this list.", { exact: true })).toBeVisible({
    timeout: 5000,
  });
  await storageNav(page).click();
  await expect(panel(page).getByText("Storage usage needs your permission.", { exact: true })).toBeHidden();
  await expect(panel(page).getByText(" used", { exact: false }).first()).toBeVisible({ timeout: 5000 });
});

for (const rtt of [100, 300]) {
  test(`cold open at ${rtt} ms RTT: data appears after one round trip`, async ({ page }, testInfo) => {
    await boot(page, true);
    await arm(page);
    await setFaults(page, { rtt });
    await open(page);
    await delegationsNav(page).click();
    await expect(panel(page).getByText("Updated just now", { exact: true })).toBeVisible({ timeout: 8000 });
    const requestedAt = (await calls(page)).find((c) => c.name === "delegations.query")?.at ?? NaN;
    const shownAt = await page.evaluate(() => performance.now());
    testInfo.annotations.push({
      type: `cold open ${rtt} ms RTT: request to updated (ms)`,
      description: (shownAt - requestedAt).toFixed(1),
    });
    expect(shownAt - requestedAt).toBeGreaterThanOrEqual(rtt);
  });
}

test("opening the panel without an arm makes no reads and logs no error", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await boot(page, true);
  await open(page);
  await delegationsNav(page).click();
  await expect(panel(page)).toBeVisible();
  expect(await calls(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("warm open from memory shows data before a 300 ms round trip could finish", async ({ page }, testInfo) => {
  await boot(page);
  await arm(page);
  await expect.poll(async () => (await calls(page)).map((c) => c.name), { timeout: 8000 }).toEqual(
    expect.arrayContaining(READS),
  );
  await setFaults(page, { rtt: 300 });
  const before = await callCount(page, "delegations.query");
  await open(page);
  await expect(panel(page)).toBeVisible();
  await delegationsNav(page).click();
  const clickedAt = await page.evaluate(() => performance.now());
  await expect(panel(page).getByText("Updated just now", { exact: true })).toBeVisible();
  const shownAt = await page.evaluate(() => performance.now());
  testInfo.annotations.push({ type: "warm open from memory: click to updated (ms)", description: (shownAt - clickedAt).toFixed(1) });
  expect(shownAt - clickedAt).toBeLessThan(300);
  expect(await callCount(page, "delegations.query")).toBe(before);
});

test("freshness chip states at light and dark, desktop and phone widths", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await armAndAge(page);
  const sizes = {
    desktop: { width: 1280, height: 800 },
    phone: { width: 390, height: 844 },
  } as const;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const size of Object.keys(sizes) as (keyof typeof sizes)[]) {
      await page.setViewportSize(sizes[size]);

      await hold(page, true);
      await age(page, 180_000);
      await close(page);
      await open(page);
      await goDelegations(page);
      await expect(panel(page).getByText("Updating…", { exact: true })).toBeVisible();
      const updatingShot = testInfo.outputPath(`updating-${scheme}-${size}.png`);
      await page.screenshot({ path: updatingShot });
      await hold(page, false);
      await expect(panel(page).getByText("Updated just now", { exact: true })).toBeVisible({ timeout: 8000 });

      await setFaults(page, { fail: ["delegations.query"] });
      await age(page, 180_000);
      await close(page);
      await open(page);
      await goDelegations(page);
      await expect(panel(page).getByText("Couldn't refresh. Showing data from 3 min ago.", { exact: true })).toBeVisible({
        timeout: 5000,
      });
      const failedShot = testInfo.outputPath(`failed-${scheme}-${size}.png`);
      await page.screenshot({ path: failedShot });
      await testInfo.attach(`updating-${scheme}-${size}`, { path: updatingShot, contentType: "image/png" });
      await testInfo.attach(`failed-${scheme}-${size}`, { path: failedShot, contentType: "image/png" });
      await setFaults(page, {});
    }
  }
});
