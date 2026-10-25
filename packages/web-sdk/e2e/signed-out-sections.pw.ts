import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { loadBuild, routeUiHarness } from "./fixtures/ui-route";

// Signed out, every section must end in a settled outcome (its signed-out or unavailable state, or not be
// offered so the panel falls back to Overview), never a loading line or spinner that does not end.
// The data here is the production wiring: the lazy proxy, which answers `loading` until something arms it,
// and nothing arms it for a signed-out client. Built by `bun run build:e2e-prefetch`.
const ORIGIN = "http://tinycloud-ui.test";
const ENTRY = "prefetch-harness-entry.js";
const FILES = loadBuild(resolve("e2e/.build/prefetch"));

// Every test fails on a page or console error.
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
    mount(options?: { developerMode?: boolean; signedIn?: boolean }): number;
    arm(): Promise<boolean>;
    signOut(): boolean;
  };
  tc?: { ui: { open(section?: string): void; close(): void } };
}

type SectionId = "account" | "local-tinycloud" | "local-copy" | "delegations" | "nodes" | "storage" | "activity";
const SECTIONS: readonly SectionId[] = [
  "account",
  "local-tinycloud",
  "local-copy",
  "delegations",
  "nodes",
  "storage",
  "activity",
];
// Needs a signed-in client, so a signed-out panel does not offer it and open() falls back to Overview.
const NOT_OFFERED_SIGNED_OUT: ReadonlySet<SectionId> = new Set(["delegations", "storage"]);

const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const body = (page: Page) => panel(page).locator("section.section");

async function boot(page: Page, options: { signedIn: boolean }) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeUiHarness(
    page,
    () => `<!doctype html><html><body><script type="module" src="/${ENTRY}"></script></body></html>`,
    FILES,
  );
  await page.goto(`${ORIGIN}/`);
  // Developer mode on, so Activity is a section too.
  await page.evaluate((o) => (window as unknown as HarnessWindow).__tc.mount({ developerMode: true, ...o }), options);
}

async function open(page: Page, section?: SectionId) {
  await page.evaluate((s) => (window as unknown as HarnessWindow).tc?.ui.open(s), section);
  await expect(panel(page).locator(".nav-i").first()).toBeAttached();
  await expect(body(page)).toBeVisible();
}

interface Outcome {
  readonly section: string;
  readonly text: string;
  readonly loading: boolean;
}

/** What the open section shows now: its id, its visible text, and whether any of it is a loading line or spinner. */
function outcome(page: Page): Promise<Outcome> {
  return body(page).evaluate((el) => {
    const text = (el as HTMLElement).innerText.replace(/\s+/g, " ").trim();
    const spinning = [...el.querySelectorAll('[class*="spin"]')].some((node) => (node as HTMLElement).offsetParent !== null);
    return {
      section: (el as HTMLElement).dataset.section ?? "",
      text,
      loading: spinning || /\b(Loading|Looking for|Checking)\b/i.test(text),
    };
  });
}

/** Waits out the settle time: the outcome must stop loading and say something. */
async function expectSettled(page: Page, section: SectionId): Promise<Outcome> {
  await expect
    .poll(async () => {
      const o = await outcome(page);
      return !o.loading && o.text.length > 0;
    }, { timeout: 4000, intervals: [250], message: `${section} is still loading` })
    .toBe(true);
  return outcome(page);
}

for (const section of SECTIONS) {
  test.describe(section, () => {
    test("(a) a panel opened signed out settles: the section is signed-out or unavailable, or not offered", async ({ page }) => {
      await boot(page, { signedIn: false });
      await open(page);
      const navIds = await panel(page).locator(".nav-i").evaluateAll((items) => items.map((i) => (i as HTMLElement).dataset.section));
      expect(navIds.includes(section)).toBe(!NOT_OFFERED_SIGNED_OUT.has(section));
      // Go to this section if it is offered; otherwise the panel shows Overview.
      if (navIds.includes(section) && section !== "account") {
        await panel(page).locator(`.nav-i[data-section="${section}"]`).click();
      }
      const o = await expectSettled(page, section);
      expect(o.section).toBe(NOT_OFFERED_SIGNED_OUT.has(section) ? "account" : section);
      if (section === "account") expect(o.text).toContain("signed out");
    });

    test("(b) a deep link to the section signed out settles the same way, falling back to Overview when it is not offered", async ({ page }) => {
      await boot(page, { signedIn: false });
      await open(page, section);
      const o = await expectSettled(page, section);
      if (NOT_OFFERED_SIGNED_OUT.has(section)) {
        expect(o.section).toBe("account");
        expect(o.text).toContain("signed out");
      } else {
        expect(o.section).toBe(section);
      }
    });

    test("(c) signing out while the section is open closes the panel, and reopening it settles", async ({ page }) => {
      await boot(page, { signedIn: true });
      await page.evaluate(() => (window as unknown as HarnessWindow).__tc.arm());
      await open(page, section);
      await page.evaluate(() => (window as unknown as HarnessWindow).__tc.signOut());
      await expect(panel(page)).toBeHidden();
      await open(page, section);
      const o = await expectSettled(page, section);
      expect(o.section).toBe(NOT_OFFERED_SIGNED_OUT.has(section) ? "account" : section);
    });
  });
}
