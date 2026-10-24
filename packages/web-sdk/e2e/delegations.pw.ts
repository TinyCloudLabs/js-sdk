import { expect, test, type Locator, type Page } from "@playwright/test";
import { row as contrastRow, textRow, type ContrastRow } from "./fixtures/contrast";
import { laterRow, mockupRows, receivedRow, seedScript } from "./fixtures/delegations-seed";
import { routeUiHarness } from "./fixtures/ui-route";
import type { StubDelegationsSeed } from "../src/ui/stub/index";

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
  __tc: { mount(ui?: Record<string, unknown>): boolean };
  tc?: { ui: { open(section?: string): void; openPage(section?: string): void } };
}

type Scheme = "light" | "dark";
interface Viewport {
  readonly width: number;
  readonly height: number;
}
const DESKTOP: Viewport = { width: 1280, height: 800 };
const PHONE: Viewport = { width: 390, height: 844 };

// The panel's surface in each scheme.
const SURFACE = { light: "rgb(255, 255, 255)", dark: "rgb(21, 21, 23)" } as const;
const CHIP = { light: "rgb(244, 244, 245)", dark: "rgb(39, 39, 42)" } as const;

const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const body = (page: Page) => panel(page).locator('section[data-section="delegations"]');
const cards = (page: Page) => body(page).locator("article.dl-card");
const card = (page: Page, name: string) => cards(page).filter({ hasText: name });
const slips = (page: Page) => page.locator(".tstack .toast");

interface Options {
  readonly scheme?: Scheme;
  readonly viewport?: Viewport;
  readonly seed?: StubDelegationsSeed;
  readonly reducedMotion?: boolean;
  readonly layout?: "drawer" | "page";
}

async function open(page: Page, options: Options = {}) {
  await page.emulateMedia({ colorScheme: options.scheme ?? "light", reducedMotion: options.reducedMotion === true ? "reduce" : "no-preference" });
  await page.setViewportSize(options.viewport ?? DESKTOP);
  await page.addInitScript(seedScript(options.seed ?? { rows: mockupRows(), revokeDelayMs: 250 }));
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
  await page.evaluate((layout) => {
    const ui = (window as unknown as HarnessWindow).tc?.ui;
    if (layout === "page") ui?.openPage("delegations");
    else ui?.open("delegations");
  }, options.layout ?? "drawer");
  await expect(body(page)).toBeVisible();
  // Measurements below need the slide-in finished.
  await panel(page).evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
}

async function openConfirm(page: Page, name: string): Promise<Locator> {
  await card(page, name).getByRole("button", { name: `Revoke access for ${name}` }).click();
  const box = body(page).locator('[role="alertdialog"]');
  await expect(box).toBeVisible();
  return box;
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test("the sidebar groups the cards, counts them and shows each card's parts", async ({ page }) => {
      await open(page, { scheme });
      await expect(panel(page)).toHaveAttribute("data-layout", "drawer");
      await expect(body(page).locator(".sec-title")).toHaveText("Delegations");
      await expect(body(page).locator(".dl-h")).toHaveText(["Granted to e2e-settings-smoke1", "Granted to others6"]);
      await expect(cards(page)).toHaveCount(7);

      const local = card(page, "Fieldnotes · local copy");
      await expect(local.locator(".dl-kind")).toContainText("Granted by you");
      await expect(card(page, "Fieldnotes · this browser").locator(".dl-kind")).toContainText("This app");
      await expect(local.locator(".dl-what")).toHaveText("Can read, write and list notes/ and recordings/");
      await expect(local.locator(".dl-meta")).toHaveText(/^Personal space · Created 17 h ago · Expires in 1h\u00a048m$/);
      await expect(local.locator(".dl-chip")).toHaveText(["Read", "Write", "List", "Terminal"]);
      await expect(local.locator(".st")).toHaveText("Expiring soon");
      await expect(local.locator(".st")).toHaveClass(/st-warn/);
      await expect(card(page, "Fieldnotes · this browser").locator(".dl-chip")).toHaveText(["Read", "Write", "List"]);
      await expect(card(page, "Research helper").locator(".dl-what")).toHaveText("Can read and list notes/");

      // The expired grant offers no Revoke.
      const expired = card(page, "Secret Manager");
      await expect(expired.locator(".st")).toHaveText("Expired");
      await expect(expired.getByRole("button", { name: /^Revoke/ })).toBeHidden();
      await expect(expired).toContainText("Nothing to revoke");

      // Rail count is the list's row count.
      await page.getByRole("button", { name: "Open full page", exact: true }).click();
      await expect(panel(page).locator(".nav-i", { hasText: "Delegations" }).locator(".nav-m")).toHaveText("7");
    });

    test("the full page lays the cards out in two columns", async ({ page }) => {
      await open(page, { scheme, layout: "page" });
      await expect(panel(page)).toHaveAttribute("data-layout", "page");
      await expect(cards(page)).toHaveCount(7);
      const a = await card(page, "Fieldnotes · local copy").boundingBox();
      const b = await card(page, "Fieldnotes · audio transcriber").boundingBox();
      expect(a && b && b.x > a.x + a.width - 1 && Math.abs(a.y - b.y) < 2).toBe(true);
    });

    test("a phone gets the full page, one column, every control reachable at 360 px", async ({ page }) => {
      await open(page, { scheme, viewport: PHONE });
      await expect(panel(page)).toHaveAttribute("data-layout", "page");
      await expect(cards(page)).toHaveCount(7);
      const a = await card(page, "Fieldnotes · this browser").boundingBox();
      const b = await card(page, "Fieldnotes · local copy").boundingBox();
      expect(a && b && b.y > a.y + a.height - 1).toBe(true);

      for (const width of [390, 360]) {
        await page.setViewportSize({ width, height: 844 });
        const overflow = await body(page).evaluate((el) => {
          const main = el.closest(".main") as HTMLElement;
          return { scroll: main.scrollWidth, client: main.clientWidth };
        });
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
        for (const name of ["Fieldnotes · this browser", "Research helper"]) {
          const target = card(page, name);
          await target.scrollIntoViewIfNeeded();
          for (const button of await target.getByRole("button").all()) {
            const box = await button.boundingBox();
            expect(box, `${name} button`).not.toBeNull();
            expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
            expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
          }
          await expect(target.locator(".dl-name")).toBeVisible();
        }
      }
    });

    test("every control in the section is at least 44 px", async ({ page }) => {
      await open(page, { scheme, layout: "page" });
      await card(page, "Research helper").getByRole("button", { name: /^See details/ }).click();
      await expect(body(page).locator(".drawer")).toBeVisible();
      const small = await body(page).evaluate((el) => {
        const found: string[] = [];
        for (const control of el.querySelectorAll("button")) {
          const box = control.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          if (box.height < 44 || box.width < 44) found.push(`${control.getAttribute("aria-label") ?? control.textContent}: ${box.width}x${box.height}`);
        }
        return found;
      });
      expect(small).toEqual([]);
    });

    test("text meets AA contrast on the card and on the chips", async ({ page }) => {
      await open(page, { scheme, layout: "page" });
      const target = card(page, "Fieldnotes · local copy");
      const rows: ContrastRow[] = [
        await textRow("group heading", body(page).locator(".dl-h").first(), SURFACE[scheme]),
        await textRow("group count", body(page).locator(".dl-cnt").first(), SURFACE[scheme]),
        await textRow("group sub", body(page).locator(".dl-sub").first(), SURFACE[scheme]),
        await textRow("name", target.locator(".dl-name"), SURFACE[scheme]),
        await textRow("kind", target.locator(".dl-kind"), SURFACE[scheme]),
        await textRow("what", target.locator(".dl-what"), SURFACE[scheme]),
        await textRow("meta", target.locator(".dl-meta"), SURFACE[scheme]),
        await textRow("status word (amber)", target.locator(".st"), SURFACE[scheme]),
        await textRow("active status word", card(page, "Exo").locator(".st"), SURFACE[scheme]),
        await textRow("expired status word", card(page, "Secret Manager").locator(".st"), SURFACE[scheme]),
        await textRow("ended note", card(page, "Secret Manager").locator(".dl-fine"), SURFACE[scheme]),
        await textRow("button", target.getByRole("button", { name: /^Revoke/ }), SURFACE[scheme]),
        await textRow("chip", target.locator(".dl-chip").first(), CHIP[scheme]),
        await textRow("terminal chip", target.locator(".dl-chip-line"), SURFACE[scheme]),
      ];
      // The dot is not text; the status word carries the state, and it is compared with the surface.
      for (const result of rows) {
        expect(result.opaque, result.label).toBe(true);
        expect(result.ratio, result.label).toBeGreaterThanOrEqual(4.5);
      }

      // Each chip sits on its own tinted background; compare that, not an assumed one.
      const chipBackground = await target.locator(".dl-chip").first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(chipBackground).toBe(CHIP[scheme]);
      const amberDot = await target.locator(".st .dot").evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(contrastRow("amber dot", amberDot, SURFACE[scheme]).ratio).toBeGreaterThanOrEqual(3);
    });

    test("Revoke asks first: the box names what stops, says OpenKey, and Keep access has focus", async ({ page }) => {
      await open(page, { scheme });
      const box = await openConfirm(page, "Research helper");
      await expect(box).toContainText("Revoke access for Research helper?");
      await expect(box).toContainText("Research helper will stop being able to read and list notes/ in your Personal space.");
      await expect(box).toContainText("You'll confirm with your wallet in OpenKey. You can give access again later; this can't be undone from here.");
      await expect(box.getByRole("button")).toHaveText(["Keep access", "Revoke access"]);
      await expect(box.getByRole("button", { name: "Keep access" })).toBeFocused();
      await expect(box).toHaveAttribute("aria-labelledby", /./);
      // Nothing happened yet.
      await expect(cards(page)).toHaveCount(7);
      await expect(slips(page)).toHaveCount(0);

      const texts = await textRow("confirm text", box.locator("p span").nth(1), SURFACE[scheme]);
      expect(texts.ratio).toBeGreaterThanOrEqual(4.5);
      const dim = await textRow("confirm note", box.locator(".dl-q-dim"), SURFACE[scheme]);
      expect(dim.ratio).toBeGreaterThanOrEqual(4.5);
    });

    test("the app's own grant names the app on this device and what happens next", async ({ page }) => {
      await open(page, { scheme });
      const box = await openConfirm(page, "Fieldnotes · this browser");
      await expect(box).toContainText("Revoke access for e2e-settings-smoke on this device?");
      await expect(box).toContainText("e2e-settings-smoke will stop being able to read, write and list notes/ and recordings/ in your Personal space.");
      await expect(box).toContainText("e2e-settings-smoke will stop working here until you sign in again.");
      await expect(box).not.toContainText("did:key");
      await expect(box.getByRole("button", { name: "Keep access" })).toBeFocused();
      const note = await textRow("consequence", box.locator("p span").nth(1), SURFACE[scheme]);
      expect(note.ratio).toBeGreaterThanOrEqual(4.5);
    });

    test("a helper the app started is another party's grant: no 'on this device' wording", async ({ page }) => {
      await open(page, { scheme });
      const box = await openConfirm(page, "Fieldnotes · local copy");
      await expect(box).toContainText("Revoke access for Fieldnotes · local copy?");
      await expect(box).not.toContainText("on this device");
      await expect(box).not.toContainText("sign in again");
    });

    test("Keep access closes the box, changes nothing and puts focus back on Revoke", async ({ page }) => {
      await open(page, { scheme });
      const box = await openConfirm(page, "Research helper");
      await box.getByRole("button", { name: "Keep access" }).click();
      await expect(body(page).locator('[role="alertdialog"]')).toHaveCount(0);
      await expect(card(page, "Research helper").getByRole("button", { name: /^Revoke/ })).toBeFocused();
      await expect(cards(page)).toHaveCount(7);
      await expect(slips(page)).toHaveCount(0);
      await expect(card(page, "Research helper").locator(".st")).toHaveText("Active");
    });

    test("Escape takes the safe action and does not close the panel", async ({ page }) => {
      await open(page, { scheme });
      await openConfirm(page, "Research helper");
      await page.keyboard.press("Escape");
      await expect(body(page).locator('[role="alertdialog"]')).toHaveCount(0);
      await expect(panel(page)).toBeVisible();
      await expect(card(page, "Research helper").getByRole("button", { name: /^Revoke/ })).toBeFocused();
      await expect(cards(page)).toHaveCount(7);
      await expect(slips(page)).toHaveCount(0);
    });

    test("Enter on the focused safe action does not revoke", async ({ page }) => {
      await open(page, { scheme });
      await openConfirm(page, "Research helper");
      await page.keyboard.press("Enter");
      await expect(body(page).locator('[role="alertdialog"]')).toHaveCount(0);
      await expect(cards(page)).toHaveCount(7);
      await expect(slips(page)).toHaveCount(0);
    });

    test("Tab order inside the box is Keep access, then Revoke access", async ({ page }) => {
      await open(page, { scheme });
      const box = await openConfirm(page, "Research helper");
      await page.keyboard.press("Tab");
      await expect(box.getByRole("button", { name: "Revoke access" })).toBeFocused();
    });

    test("confirming shows a busy state, removes the row, updates the counts and shows a CID receipt", async ({ page }) => {
      await open(page, { scheme });
      const box = await openConfirm(page, "Research helper");
      await box.getByRole("button", { name: "Revoke access" }).click();

      // Busy: the stub answers after a moment, so the card says so and the other Revoke buttons are off.
      await expect(card(page, "Research helper")).toContainText("Revoking…");
      await expect(card(page, "Exo").getByRole("button", { name: /^Revoke/ })).toBeEnabled();
      await expect(card(page, "Research helper")).toBeFocused();

      await expect(card(page, "Research helper")).toHaveCount(0);
      await expect(cards(page)).toHaveCount(6);
      await expect(body(page).locator(".dl-h")).toHaveText(["Granted to e2e-settings-smoke1", "Granted to others5"]);

      // The receipt carries the CID and the time, and no receipt id.
      await expect(slips(page)).toHaveCount(1);
      await expect(slips(page)).toContainText("Access revoked");
      await expect(slips(page).locator(".slip")).toContainText(/Delegation bafyEXAMPLEd4p9ax/);
      await expect(slips(page).locator(".slip")).toContainText(/Time \d/);
      await expect(slips(page).locator(".slip")).not.toContainText("rcpt");

      // Focus lands on the section heading, not on a removed element.
      await expect(body(page).locator(".sec-title")).toBeFocused();

      // The panel's rail count follows the cache.
      await page.getByRole("button", { name: "Open full page", exact: true }).click();
      await expect(panel(page).locator(".nav-i", { hasText: "Delegations" }).locator(".nav-m")).toHaveText("6");
    });

    test("a second Revoke of another row works after the first", async ({ page }) => {
      await open(page, { scheme, reducedMotion: true });
      for (const name of ["Research helper", "Exo"]) {
        const box = await openConfirm(page, name);
        await box.getByRole("button", { name: "Revoke access" }).click();
        await expect(card(page, name)).toHaveCount(0);
      }
      await expect(cards(page)).toHaveCount(5);
    });

    test("a failed revoke keeps the row, shows a neutral line and Try again asks again", async ({ page }) => {
      await open(page, { scheme, seed: { rows: mockupRows(), revokeFails: { bafyEXAMPLEd4p9ax: "unknown" }, revokeDelayMs: 100 } });
      const box = await openConfirm(page, "Research helper");
      await box.getByRole("button", { name: "Revoke access" }).click();

      const target = card(page, "Research helper");
      await expect(target.getByRole("alert")).toHaveText(/Couldn.t revoke this access\./);
      await expect(cards(page)).toHaveCount(7);
      await expect(slips(page)).toHaveCount(0);
      await expect(target.locator(".st")).toHaveText("Active");

      await target.getByRole("button", { name: "Try again" }).click();
      const again = body(page).locator('[role="alertdialog"]');
      await expect(again).toBeVisible();
      await expect(again.getByRole("button", { name: "Keep access" })).toBeFocused();
      await expect(slips(page)).toHaveCount(0);
    });

    test("a lost answer says it could not be confirmed, keeps the row and offers Try again", async ({ page }) => {
      await open(page, { scheme, seed: { rows: mockupRows(), revokeFails: { bafyEXAMPLEd4p9ax: "NETWORK_ERROR" }, revokeDelayMs: 50 } });
      const box = await openConfirm(page, "Research helper");
      await box.getByRole("button", { name: "Revoke access" }).click();
      const target = card(page, "Research helper");
      await expect(target.getByRole("alert")).toContainText("We couldn't confirm whether this worked.");
      await expect(target.getByRole("alert")).not.toContainText("Nothing was changed");
      await expect(target.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(cards(page)).toHaveCount(7);
      await expect(slips(page)).toHaveCount(0);
    });

    test("a grant that already ended elsewhere is refused and shown as ended", async ({ page }) => {
      await open(page, { scheme, seed: { rows: mockupRows(), revokeFails: { bafyEXAMPLEd4p9ax: "not-revocable" }, revokeDelayMs: 50 } });
      const box = await openConfirm(page, "Research helper");
      await box.getByRole("button", { name: "Revoke access" }).click();
      const target = card(page, "Research helper");
      await expect(target).toContainText("had already ended");
      await expect(target.getByRole("button", { name: "Try again" })).toBeHidden();
      await expect(cards(page)).toHaveCount(7);
      await expect(slips(page)).toHaveCount(0);
    });

    test("a session that may not revoke gets a neutral line and no retry", async ({ page }) => {
      await open(page, { scheme, seed: { rows: mockupRows(), revokeFails: { bafyEXAMPLEd4p9ax: "PERMISSION_DENIED" } } });
      const box = await openConfirm(page, "Research helper");
      await box.getByRole("button", { name: "Revoke access" }).click();
      const target = card(page, "Research helper");
      await expect(target).toContainText("This session can't change this access");
      await expect(target.getByRole("button", { name: "Try again" })).toBeHidden();
      await expect(cards(page)).toHaveCount(7);
    });

    test("See details opens the full record in a drawer and Close returns focus", async ({ page }) => {
      await open(page, { scheme });
      const target = card(page, "Fieldnotes · local copy");
      const see = target.getByRole("button", { name: /^See details/ });
      await see.click();
      const drawer = body(page).locator(".drawer");
      await expect(drawer).toBeVisible();
      await expect(drawer.locator("h3")).toHaveText("Fieldnotes · local copy");
      await expect(drawer.locator("h3")).toBeFocused();
      await expect(drawer).toContainText("Granted by");
      await expect(drawer).toContainText("Granted to");
      await expect(drawer).toContainText("did:key:z6MkEX…LEd4Lp");
      await expect(drawer).toContainText("notes/");
      await expect(drawer).toContainText("recordings/");
      await expect(drawer).toContainText("Nothing, it was granted directly");
      await expect(drawer.getByRole("button", { name: /^Copy/ })).toHaveCount(3);

      await drawer.getByRole("button", { name: "Close" }).click();
      await expect(drawer).toHaveCount(0);
      await expect(see).toBeFocused();
    });

    test("Escape closes the details drawer first, not the panel", async ({ page }) => {
      await open(page, { scheme });
      await card(page, "Exo").getByRole("button", { name: /^See details/ }).click();
      await expect(body(page).locator(".drawer")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(body(page).locator(".drawer")).toHaveCount(0);
      await expect(panel(page)).toBeVisible();
    });

    test("an empty list shows the empty state and no groups", async ({ page }) => {
      await open(page, { scheme, seed: { rows: [] } });
      await expect(body(page).locator(".dl-notice h4")).toHaveText("No one has access yet");
      await expect(body(page)).toContainText("You can take access back at any time.");
      await expect(cards(page)).toHaveCount(0);
      await expect(body(page).locator(".dl-h")).toHaveCount(0);
      const title = await textRow("empty title", body(page).locator(".dl-notice h4"), SURFACE[scheme]);
      const text = await textRow("empty text", body(page).locator(".dl-notice p"), SURFACE[scheme]);
      expect(title.ratio).toBeGreaterThanOrEqual(4.5);
      expect(text.ratio).toBeGreaterThanOrEqual(4.5);
    });

    test("needs permission shows a neutral card, no Allow button, and a neutral rail status", async ({ page }) => {
      await open(page, { scheme, layout: "page", seed: { state: "needs-permission" } });
      await expect(body(page).locator(".dl-notice h4")).toHaveText("e2e-settings-smoke can't list delegations yet");
      await expect(body(page)).toContainText("It can't change them.");
      await expect(body(page).getByRole("button")).toHaveCount(0);
      await expect(cards(page)).toHaveCount(0);
      await expect(panel(page).locator(".nav-i", { hasText: "Delegations" }).locator(".nav-m")).toHaveText("Needs permission");
    });

    test("a read that is still loading shows a skeleton and a status line", async ({ page }) => {
      await open(page, { scheme, seed: { state: "loading" } });
      await expect(body(page).locator(".dl-skel")).toBeVisible();
      await expect(body(page).locator(".dl-skel")).toHaveAttribute("role", "status");
      await expect(cards(page)).toHaveCount(0);
    });

    test("a read that failed shows a neutral line and a retry", async ({ page }) => {
      await open(page, { scheme, seed: { state: "error" } });
      await expect(body(page)).toContainText("The list of delegations didn't load.");
      await expect(body(page).getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(cards(page)).toHaveCount(0);
    });

    test("Show more reads the next pages, appends their rows, and a later row can be revoked", async ({ page }) => {
      const seed = {
        rows: mockupRows(),
        nextCursor: "p2",
        pages: { p2: { rows: [laterRow(1), laterRow(2)], nextCursor: "p3" }, p3: { rows: [laterRow(2), laterRow(3)] } },
        revokeDelayMs: 100,
      };
      await open(page, { scheme, layout: "page", seed });
      await expect(cards(page)).toHaveCount(7);
      await expect(body(page).locator(".dl-h")).toHaveText(["Granted to e2e-settings-smoke1+", "Granted to others6+"]);
      await expect(body(page)).toContainText("Showing 7+. There are more.");

      const more = body(page).getByRole("button", { name: "Show more" });
      // Keyboard operable and a proper target.
      await more.focus();
      const box = await more.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await page.keyboard.press("Enter");
      await expect(cards(page)).toHaveCount(9);
      await expect(body(page).locator(".dl-h")).toHaveText(["Granted to e2e-settings-smoke1+", "Granted to others8+"]);
      await expect(more).toBeFocused();
      await page.keyboard.press("Enter");
      // The repeated Late helper 2 is not listed twice.
      await expect(cards(page)).toHaveCount(10);
      await expect(body(page).locator(".dl-h")).toHaveText(["Granted to e2e-settings-smoke1", "Granted to others9"]);
      await expect(body(page).getByRole("button", { name: "Show more" })).toHaveCount(0);
      await expect(card(page, "Late helper 3")).toBeVisible();
      await expect(body(page).locator(".dl-foot")).toBeHidden();

      // Rows from later pages are the user's to revoke, with the same confirm and receipt.
      const confirm = await openConfirm(page, "Late helper 3");
      await expect(confirm.getByRole("button", { name: "Keep access" })).toBeFocused();
      await confirm.getByRole("button", { name: "Revoke access" }).click();
      await expect(card(page, "Late helper 3")).toHaveCount(0);
      await expect(slips(page).locator(".slip")).toContainText("Delegation bafyEXAMPLElate3");
      expect(await revokeCalls(page)).toEqual(["bafyEXAMPLElate3"]);
    });

    test("a page that fails to load says so and Try again reads it; nothing else changes", async ({ page }) => {
      // p2 is not seeded, so the stub answers it with an error.
      await open(page, { scheme, seed: { rows: mockupRows(), nextCursor: "p2" } });
      await body(page).getByRole("button", { name: "Show more" }).click();
      await expect(body(page).getByRole("alert").filter({ hasText: "Couldn't load more." })).toBeVisible();
      await expect(body(page).getByRole("button", { name: "Try again" }).last()).toBeFocused();
      await expect(cards(page)).toHaveCount(7);
      const note = await textRow("footer note", body(page).locator(".dl-foot .dl-fine"), SURFACE[scheme]);
      expect(note.ratio).toBeGreaterThanOrEqual(4.5);
    });

    test("nothing on the first page but a cursor offers Show more instead of 'No one has access yet'", async ({ page }) => {
      await open(page, { scheme, seed: { rows: [], nextCursor: "p2", pages: { p2: { rows: [laterRow(1)] } } } });
      await expect(body(page)).not.toContainText("No one has access yet");
      await expect(body(page)).toContainText("None in what's loaded so far.");
      await body(page).getByRole("button", { name: "Show more" }).click();
      await expect(card(page, "Late helper 1")).toBeVisible();
    });

    test("a received grant gets its own group, a cursor says only the first page is listed", async ({ page }) => {
      await open(page, { scheme, seed: { rows: [...mockupRows(), receivedRow()], nextCursor: "next" } });
      await expect(body(page).locator(".dl-h")).toHaveText(["Granted to e2e-settings-smoke1+", "Granted to others6+", "Received1+"]);
      const received = card(page, "did:key:z6MkEX…LEg7Qa");
      await expect(received.locator(".dl-kind")).toHaveText("Shared with you by did:key:z6MkEX…LEg7Qa");
      await expect(received.locator(".st")).toHaveText("Active");
      await expect(received.getByRole("button", { name: /^Revoke/ })).toBeHidden();
      await expect(received.getByRole("button", { name: /^See details/ })).toBeVisible();
      await expect(received).toContainText("Only the one who shared it can end it");
      await expect(body(page)).toContainText("Showing 8+. There are more.");
      await page.getByRole("button", { name: "Open full page", exact: true }).click();
      await expect(panel(page).locator(".nav-i", { hasText: "Delegations" }).locator(".nav-m")).toHaveText("8+");
    });
  });
}

const revokeCalls = (page: Page) => page.evaluate(() => (window as unknown as HarnessWindow & { __tc: { revokeCalls(): string[] } }).__tc.revokeCalls());
const reopen = async (page: Page) => {
  await page.evaluate(() => (window as unknown as { tc: { ui: { close(): void } } }).tc.ui.close());
  await expect(panel(page)).toBeHidden();
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open("delegations"));
  await expect(body(page)).toBeVisible();
};

test("closing and reopening the panel mid-revoke cannot revoke the same grant twice", async ({ page }) => {
  await open(page, { seed: { rows: mockupRows(), revokeDelayMs: 1500 } });
  const box = await openConfirm(page, "Research helper");
  await box.getByRole("button", { name: "Revoke access" }).click();
  await expect.poll(() => revokeCalls(page)).toEqual(["bafyEXAMPLEd4p9ax"]);

  await reopen(page);
  const target = card(page, "Research helper");
  await expect(target).toContainText("Revoking…");
  // The lock is on that grant only: the others stay revocable.
  await expect(target.getByRole("button", { name: /^Revoke access for/ })).toBeDisabled();
  await expect(card(page, "Exo").getByRole("button", { name: /^Revoke access for/ })).toBeEnabled();

  // Not only disabled: forcing the button on and clicking it still opens nothing and calls nothing.
  await target.getByRole("button", { name: /^Revoke access for/ }).evaluate((button: HTMLButtonElement) => {
    button.disabled = false;
    button.click();
  });
  await expect(body(page).locator('[role="alertdialog"]')).toHaveCount(0);
  expect(await revokeCalls(page)).toEqual(["bafyEXAMPLEd4p9ax"]);

  // The first request settles: one receipt, the row is gone, and the latch is clear for another grant.
  await expect(card(page, "Research helper")).toHaveCount(0);
  await expect(slips(page)).toHaveCount(1);
  const again = await openConfirm(page, "Exo");
  await again.getByRole("button", { name: "Revoke access" }).click();
  await expect.poll(() => revokeCalls(page)).toEqual(["bafyEXAMPLEd4p9ax", "bafyEXAMPLEd5c7hs"]);
});

test("a revoke that fails after the panel was reopened shows a toast and can be tried again", async ({ page }) => {
  await open(page, { seed: { rows: mockupRows(), revokeFails: { bafyEXAMPLEd4p9ax: "REVOCATION_FAILED" }, revokeDelayMs: 1000 } });
  const box = await openConfirm(page, "Research helper");
  await box.getByRole("button", { name: "Revoke access" }).click();
  await expect.poll(() => revokeCalls(page)).toEqual(["bafyEXAMPLEd4p9ax"]);
  await reopen(page);

  await expect(page.locator(".tstack .toast")).toContainText("Couldn't revoke this access.");
  await expect(cards(page)).toHaveCount(7);
  const retry = card(page, "Research helper").getByRole("button", { name: /^Revoke access for/ });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(body(page).locator('[role="alertdialog"]')).toBeVisible();
  expect(await revokeCalls(page)).toEqual(["bafyEXAMPLEd4p9ax"]);
});

test("a record with no expiry or creation time says so instead of inventing a value", async ({ page }) => {
  const rows = mockupRows().map((r) => (r.cid === "bafyEXAMPLEd5c7hs" ? { ...r, expiresAt: null, issuedAt: null } : r));
  await open(page, { seed: { rows } });
  const meta = card(page, "Exo").locator(".dl-meta");
  await expect(meta).toHaveText("Personal space · Creation time unknown · Expiry unknown");
  await expect(meta).not.toContainText("No expiry");
  await expect(card(page, "Research helper").locator(".dl-meta")).not.toContainText("unknown");
});

test("a name with braces shows in the confirm and the receipt as written", async ({ page }) => {
  const rows = mockupRows().map((r) => (r.cid === "bafyEXAMPLEd4p9ax" ? { ...r, label: { text: "App {constructor}", source: "stub" as const } } : r));
  await open(page, { seed: { rows } });
  const box = await openConfirm(page, "App {constructor}");
  await expect(box).toContainText("Revoke access for App {constructor}?");
  await box.getByRole("button", { name: "Revoke access" }).click();
  await expect(slips(page)).toContainText("Access revoked");
  await expect(slips(page).locator(".slip")).toContainText("For App {constructor}");
  await expect(slips(page)).not.toContainText("function");
});

test("a later-page row whose answer was lost says to reload, and Reload list reads the first page again", async ({ page }) => {
  const late = laterRow(1);
  await open(page, {
    seed: { rows: mockupRows(), nextCursor: "p2", pages: { p2: { rows: [late] } }, revokeFails: { [late.cid]: "NETWORK_ERROR" }, revokeDelayMs: 50 },
  });
  await body(page).getByRole("button", { name: "Show more" }).click();
  const box = await openConfirm(page, "Late helper 1");
  await box.getByRole("button", { name: "Revoke access" }).click();
  const target = card(page, "Late helper 1");
  await expect(target.getByRole("alert")).toContainText("We couldn't confirm whether this worked. Reload the list and check.");
  await expect(target.getByRole("alert")).not.toContainText("re-read");
  await target.getByRole("button", { name: "Reload list" }).click();
  await expect(card(page, "Late helper 1")).toHaveCount(0);
  await expect(cards(page)).toHaveCount(7);
  await expect(body(page).locator(".sec-title")).toBeFocused();
  await expect(body(page).getByRole("button", { name: "Show more" })).toBeVisible();
});

test("reduced motion removes the row at once", async ({ page }) => {
  await open(page, { reducedMotion: true, seed: { rows: mockupRows() } });
  const box = await openConfirm(page, "Exo");
  await box.getByRole("button", { name: "Revoke access" }).click();
  await expect(card(page, "Exo")).toHaveCount(0);
  expect(await body(page).locator(".dl-leaving").count()).toBe(0);
});
