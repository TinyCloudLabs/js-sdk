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

async function openDrawer(page: Page, section?: string) {
  await page.evaluate((s) => (window as unknown as HarnessWindow).tc?.ui.open(s), section);
}

async function openPageLayout(page: Page, section?: string) {
  await page.evaluate((s) => (window as unknown as HarnessWindow).tc?.ui.openPage(s), section);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme}`, () => {
    test("open() shows a non-modal drawer with the signed-in nav and Overview active", async ({ page }) => {
      await mountHarness(page, scheme);
      await openDrawer(page);

      const dialog = panel(page);
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("role", "dialog");
      await expect(dialog).toHaveAttribute("aria-modal", "false");
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

      // The launcher sits outside the panel element, so its keydown must not
      // reach the panel's Escape handler.
      await launcher(page).focus();
      await page.keyboard.press("Escape");

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
      await expect(dialog.getByRole("button", { name: "Show as sidebar", exact: true })).toHaveCount(0);
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

  test("the panel is a non-modal dialog outside the top layer", async ({ page }) => {
    await mountHarness(page, "light");
    await openDrawer(page);
    const state = await panel(page).evaluate((el) => ({
      modal: el.matches(":modal"),
      ariaModal: el.getAttribute("aria-modal"),
      role: el.getAttribute("role"),
      label: el.getAttribute("aria-label"),
    }));
    expect(state).toEqual({ modal: false, ariaModal: "false", role: "dialog", label: "TinyCloud settings" });
  });

  test("launcher is at least 44px square", async ({ page }) => {
    await mountHarness(page, "light");
    const box = await launcher(page).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  });

  test("phone drawer nav items and head actions are at least 44px tall", async ({ page }) => {
    await mountHarness(page, "light");
    await page.setViewportSize({ width: 390, height: 844 });
    await openDrawer(page);
    const targets = panel(page).locator(".nav-i:visible, .head-actions button:visible");
    const count = await targets.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await targets.nth(i).boundingBox();
      expect(box, `target ${i}`).not.toBeNull();
      expect(box!.height, `target ${i} height`).toBeGreaterThanOrEqual(44);
    }
  });

  test("the drawer animates in when reduced motion is not requested", async ({ page }) => {
    await mountHarness(page, "light");
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
