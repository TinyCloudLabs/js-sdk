import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { loadBuild, routeUiHarness } from "./fixtures/ui-route";

// The permission and space-creation dialogs load on the first prompt, and a prompt whose dialog cannot load is
// declined. The page runs the production front (lazy-prompts.ts) over the real dialogs in their own chunk.
// Built by `bun run build:e2e-prompts-lazy`.
const ORIGIN = "http://tinycloud-ui.test";
const ENTRY = "prompts-lazy-harness-entry.js";
const FILES = loadBuild(resolve("e2e/.build/prompts-lazy"));
const DIALOG_CHUNK = /^modals-entry-.+\.js$/;

const PERMISSION = "tinycloud-permission-request-modal";

interface HarnessWindow {
  __tc: { mount(): boolean; openPermission(): boolean; openSpaceCreation(): boolean; reset(): boolean };
  __permResult?: boolean;
  __permError?: string;
  __spaceResult?: boolean;
  __spaceError?: string;
}

const pageErrors = new WeakMap<Page, string[]>();
const consoleErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  const logged: string[] = [];
  pageErrors.set(page, errors);
  consoleErrors.set(page, logged);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") logged.push(message.text());
  });
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

/** Holds the dialog chunk's response until `release()`, as a slow network would. */
async function holdDialogChunk(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  await page.route(`${ORIGIN}/modals-entry-*.js`, async (route) => {
    await gate;
    await route.fallback();
  });
  return release;
}

async function boot(page: Page, options: { failDialogChunk?: boolean } = {}) {
  expect([...FILES.keys()].some((name) => DIALOG_CHUNK.test(name))).toBe(true);
  const requested = await routeUiHarness(
    page,
    () => `<!doctype html><html><body><script type="module" src="/${ENTRY}"></script></body></html>`,
    FILES,
  );
  if (options.failDialogChunk) {
    // Registered after the harness route, so it answers first.
    await page.route(`${ORIGIN}/modals-entry-*.js`, (route) => route.abort());
  }
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
  return requested;
}

// The element itself has no box; its backdrop turns visible once the dialog has opened.
const shown = (page: Page) => expect(page.locator(`${PERMISSION} .modal-backdrop[data-state="visible"]`)).toBeAttached();
const dialogRequests = (requested: string[]) => requested.filter((name) => DIALOG_CHUNK.test(name));
const permResult = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow).__permResult);

test("the dialogs are not requested until the first prompt, then load once and show", async ({ page }) => {
  const requested = await boot(page);
  await page.waitForTimeout(300);
  expect(dialogRequests(requested)).toEqual([]);

  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.openPermission());
  await shown(page);
  expect(dialogRequests(requested)).toHaveLength(1);

  await page.getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => permResult(page)).toBe(true);
  await expect(page.locator(PERMISSION)).toHaveCount(0);

  // A second prompt reuses the loaded dialogs.
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.openPermission());
  await shown(page);
  await page.getByRole("button", { name: "Decline" }).click();
  await expect.poll(() => permResult(page)).toBe(false);
  expect(dialogRequests(requested)).toHaveLength(1);
  expect(consoleErrors.get(page) ?? []).toEqual([]);
});

test("a permission prompt whose dialog chunk fails to load is declined with a console error, never approved or left pending", async ({ page }) => {
  await boot(page, { failDialogChunk: true });
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.openPermission());
  await expect.poll(() => permResult(page)).toBe(false);
  await expect(page.locator(PERMISSION)).toHaveCount(0);
  expect((consoleErrors.get(page) ?? []).some((line) => line.includes("its dialog failed to load, so it was declined"))).toBe(true);
});

test("a space-creation prompt whose dialog chunk fails to load resolves as not confirmed, so sign-in is not approved", async ({ page }) => {
  await boot(page, { failDialogChunk: true });
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.openSpaceCreation());
  await expect
    .poll(() => page.evaluate(() => (window as unknown as HarnessWindow).__spaceResult))
    .toBe(false);
  await expect(page.locator("tinycloud-space-modal")).toHaveCount(0);
  expect((consoleErrors.get(page) ?? []).some((line) => line.includes("its dialog failed to load, so it was declined"))).toBe(true);
});

test("a prompt raised before the dialog chunk loaded is declined by a reset and never shows or approves once the chunk arrives", async ({ page }) => {
  await boot(page);
  const release = await holdDialogChunk(page);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.openPermission());
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.reset());
  // Declined by the reset itself, while the chunk is still held.
  await expect.poll(() => permResult(page)).toBe(false);

  release();
  await page.waitForTimeout(500);
  await expect(page.locator(PERMISSION)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  expect(await permResult(page)).toBe(false);
  expect(consoleErrors.get(page) ?? []).toEqual([]);
});

test("after an account change the old account's waiting prompt stays declined and only the new account's prompt shows", async ({ page }) => {
  await boot(page);
  const release = await holdDialogChunk(page);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.openPermission());
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.reset());
  await expect.poll(() => permResult(page)).toBe(false);

  // The new account raises its own request while the chunk is still held.
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.openPermission());
  release();
  await shown(page);
  await expect(page.locator(PERMISSION)).toHaveCount(1);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => permResult(page)).toBe(true);
  expect(consoleErrors.get(page) ?? []).toEqual([]);
});

test("a space-creation prompt waiting for the chunk is declined by a reset the same way", async ({ page }) => {
  await boot(page);
  const release = await holdDialogChunk(page);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.openSpaceCreation());
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.reset());
  await expect
    .poll(() => page.evaluate(() => (window as unknown as HarnessWindow).__spaceResult))
    .toBe(false);

  release();
  await page.waitForTimeout(500);
  await expect(page.locator("tinycloud-space-modal")).toHaveCount(0);
});
