import { expect, test, type Page } from "@playwright/test";
import { textRow } from "./fixtures/contrast";
import { defaultDocument, routeUiHarness } from "./fixtures/ui-route";

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
  tc?: {
    ui: {
      open(section?: string): void;
      openPage(section?: string): void;
    };
  };
}

async function mountHarness(page: Page, scheme: "light" | "dark", ui?: Record<string, unknown>) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate((option) => (window as unknown as HarnessWindow).__tc.mount(option), ui);
}

const launcher = (page: Page) => page.getByRole("button", { name: "TinyCloud settings", exact: true });
const panel = (page: Page) => page.locator("#tinycloud-ui-panel");

// open() returns before the lazy panel mounts; wait for its nav so later counts see the real shell.
async function openDrawer(page: Page, section?: string) {
  await page.evaluate((s) => (window as unknown as HarnessWindow).tc?.ui.open(s), section);
  await expect(panel(page).locator(".nav-i").first()).toBeAttached();
}

// A box measured while the slide-in runs carries float error from the transform (43.99997 for a 44px
// target). Measure once the panel's animations have finished.
async function slideSettled(page: Page) {
  await panel(page).evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)).then(() => undefined));
}

async function openPageLayout(page: Page, section?: string) {
  await page.evaluate((s) => (window as unknown as HarnessWindow).tc?.ui.openPage(s), section);
  await expect(panel(page).locator(".nav-i").first()).toBeAttached();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme}`, () => {
    test("open() shows a modal drawer with the signed-in nav and Overview active", async ({ page }) => {
      await mountHarness(page, scheme);
      await openDrawer(page);

      const dialog = panel(page);
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("role", "dialog");
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      await expect(dialog).toHaveAttribute("aria-label", "TinyCloud settings");
      await expect(dialog).toHaveAttribute("data-layout", "drawer");

      // The harness is signed in and developer mode is on, so Activity is offered last.
      await expect(dialog.locator(".nav-l")).toHaveText(["Overview", "Local TinyCloud", "Local copy", "Delegations", "Nodes", "Storage", "Activity"]);
      await expect(dialog.getByRole("button", { name: "Activity", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(dialog.locator('section[data-section="account"]')).toBeVisible();
    });

    test("Activity is not offered when developer mode is off", async ({ page }) => {
      await mountHarness(page, scheme, { developerMode: false });
      await openDrawer(page);

      await expect(panel(page).locator(".nav-l")).toHaveText(["Overview", "Local TinyCloud", "Local copy", "Delegations", "Nodes", "Storage"]);
      await expect(panel(page).getByRole("button", { name: "Activity", exact: true })).toHaveCount(0);
    });

    test("nav switches the visible section and moves aria-current", async ({ page }) => {
      await mountHarness(page, scheme);
      await openDrawer(page);

      const dialog = panel(page);
      await dialog.getByRole("button", { name: "Nodes", exact: true }).click();

      await expect(dialog.getByRole("button", { name: "Nodes", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(dialog.getByRole("button", { name: "Overview", exact: true })).not.toHaveAttribute("aria-current", "page");
      await expect(dialog.locator('section[data-section="nodes"]')).toBeVisible();
      await expect(dialog.locator('section[data-section="account"]')).toBeHidden();
    });

    test("open(section) selects the named section", async ({ page }) => {
      await mountHarness(page, scheme);
      await openDrawer(page, "storage");

      await expect(panel(page).locator('section[data-section="storage"]')).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "Storage", exact: true })).toHaveAttribute("aria-current", "page");
    });

    test("Escape on the panel closes it and returns focus to the launcher", async ({ page }) => {
      await mountHarness(page, scheme);
      await openDrawer(page);

      const dialog = panel(page);
      await dialog.getByRole("button", { name: "Overview", exact: true }).focus();
      await page.keyboard.press("Escape");

      await expect(dialog).toBeHidden();
      await expect(launcher(page)).toBeFocused();
    });

    test("Escape outside the panel does not close it", async ({ page }) => {
      await mountHarness(page, scheme);
      await openDrawer(page);

      // The launcher sits outside the panel element, so its keydown must not reach the panel's Escape handler.
      // The modal drawer no longer lets the launcher hold focus, so the keydown is dispatched on it.
      await launcher(page).dispatchEvent("keydown", { key: "Escape", bubbles: true, composed: true });

      await expect(panel(page)).toBeVisible();
    });

    test("page layout toggles to the sidebar and back", async ({ page }) => {
      await mountHarness(page, scheme);
      await openPageLayout(page);

      const dialog = panel(page);
      await expect(dialog).toHaveAttribute("data-layout", "page");

      await dialog.getByRole("button", { name: "Show as sidebar", exact: true }).click();
      await expect(dialog).toHaveAttribute("data-layout", "drawer");

      await dialog.getByRole("button", { name: "Open full page", exact: true }).click();
      await expect(dialog).toHaveAttribute("data-layout", "page");
    });

    test("ui.mode sidebar keeps the drawer and hides the page control", async ({ page }) => {
      await mountHarness(page, scheme, { mode: "sidebar" });
      await openPageLayout(page);

      const dialog = panel(page);
      await expect(dialog).toHaveAttribute("data-layout", "drawer");
      await expect(dialog.getByRole("button", { name: "Open full page", exact: true })).toHaveCount(0);
    });

    test("ui.mode page opens the full-page layout without a sidebar control", async ({ page }) => {
      await mountHarness(page, scheme, { mode: "page" });
      await openDrawer(page);

      const dialog = panel(page);
      await expect(dialog).toHaveAttribute("data-layout", "page");
      await expect(dialog.getByRole("button", { name: "Sidebar", exact: true })).toHaveCount(0);
    });
  });
}

test.describe("host layer, targets, and motion", () => {
  test("host root is a fixed, isolated, pointer-transparent layer with an open shadow root", async ({ page }) => {
    await mountHarness(page, "light");
    await openDrawer(page);
    const layer = await panel(page).evaluate((el) => {
      const root = el.getRootNode() as ShadowRoot;
      const cs = getComputedStyle(root.host);
      return {
        shadowMode: root.mode,
        position: cs.position,
        inset: [cs.top, cs.right, cs.bottom, cs.left],
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        isolation: cs.isolation,
      };
    });
    expect(layer).toEqual({
      shadowMode: "open",
      position: "fixed",
      inset: ["0px", "0px", "0px", "0px"],
      pointerEvents: "none",
      zIndex: "999990",
      isolation: "isolate",
    });
  });

  test("the drawer is an aria-modal dialog outside the top layer", async ({ page }) => {
    await mountHarness(page, "light");
    await openDrawer(page);
    const state = await panel(page).evaluate((el) => ({
      modal: el.matches(":modal"),
      ariaModal: el.getAttribute("aria-modal"),
      role: el.getAttribute("role"),
      label: el.getAttribute("aria-label"),
    }));
    expect(state).toEqual({ modal: false, ariaModal: "true", role: "dialog", label: "TinyCloud settings" });
  });

  test("launcher is at least 44px square", async ({ page }) => {
    await mountHarness(page, "light");
    const box = await launcher(page).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  });

  test("phone full page: opens as the page, targets at least 44px tall", async ({ page }) => {
    await mountHarness(page, "light");
    await page.setViewportSize({ width: 390, height: 844 });
    await openDrawer(page);
    await expect(panel(page)).toHaveAttribute("data-layout", "page");
    await slideSettled(page);
    const targets = panel(page).locator(".nav-i:visible, .head-actions button:visible");
    const count = await targets.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await targets.nth(i).boundingBox();
      expect(box, `target ${i}`).not.toBeNull();
      expect(box!.height, `target ${i} height`).toBeGreaterThanOrEqual(44);
    }
  });

  test("a resize across the phone breakpoint keeps the open section", async ({ page }) => {
    await mountHarness(page, "light");
    await openDrawer(page);
    await panel(page).locator(".nav-i", { hasText: "Nodes" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel(page)).toHaveAttribute("data-layout", "page");
    await expect(panel(page).locator(".menu-i", { hasText: "Nodes" })).toHaveAttribute("aria-current", "page");
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(panel(page)).toHaveAttribute("data-layout", "drawer");
    await expect(panel(page).locator(".nav-i", { hasText: "Nodes" })).toHaveAttribute("aria-current", "page");
  });

  test.describe("phone section menu", () => {
    const menuButton = (page: Page) => panel(page).getByRole("button", { name: "Sections", exact: true });
    const menuItems = (page: Page) => panel(page).locator(".menu-i");
    // Focus lands on the section heading when rendered, else on the section container; both are inside `.main` with tabindex -1.
    const focusInMain = (page: Page) =>
      panel(page).locator(".main").evaluate((main) => {
        const active = (main.getRootNode() as ShadowRoot | Document).activeElement;
        return main.contains(active) && active?.getAttribute("tabindex") === "-1";
      });

    test("at 390 and 360px the pills are gone and the menu lists every section without clipping", async ({ page }) => {
      await mountHarness(page, "light");
      await openDrawer(page);
      const sections = await panel(page).locator(".nav-i").count();
      expect(sections).toBeGreaterThanOrEqual(7);
      for (const width of [390, 360]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(panel(page).locator(".nav-i").first()).toBeHidden();
        await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
        await slideSettled(page);
        const trigger = await menuButton(page).boundingBox();
        expect(trigger!.width, `${width}px trigger width`).toBeGreaterThanOrEqual(44);
        expect(trigger!.height, `${width}px trigger height`).toBeGreaterThanOrEqual(44);
        await menuButton(page).click();
        await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
        await expect(menuItems(page)).toHaveCount(sections);
        for (let i = 0; i < sections; i += 1) {
          const item = menuItems(page).nth(i);
          const box = await item.boundingBox();
          expect(box, `${width}px item ${i}`).not.toBeNull();
          expect(box!.height, `${width}px item ${i} height`).toBeGreaterThanOrEqual(44);
          expect(box!.x + box!.width, `${width}px item ${i} overflows the viewport`).toBeLessThanOrEqual(width);
          const clipped = await item.evaluate((el) => el.scrollWidth > el.clientWidth);
          expect(clipped, `${width}px item ${i} label is clipped`).toBe(false);
        }
        await menuButton(page).click();
        await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
      }
    });

    test("on phones the layout switch is absent and the panel is a full page", async ({ page }) => {
      await mountHarness(page, "light");
      await page.setViewportSize({ width: 390, height: 844 });
      await openDrawer(page);
      const dialog = panel(page);
      await expect(dialog).toHaveAttribute("data-layout", "page");
      await expect(dialog.getByRole("button", { name: "Open full page", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Show as sidebar", exact: true })).toHaveCount(0);
    });

    test("keyboard: Enter opens the menu, Enter on a section closes it and moves focus into the section", async ({ page }) => {
      await mountHarness(page, "light");
      await page.setViewportSize({ width: 390, height: 844 });
      await openDrawer(page);
      await menuButton(page).focus();
      await page.keyboard.press("Enter");
      await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
      await menuItems(page).filter({ hasText: "Nodes" }).focus();
      await page.keyboard.press("Enter");
      await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
      await expect(menuItems(page).filter({ hasText: "Nodes" })).toHaveAttribute("aria-current", "page");
      await expect.poll(() => focusInMain(page)).toBe(true);
    });

    test("Escape closes the menu first and the page on the second press", async ({ page }) => {
      await mountHarness(page, "light");
      await page.setViewportSize({ width: 390, height: 844 });
      await openDrawer(page);
      await menuButton(page).focus();
      await page.keyboard.press("Enter");
      await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
      await expect(panel(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(panel(page)).toBeHidden();
    });

    test("focus leaving the menu closes it", async ({ page }) => {
      await mountHarness(page, "light");
      await page.setViewportSize({ width: 390, height: 844 });
      await openDrawer(page);
      await menuButton(page).click();
      await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
      await panel(page).locator(".menu").evaluate((menu) => ((menu.getRootNode() as ShadowRoot).activeElement as HTMLElement | null)?.blur());
      await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
    });

    test("desktop keeps the rail and hides the menu trigger at 1280px", async ({ page }) => {
      await mountHarness(page, "light");
      await openDrawer(page);
      await expect(panel(page).locator(".nav-i").first()).toBeVisible();
      await expect(menuButton(page)).toBeHidden();
    });

    test.describe("touch", () => {
      test.use({ hasTouch: true });

      test("touch: tapping the trigger and a section works", async ({ page }) => {
        await mountHarness(page, "light");
        await page.setViewportSize({ width: 390, height: 844 });
        await openDrawer(page);
        await menuButton(page).tap();
        await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
        await menuItems(page).filter({ hasText: "Nodes" }).tap();
        await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
        await expect(menuItems(page).filter({ hasText: "Nodes" })).toHaveAttribute("aria-current", "page");
      });
    });
  });

  // Test-only: stretch the slide-in to 4 s inside the shadow root so a loaded machine cannot finish it
  // before the spec samples it. `!important` beats the panel's own duration whenever its stylesheet lands,
  // and it leaves `animation-name` alone, so reduced motion (`animation:none`) still means no animation.
  async function slowAnimations(page: Page) {
    await page.evaluate(() => {
      const root = document.querySelector("[data-tinycloud-ui]")?.shadowRoot;
      const style = document.createElement("style");
      style.textContent = "*{animation-duration:4s !important}";
      root?.append(style);
    });
  }

  test("the drawer animates in when reduced motion is not requested", async ({ page }) => {
    await mountHarness(page, "light");
    await slowAnimations(page);
    await openDrawer(page);
    const running = await panel(page).evaluate((el) => el.getAnimations().length);
    expect(running).toBeGreaterThan(0);
  });

  test.describe("with reduced motion", () => {
    test.use({ reducedMotion: "reduce" });

    test("the drawer opens without an animation", async ({ page }) => {
      await mountHarness(page, "light");
      await page.emulateMedia({ reducedMotion: "reduce" });
      const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
      expect(reduced).toBe(true);
      await slowAnimations(page);
      await openDrawer(page);
      await expect(panel(page)).toBeVisible();
      const running = await panel(page).evaluate((el) => el.getAnimations().length);
      expect(running).toBe(0);
    });
  });
});

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: shell text clears 4.5:1 against the panel (WCAG 1.4.3)`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openDrawer(page);
    await expect(panel(page).locator("h2.title")).toBeVisible();
    const background = await panel(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    const rows = [
      await textRow("title", panel(page).locator("h2.title"), background),
      await textRow("status", panel(page).locator("span.status"), background),
      await textRow("active nav", panel(page).locator('.nav-i[aria-current="page"] .nav-l'), background),
      await textRow("inactive nav", panel(page).locator('.nav-i:not([aria-current="page"]) .nav-l').first(), background),
    ];
    expect(rows.filter((r) => !r.opaque || r.ratio < 4.5)).toEqual([]);
  });
}

for (const [name, path] of [
  ["same-origin frame", "/framed"],
  ["sandboxed frame", "/sandboxed"],
] as const) {
  test(`nothing renders inside a ${name}`, async ({ page }) => {
    await routeUiHarness(page, (requestPath) => defaultDocument(requestPath === "/framed" ? '<iframe src="/"></iframe>' : requestPath === "/sandboxed" ? '<iframe sandbox="allow-scripts" src="/"></iframe>' : ""));
    await page.goto(`${ORIGIN}${path}`);
    const handle = await page.locator("iframe").elementHandle();
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error("iframe has no content frame");
    await frame.waitForFunction(() => typeof (window as unknown as HarnessWindow).__tc !== "undefined");
    await frame.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
    expect(await frame.getByRole("button", { name: "TinyCloud settings", exact: true }).count()).toBe(0);
    expect(await frame.evaluate(() => [...document.querySelectorAll("*")].filter((e) => e.shadowRoot).length)).toBe(0);
    await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
    await expect(page.getByRole("button", { name: "TinyCloud settings", exact: true })).toHaveCount(1);
  });
}
