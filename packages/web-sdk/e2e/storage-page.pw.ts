import { expect, test, type Locator, type Page } from "@playwright/test";
import { row, textRow } from "./fixtures/contrast";
import { routeUiHarness } from "./fixtures/ui-route";

const ORIGIN = "http://tinycloud-ui.test";
const MIB = 1024 * 1024;
const MANAGE = "https://account.tinycloud.xyz/storage";

// Every test fails on an uncaught page error or a console error.
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

type Kind = "normal" | "near" | "full" | "unlimited" | "permission" | "error" | "unsupported";
type Scheme = "light" | "dark";

// The mockup's three spaces for each state (MiB). The sums are its used amounts.
const SPACES: Record<"normal" | "near" | "full", Array<[string, number]>> = {
  normal: [["Personal", 241.8], ["Work", 58.3], ["Shared: lab-notes", 12.3]],
  near: [["Personal", 748.2], ["Work", 148.9], ["Shared: lab-notes", 24.5]],
  full: [["Personal", 801.6], ["Work", 197.4], ["Shared: lab-notes", 25.0]],
};

function seed(kind: Kind): string {
  if (kind === "permission") return JSON.stringify({ storage: { state: "needs-permission", ability: "space/info" } });
  if (kind === "error") return JSON.stringify({ storage: { state: "error", code: "boom" } });
  if (kind === "unsupported") return JSON.stringify({ storage: { state: "error", code: "unsupported" } });
  if (kind === "unlimited") {
    // No limit, and a body that says "full": the page must not.
    return JSON.stringify({
      storage: {
        state: "ready",
        data: { source: "stub", usedBytes: 5 * 1024 * MIB, limitBytes: null, state: "full", manageUrl: MANAGE },
      },
    });
  }
  const spaces = SPACES[kind];
  const used = Math.round(spaces.reduce((sum, [, mib]) => sum + mib, 0) * MIB);
  const limit = 1024 * MIB;
  return JSON.stringify({
    storage: {
      state: "ready",
      data: {
        source: "stub",
        usedBytes: used,
        limitBytes: limit,
        state: kind === "full" ? "full" : kind === "near" ? "nearly_full" : "ok",
        plan: "early access demo",
        manageUrl: MANAGE,
        perSpace: spaces.map(([space, mib]) => ({
          source: "stub",
          space,
          usage: { usedBytes: Math.round(mib * MIB), limitBytes: null },
        })),
      },
    },
  });
}

async function mountHarness(page: Page, scheme: Scheme, kind: Kind, size = { width: 1280, height: 800 }) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize(size);
  await page.addInitScript((value) => {
    (window as unknown as Record<string, unknown>).__TC_STUB_SEED__ = value;
  }, seed(kind));
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
}

const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const storage = (page: Page) => panel(page).locator('section[data-section="storage"]');

async function open(page: Page, layout: "drawer" | "page") {
  await page.evaluate((target) => {
    const ui = (window as unknown as HarnessWindow).tc?.ui;
    if (target === "page") ui?.openPage("storage");
    else ui?.open("storage");
  }, layout);
  await expect(panel(page).locator(".nav-i, .menu-wrap").first()).toBeAttached();
  await expect(storage(page).locator("h3.sec-title")).toBeVisible();
}

async function panelBackground(page: Page): Promise<string> {
  return panel(page).evaluate((el) => getComputedStyle(el).backgroundColor);
}

const SCHEMES: readonly Scheme[] = ["light", "dark"];

for (const scheme of SCHEMES) {
  test.describe(scheme, () => {
    test("sidebar: heading, lede, meter figures, plan, by-space rows from the data", async ({ page }) => {
      await mountHarness(page, scheme, "normal");
      await open(page, "drawer");
      const s = storage(page);
      await expect(s.locator("h3.sec-title")).toHaveText("Storage");
      await expect(s.locator(".storage-lede")).toHaveText("Your storage is shared by every TinyCloud app you use.");
      await expect(s.locator(".storage-fig")).toHaveText("312.4 MiB of 1 GiB");
      await expect(s.locator(".storage-st")).toHaveText("Normal");
      await expect(s.locator(".storage-kv")).toContainText("Early access demo — 1 GiB");
      await expect(s.locator(".storage-kv")).toContainText("711.6 MiB");
      await expect(s.locator(".storage-space")).toHaveCount(3);
      await expect(s.locator(".storage-space").first()).toHaveAttribute("data-source", "stub");
      await expect(s.locator(".storage-updated")).toHaveText("Updated just now");
      await expect(s.locator(".storage-banner")).toHaveCount(0);
    });

    test("full page: the page rail shows the state word for Storage", async ({ page }) => {
      await mountHarness(page, scheme, "near");
      await open(page, "page");
      await expect(panel(page)).toHaveAttribute("data-layout", "page");
      await expect(panel(page).locator('.nav-i[data-section="storage"] .nav-m')).toHaveText("Nearly full");
      await expect(storage(page).locator(".storage-space")).toHaveCount(3);
    });

    test("the meter is a meter: range, value, label and a text alternative", async ({ page }) => {
      await mountHarness(page, scheme, "normal");
      await open(page, "drawer");
      const meter = storage(page).locator('[role="meter"]').first();
      await expect(meter).toHaveAttribute("aria-label", "Storage used");
      await expect(meter).toHaveAttribute("aria-valuemin", "0");
      await expect(meter).toHaveAttribute("aria-valuemax", String(1024 * MIB));
      await expect(meter).toHaveAttribute("aria-valuenow", String(Math.round(312.4 * MIB)));
      await expect(meter).toHaveAttribute("aria-valuetext", "312.4 MiB of 1 GiB used. Normal.");
      // The fill is 312.4/1024 of the track, drawn from the same numbers.
      const widths = await meter.evaluate((el) => {
        const fill = el.querySelector<HTMLElement>(".storage-fill");
        return { fill: fill?.getBoundingClientRect().width ?? 0, track: el.getBoundingClientRect().width };
      });
      expect(widths.fill / widths.track).toBeCloseTo(312.4 / 1024, 2);
      // Each space has its own labelled meter.
      await expect(storage(page).locator('[role="meter"][aria-label="Personal storage used"]')).toHaveAttribute(
        "aria-valuetext",
        "241.8 MiB of 1 GiB",
      );
    });

    test("Manage storage is a link that opens in a new tab and never navigates the app", async ({ page }) => {
      await mountHarness(page, scheme, "normal");
      await open(page, "drawer");
      const link = storage(page).getByRole("link", { name: /Manage storage/ });
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute("href", MANAGE);
      await expect(link).toHaveAttribute("target", "_blank");
      expect(await link.getAttribute("rel")).toMatch(/noopener/);
      expect(await storage(page).getByRole("button", { name: /Manage storage/ }).count()).toBe(0);
      const box = await link.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      // Reachable and visibly focused from the keyboard.
      await link.focus();
      await expect(link).toBeFocused();
      expect(await link.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
    });

    test("nearly full: word and amber dot, one plain note, no banner", async ({ page }) => {
      await mountHarness(page, scheme, "near");
      await open(page, "drawer");
      const s = storage(page);
      await expect(s.locator(".storage-st")).toHaveText("Nearly full");
      await expect(s.locator(".storage-st")).toHaveAttribute("data-tone", "warn");
      await expect(s.locator(".storage-near")).toContainText("You're close to your limit");
      await expect(s.locator(".storage-banner")).toHaveCount(0);
      await expect(s.locator('[role="meter"]').first()).toHaveAttribute("aria-valuetext", /Nearly full\.$/);
    });

    test("full: a banner in plain words with the manage link, and the state word", async ({ page }) => {
      await mountHarness(page, scheme, "full");
      await open(page, "drawer");
      const s = storage(page);
      await expect(s.locator(".storage-st")).toHaveText("Full");
      const banner = s.locator(".storage-banner");
      await expect(banner).toHaveAttribute("role", "status");
      await expect(banner).toContainText("Storage full: you can't add more data right now.");
      await expect(banner).toContainText("Your existing data stays as it is.");
      await expect(banner.getByRole("link", { name: /Manage storage/ })).toHaveAttribute("href", MANAGE);
      await expect(s.locator(".storage-kv")).toContainText("None");
      await expect(s.locator('[role="meter"]').first()).toHaveAttribute("aria-valuenow", String(1024 * MIB));
    });

    test("unlimited never shows the full state: no meter, no Full word, no banner, header and launcher quiet", async ({ page }) => {
      await mountHarness(page, scheme, "unlimited");
      await open(page, "drawer");
      const s = storage(page);
      await expect(s.locator(".storage-fig")).toContainText("No limit");
      await expect(s.locator(".storage-st")).toHaveText("Normal");
      await expect(s.locator('[role="meter"]')).toHaveCount(0);
      await expect(s.locator(".storage-banner")).toHaveCount(0);
      await expect(s).not.toContainText("Full");
      await expect(panel(page).locator(".status")).toBeHidden();
      await expect(page.getByRole("button", { name: "TinyCloud settings", exact: true }).locator(".dot")).toBeHidden();
    });

    test("contrast: the permission card text clears 4.5:1", async ({ page }) => {
      await mountHarness(page, scheme, "permission");
      await open(page, "drawer");
      const s = storage(page);
      const bg = await panelBackground(page);
      const rows = [
        await textRow("card title", s.locator(".storage-ask h4"), bg),
        await textRow("card body", s.locator(".storage-ask p").first(), bg),
        await textRow("card note", s.locator(".storage-ask .note"), bg),
      ];
      for (const r of rows) expect(r.ratio, `${r.label} ${r.ratio}`).toBeGreaterThanOrEqual(4.5);
    });

    test("permission needed: neutral card and no numbers; no button without a request hook", async ({ page }) => {
      await mountHarness(page, scheme, "permission");
      await open(page, "drawer");
      const s = storage(page);
      await expect(s.locator(".storage-ask h4")).toContainText("can't see your storage yet");
      await expect(s.locator(".storage-ask")).toContainText("It can't read, change or delete your files.");
      await expect(s.locator('[role="meter"]')).toHaveCount(0);
      await expect(s.locator(".storage-fig")).toHaveCount(0);
      // The harness client has no authority hook, so there is nothing to press.
      await expect(s.getByRole("button", { name: "Allow storage details" })).toBeHidden();
      await expect(s.locator(".storage-ask .note")).toContainText("no way to ask");
      await expect(panel(page).locator('.nav-i[data-section="storage"]')).toBeVisible();
    });

    test("a node that cannot report usage says so, with no Try again and no numbers", async ({ page }) => {
      await mountHarness(page, scheme, "unsupported");
      await open(page, "drawer");
      const s = storage(page);
      await expect(s.getByText("Storage usage isn't available on this node.")).toBeVisible();
      await expect(s.getByRole("button", { name: "Try again" })).toBeHidden();
      await expect(s.locator('[role="meter"]')).toHaveCount(0);
      await expect(s.locator(".storage-fig")).toHaveCount(0);
    });

    test("error: neutral words and a Try again button that stays reachable", async ({ page }) => {
      await mountHarness(page, scheme, "error");
      await open(page, "drawer");
      const s = storage(page);
      await expect(s.getByText("This didn't load.")).toBeVisible();
      const retry = s.getByRole("button", { name: "Try again" });
      await expect(retry).toBeVisible();
      expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await expect(s.locator('[role="meter"]')).toHaveCount(0);
      await retry.click();
      await expect(s.getByText("This didn't load.")).toBeVisible();
    });

    for (const kind of ["normal", "near", "full"] as const) {
      test(`contrast: ${kind} text clears 4.5:1; meter edge and fill clear 3:1`, async ({ page }) => {
        await mountHarness(page, scheme, kind);
        await open(page, "drawer");
        const s = storage(page);
        const bg = await panelBackground(page);
        const rows = [
          await textRow("lede", s.locator(".storage-lede"), bg),
          await textRow("figure", s.locator(".storage-fig"), bg),
          await textRow("figure small", s.locator(".storage-fig small").first(), bg),
          await textRow("state word", s.locator(".storage-st"), bg),
          await textRow("facts", s.locator(".storage-kv dd").first(), bg),
          await textRow("link", s.locator("a.storage-manage").first(), bg),
          await textRow("updated", s.locator(".storage-updated"), bg),
          await textRow("space name", s.locator(".storage-space .l b").first(), bg),
          await textRow("space heading count", s.locator(".storage-h .cnt"), bg),
        ];
        for (const r of rows) expect(r.ratio, `${r.label} ${r.ratio}`).toBeGreaterThanOrEqual(4.5);
        const meter = s.locator('[role="meter"]').first();
        const parts = await meter.evaluate((el) => {
          const fill = el.querySelector<HTMLElement>(".storage-fill");
          const edge = /rgb\([^)]*\)/.exec(getComputedStyle(el).boxShadow)?.[0] ?? "";
          return {
            track: getComputedStyle(el).backgroundColor,
            edge,
            fill: fill ? getComputedStyle(fill).backgroundColor : "",
          };
        });
        const graphics = [
          row("track edge on panel", parts.edge, bg),
          row("fill on track", parts.fill, parts.track),
        ];
        for (const r of graphics) {
          expect(r.opaque, r.label).toBe(true);
          expect(r.ratio, `${r.label} ${r.ratio}`).toBeGreaterThanOrEqual(3);
        }
        if (kind !== "normal") {
          // The state words carry the meaning; the warn dot's ring is drawn in the dot colour on the panel.
          const dot = await s.locator(".storage-dot").evaluate((el) => getComputedStyle(el).backgroundColor);
          expect(row("warn dot on panel", dot, bg).ratio).toBeGreaterThanOrEqual(3);
        }
        if (kind === "full") {
          const banner = await textRow("banner text", s.locator(".storage-banner"), bg);
          expect(banner.ratio, `banner ${banner.ratio}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }

    test("the fill does not animate when reduced motion is asked for", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await mountHarness(page, scheme, "normal");
      await open(page, "drawer");
      const duration = await storage(page)
        .locator(".storage-fill")
        .first()
        .evaluate((el) => getComputedStyle(el).transitionDuration);
      expect(duration).toBe("0s");
    });
  });
}

for (const size of [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
]) {
  for (const kind of ["normal", "full", "permission", "error"] as const) {
    test(`phone ${size.width}: ${kind} fits, with no clipped text and 44px targets`, async ({ page }) => {
      await mountHarness(page, "light", kind, size);
      await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open("storage"));
      await expect(storage(page).locator("h3.sec-title")).toBeVisible();
      await expect(panel(page)).toHaveAttribute("data-layout", "page");
      const overflow = await storage(page).evaluate((el) => {
        const main = el.closest(".main") ?? el;
        const bad: string[] = [];
        for (const node of el.querySelectorAll<HTMLElement>("*")) {
          const box = node.getBoundingClientRect();
          if (box.width > 0 && (box.right > main.getBoundingClientRect().right + 0.5 || box.left < -0.5)) {
            bad.push(`${node.className || node.tagName} ${Math.round(box.right)}`);
          }
        }
        return { bad, scroll: main.scrollWidth - main.clientWidth };
      });
      expect(overflow.bad).toEqual([]);
      expect(overflow.scroll).toBeLessThanOrEqual(0);
      const targets: Locator = storage(page).locator("a.storage-manage:visible, button:visible");
      const count = await targets.count();
      for (let i = 0; i < count; i += 1) {
        const box = await targets.nth(i).boundingBox();
        expect(box?.height, `target ${i}`).toBeGreaterThanOrEqual(44);
      }
      if (kind === "full") {
        await expect(storage(page).getByRole("link", { name: /Manage storage/ }).last()).toBeVisible();
      }
    });
  }
}
