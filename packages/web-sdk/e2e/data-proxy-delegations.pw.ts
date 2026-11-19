import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { shortDid } from "../src/ui/data/map";
import { loadBuild, routeUiHarness } from "./fixtures/ui-route";

// Delegations through the REAL panel-data adapter (the lazy proxy and createRealPanelData) over a fake node
// host, not the stub. Built by `bun run build:e2e-data-proxy`. Every test fails on a page or console error.
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

interface Call {
  readonly name: string;
  readonly args?: unknown;
}
interface HarnessWindow {
  __tc: {
    mount(options?: { signedIn?: boolean; name?: string }): boolean;
    arm(): Promise<boolean>;
    switchAccount(to: "A" | "B" | "S"): Promise<boolean>;
    signOut(): boolean;
    hold(closed: boolean): boolean;
    deny(on: boolean): boolean;
    statusNotFound(on: boolean): boolean;
    calls(): Call[];
    revokes(): string[];
  };
  tc?: { ui: { open(section?: string): void } };
}

const tc = <T>(page: Page, fn: (api: HarnessWindow["__tc"]) => T) =>
  page.evaluate(`(${fn.toString()})(window.__tc)`) as Promise<Awaited<T>>;
const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const body = (page: Page) => panel(page).locator('section[data-section="delegations"]');
const cards = (page: Page) => body(page).locator("article.dl-card");
const slips = (page: Page) => page.locator(".tstack .toast");
const calls = (page: Page, name: string) => tc(page, (api) => api.calls()).then((all) => all.filter((c) => c.name === name));

// The cards are named by the adapter's short form of the delegate DID. Mirrors the harness's DELEGATE().
const delegate = (account: "A" | "B" | "S", n: number) =>
  shortDid(`did:key:z6Mk${account}DelegateExampleBase0${n}`);
const card = (page: Page, account: "A" | "B" | "S", n: number) => cards(page).filter({ hasText: delegate(account, n) });

/** Records whether the needle is ever in the panel's DOM from now on, not only at the end: a flash of the old account's rows counts. */
const watchFor = (page: Page, needle: string) =>
  page.evaluate((text) => {
    const root = document.querySelector("[data-tinycloud-ui]")?.shadowRoot;
    if (!root) throw new Error("no panel root");
    const w = window as unknown as { __seen?: Record<string, boolean> };
    const found = (w.__seen ??= {});
    found[text] = false;
    new MutationObserver(() => {
      if (root.textContent?.includes(text)) found[text] = true;
    }).observe(root, { subtree: true, childList: true, characterData: true });
  }, needle);
const seen = (page: Page, needle: string) =>
  page.evaluate((text) => (window as unknown as { __seen: Record<string, boolean> }).__seen[text] === true, needle);

async function boot(page: Page, options: { signedIn?: boolean; name?: string } = {}) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeUiHarness(
    page,
    () => `<!doctype html><html><body><script type="module" src="/${ENTRY}"></script></body></html>`,
    FILES,
  );
  await page.goto(`${ORIGIN}/`);
  await page.evaluate((o) => (window as unknown as HarnessWindow).__tc.mount(o), options);
}

const openDelegations = (page: Page) =>
  page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open("delegations"));

test("the list renders from the adapter's rows, read through the node's query", async ({ page }) => {
  await boot(page);
  await tc(page, (api) => api.arm());
  await openDelegations(page);
  await expect(cards(page)).toHaveCount(3);
  for (const n of [1, 2, 3]) await expect(card(page, "A", n)).toBeVisible();
  await expect(body(page)).toContainText("Showing 3+. There are more.");
  // One shared read serves the prefetch and the open section, and asks the node for all directions.
  const reads = await calls(page, "delegations.query");
  expect(reads.length).toBeGreaterThan(0);
  expect(reads[0]?.args).toMatchObject({ direction: "all" });
  expect((reads[0]?.args as { cursor?: string }).cursor).toBeUndefined();
});

test("a revoke goes through the adapter: the node is asked, the row leaves and the receipt shows", async ({ page }) => {
  await boot(page);
  await tc(page, (api) => api.arm());
  await openDelegations(page);
  await expect(cards(page)).toHaveCount(3);

  await card(page, "A", 2).getByRole("button", { name: `Revoke access for ${delegate("A", 2)}` }).click();
  const box = body(page).locator('[role="alertdialog"]');
  await expect(box).toBeVisible();
  await box.getByRole("button", { name: "Revoke access" }).click();

  await expect(card(page, "A", 2)).toHaveCount(0);
  await expect(cards(page)).toHaveCount(2);
  await expect(slips(page)).toContainText("Access revoked");
  await expect(slips(page).locator(".slip")).toContainText("Delegation bafyAccountA2");
  expect(await tc(page, (api) => api.revokes())).toEqual(["bafyAccountA2"]);
  // The node is the arbiter: status first, then the revoke, then a fresh list read.
  const names = (await tc(page, (api) => api.calls())).map((c) => c.name);
  const revokeAt = names.indexOf("delegations.revoke");
  expect(names[revokeAt - 1]).toBe("delegations.status");
  expect(names.slice(revokeAt + 1)).toContain("delegations.query");
});

test("a grant whose status the node cannot read is still revoked: the revoke is asked, never reported as already ended", async ({ page }) => {
  await boot(page);
  await tc(page, (api) => api.arm());
  await tc(page, (api) => api.statusNotFound(true));
  await openDelegations(page);
  await expect(cards(page)).toHaveCount(3);

  await card(page, "A", 2).getByRole("button", { name: `Revoke access for ${delegate("A", 2)}` }).click();
  const box = body(page).locator('[role="alertdialog"]');
  await box.getByRole("button", { name: "Revoke access" }).click();

  await expect(card(page, "A", 2)).toHaveCount(0);
  await expect(slips(page)).toContainText("Access revoked");
  await expect(body(page)).not.toContainText("had already ended");
  expect(await tc(page, (api) => api.revokes())).toEqual(["bafyAccountA2"]);
});

test("Show more reads the next page by the cursor the first page gave", async ({ page }) => {
  await boot(page);
  await tc(page, (api) => api.arm());
  await openDelegations(page);
  await expect(cards(page)).toHaveCount(3);

  await body(page).getByRole("button", { name: "Show more" }).click();
  await expect(cards(page)).toHaveCount(5);
  await expect(card(page, "A", 5)).toBeVisible();
  await expect(body(page).getByRole("button", { name: "Show more" })).toHaveCount(0);
  const withCursor = (await calls(page, "delegations.query")).filter((c) => (c.args as { cursor?: string }).cursor !== undefined);
  expect(withCursor.map((c) => (c.args as { cursor: string }).cursor)).toEqual(["A-page-2"]);
});

test("an account switch while the list is loading discards the old account's rows", async ({ page }) => {
  await boot(page);
  await watchFor(page, "z6MkAD");
  await tc(page, (api) => api.hold(true));
  await tc(page, (api) => api.arm());
  await openDelegations(page);
  await expect(body(page)).toBeVisible();
  await expect.poll(async () => (await calls(page, "delegations.query")).length).toBeGreaterThan(0);

  // Account B signs in while account A's read is still on the wire; then A's answer arrives.
  await tc(page, (api) => api.switchAccount("B"));
  await tc(page, (api) => api.hold(false));
  await openDelegations(page);
  await expect(cards(page)).toHaveCount(2);
  for (const n of [1, 2]) await expect(card(page, "B", n)).toBeVisible();
  // Not even briefly: none of A's delegates are on the page, and a settle later still none.
  await expect(panel(page).getByText(delegate("A", 1))).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(cards(page)).toHaveCount(2);
  await expect(panel(page).getByText(/z6MkAD/)).toHaveCount(0);
  expect(await seen(page, "z6MkAD")).toBe(false);
});

test("a Show more page in flight across an account switch is dropped", async ({ page }) => {
  await boot(page);
  await tc(page, (api) => api.arm());
  await openDelegations(page);
  await expect(cards(page)).toHaveCount(3);

  await tc(page, (api) => api.hold(true));
  await watchFor(page, delegate("A", 4));
  await watchFor(page, delegate("A", 5));
  await body(page).getByRole("button", { name: "Show more" }).click();
  await expect.poll(async () => (await calls(page, "delegations.query")).filter((c) => (c.args as { cursor?: string }).cursor !== undefined).length).toBe(1);
  await tc(page, (api) => api.switchAccount("B"));
  await tc(page, (api) => api.hold(false));
  await openDelegations(page);
  await expect(cards(page)).toHaveCount(2);
  await page.waitForTimeout(500);
  await expect(cards(page)).toHaveCount(2);
  await expect(card(page, "A", 4)).toHaveCount(0);
  await expect(card(page, "A", 5)).toHaveCount(0);
  expect(await seen(page, delegate("A", 4))).toBe(false);
  expect(await seen(page, delegate("A", 5))).toBe(false);
});

test("a signed-out host that was never armed does not spin: Overview says signed out and no read was made", async ({ page }) => {
  await boot(page, { signedIn: false });
  await openDelegations(page);
  await expect(panel(page).locator("section.section")).toBeVisible();
  await expect(panel(page).locator('section[data-section="account"]')).toContainText("signed out");
  await expect(panel(page).locator('.nav-i[data-section="delegations"]')).toHaveCount(0);
  await expect(panel(page).getByText(/Loading|Looking for|Checking/)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await tc(page, (api) => api.calls())).toEqual([]);
});

test("signing out while Delegations is open closes the panel; reopening signed out does not spin and reads nothing", async ({ page }) => {
  await boot(page);
  await tc(page, (api) => api.arm());
  await openDelegations(page);
  await expect(cards(page)).toHaveCount(3);
  const before = (await calls(page, "delegations.query")).length;

  await tc(page, (api) => api.signOut());
  await expect(panel(page)).toBeHidden();
  await openDelegations(page);
  await expect(panel(page).locator('section[data-section="account"]')).toContainText("signed out");
  await expect(panel(page).getByText(/Loading|Looking for|Checking/)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect((await calls(page, "delegations.query")).length).toBe(before);
});

test("the app's own session grant, listed under the bare DID while sessionDid carries a fragment, is the app's own", async ({ page }) => {
  await boot(page);
  await tc(page, (api) => api.arm());
  await tc(page, (api) => api.switchAccount("S"));
  await openDelegations(page);
  await expect(cards(page)).toHaveCount(2);
  // Grouped under the app, not under others.
  await expect(body(page).locator(".dl-h")).toHaveText(["Granted to e2e-data-proxy1", "Granted to others1"]);
  const own = cards(page).filter({ hasText: "This app" });
  await expect(own).toHaveCount(1);

  // The confirm names the app and says it stops working here.
  await own.getByRole("button", { name: /^Revoke access for / }).click();
  const box = body(page).locator('[role="alertdialog"]');
  await expect(box).toBeVisible();
  await expect(box).toContainText("Revoke access for e2e-data-proxy on this device?");
  await expect(box).toContainText("e2e-data-proxy will stop working here until you sign in again.");
  await box.getByRole("button", { name: "Keep access" }).click();
  expect(await tc(page, (api) => api.revokes())).toEqual([]);

  // A helper's grant is still under others, with the ordinary confirm.
  await card(page, "S", 1).getByRole("button", { name: `Revoke access for ${delegate("S", 1)}` }).click();
  await expect(body(page).locator('[role="alertdialog"]')).not.toContainText("will stop working here");
});

test("the manifest display name names the app wherever the panel names it; the app id stays out of the copy", async ({ page }) => {
  await boot(page, { name: "Notes Pro" });
  await tc(page, (api) => api.arm());
  await tc(page, (api) => api.switchAccount("S"));

  // Header context, from the same name the delegations copy uses.
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open("account"));
  await expect(panel(page).locator(".head .ctx")).toHaveText("in Notes Pro");
  // Overview "You're in" comes from the real adapter's account view.
  await expect(panel(page).locator('section[data-section="account"]')).toContainText("You're inNotes Pro");

  await panel(page).getByRole("button", { name: "Delegations", exact: true }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(body(page).locator(".dl-h")).toHaveText(["Granted to Notes Pro1", "Granted to others1"]);
  await cards(page).filter({ hasText: "This app" }).getByRole("button", { name: /^Revoke access for / }).click();
  const box = body(page).locator('[role="alertdialog"]');
  await expect(box).toContainText("Revoke access for Notes Pro on this device?");
  await expect(box).toContainText("Notes Pro will stop working here until you sign in again.");
  await expect(panel(page)).not.toContainText("e2e-data-proxy");
});

test("Overview with no ENS name shows the short DID once, as one line, with one copy button", async ({ page }) => {
  await boot(page);
  await tc(page, (api) => api.arm());
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open("account"));
  const account = panel(page).locator('section[data-section="account"]');
  const title = account.locator(".account-ident .name");
  await expect(title).toHaveText("did:key:z6MkAccountA…mple");
  await expect(title).toHaveAttribute("title", "did:key:z6MkAccountAExample");
  expect((await title.boundingBox())?.height).toBeLessThan(40);
  await expect(account.locator(".account-did")).toBeHidden();
  await expect(account).not.toContainText("did:key:z6MkAccountAExample");
  await expect(account.getByRole("button", { name: /^Copy/ })).toHaveCount(1);
});
