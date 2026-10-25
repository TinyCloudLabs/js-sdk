import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { loadBuild, routeUiHarness } from "./fixtures/ui-route";

// The Overview through the REAL panel-data adapter over a fake node host: the account index (the spaces and
// applications lists) missing on a brand-new account, and failing for another reason. Built by
// `bun run build:e2e-data-proxy`. Every test fails on a page or console error.
const ORIGIN = "http://tinycloud-ui.test";
const ENTRY = "data-proxy-harness-entry.js";
const FILES = loadBuild(resolve("e2e/.build/data-proxy"));

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
  __tc: {
    mount(options?: { signedIn?: boolean; name?: string }): boolean;
    arm(): Promise<boolean>;
    index(mode: "ok" | "missing" | "down"): boolean;
    indexReads(): number;
  };
  tc?: { ui: { open(section?: string): void } };
}

const tc = <T>(page: Page, fn: (api: HarnessWindow["__tc"]) => T) =>
  page.evaluate(`(${fn.toString()})(window.__tc)`) as Promise<Awaited<T>>;
const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const overview = (page: Page) => panel(page).locator('section[data-section="account"]');
const UNAVAILABLE = "Account details are unavailable.";

async function boot(page: Page, mode: "ok" | "missing" | "down") {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeUiHarness(
    page,
    () => `<!doctype html><html><body><script type="module" src="/${ENTRY}"></script></body></html>`,
    FILES,
  );
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount({ name: "Notes Pro" }));
  await page.evaluate((m) => (window as unknown as HarnessWindow).__tc.index(m), mode);
  await tc(page, (api) => api.arm());
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open("account"));
}

test("a brand-new account (no index tables yet) still shows the identity and the app, with no unavailable note", async ({ page }) => {
  await boot(page, "missing");
  const title = overview(page).locator(".account-ident .name");
  await expect(title).toHaveText("did:key:z6MkAccountA…mple");
  await expect(overview(page)).toContainText("You're inNotes Pro");
  await expect(overview(page).getByText(UNAVAILABLE)).toBeHidden();
  // Both index reads ran and came back "no such table"; that is an empty index, not a failure.
  expect(await tc(page, (api) => api.indexReads())).toBeGreaterThanOrEqual(2);
});

test("a failed account read keeps the identity and the app on screen and says only the details are unavailable", async ({ page }) => {
  await boot(page, "down");
  await expect(overview(page).getByText(UNAVAILABLE)).toBeVisible();
  await expect(overview(page).locator(".account-ident .name")).toHaveText("did:key:z6MkAccountA…mple");
  await expect(overview(page)).toContainText("You're inNotes Pro");
  await expect(overview(page).getByRole("button", { name: /^Copy/ })).toHaveCount(1);
});

test("an Overview that stays open recovers once the failed read is retried and succeeds", async ({ page }) => {
  await boot(page, "down");
  await expect(overview(page).getByText(UNAVAILABLE)).toBeVisible();
  await tc(page, (api) => api.index("ok"));
  // One retry by the adapter, no navigation by the user.
  await expect(overview(page).getByText(UNAVAILABLE)).toBeHidden({ timeout: 15_000 });
  await expect(overview(page).locator(".account-ident .name")).toHaveText("did:key:z6MkAccountA…mple");
  await expect(overview(page)).toContainText("You're inNotes Pro");
  // First attempt and its one retry, two index reads each.
  expect(await tc(page, (api) => api.indexReads())).toBe(4);
});

test("a read that keeps failing is retried once, not in a loop", async ({ page }) => {
  await boot(page, "down");
  await expect(overview(page).getByText(UNAVAILABLE)).toBeVisible();
  await expect.poll(() => tc(page, (api) => api.indexReads()), { timeout: 15_000 }).toBe(4);
  await page.waitForTimeout(8_000);
  expect(await tc(page, (api) => api.indexReads())).toBe(4);
  await expect(overview(page).getByText(UNAVAILABLE)).toBeVisible();
  await expect(overview(page).locator(".account-ident .name")).toHaveText("did:key:z6MkAccountA…mple");
});
