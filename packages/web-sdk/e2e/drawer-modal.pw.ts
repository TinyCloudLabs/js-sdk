import { expect, test, type Page } from "@playwright/test";
import { routeUiHarness } from "./fixtures/ui-route";

// The drawer is modal on desktop: a scrim dims the page, Tab and focus stay in the panel, Escape and a click on the
// scrim close it, and focus goes back to where it was. The page layout and phones are unchanged.
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
  __tc: { mount(ui?: Record<string, unknown>): boolean; toast(kind: string): string | null; openPermission(appName?: string): boolean; openSpaceCreation(): boolean };
  __permResult?: boolean;
  __spaceResult?: boolean;
  tc?: { ui: { open(section?: string): void; openPage(section?: string): void } };
}

const DOCUMENT = `<!doctype html><html><body style="margin:0"><button id="page-btn">Page button</button> <a href="#x" id="page-link">Page link</a><script type="module" src="/harness-entry.js"></script></body></html>`;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const launcher = (page: Page) => page.getByRole("button", { name: "TinyCloud settings", exact: true });

async function mount(page: Page, scheme: "light" | "dark" = "light", viewport = DESKTOP, reducedMotion = false) {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await page.setViewportSize(viewport);
  await routeUiHarness(page, () => DOCUMENT);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
}

async function openDrawer(page: Page) {
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open());
  await expect(panel(page).locator(".nav-i").first()).toBeAttached();
  // Boxes and focus are read once the slide-in has finished.
  await panel(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
}

async function openPageLayout(page: Page) {
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.openPage());
  await expect(panel(page).locator(".nav-i").first()).toBeAttached();
}

/** Where focus is: `page:<id>` on the host page, else `<area>:<name>` inside the TinyCloud layer. */
const focusAt = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const host = document.querySelector("[data-tinycloud-ui]") as HTMLElement;
    const outer = document.activeElement as HTMLElement | null;
    if (outer !== host) return `page:${outer?.id || outer?.tagName}`;
    const inner = host.shadowRoot?.activeElement as HTMLElement | null;
    if (!inner) return "layer:none";
    const area = inner.closest("#tinycloud-ui-panel")
      ? "panel"
      : inner.closest(".tstack")
        ? "toast"
        : inner.classList.contains("button")
          ? "launcher"
          : "layer";
    const mark = inner.dataset.e2e;
    return `${area}:${mark ?? inner.getAttribute("aria-label") ?? inner.textContent?.trim().slice(0, 30)}`;
  });

/** The host's active element must be the prompt itself, with focus inside its shadow dialog. */
const focusInPrompt = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((promptSelector) => {
    const root = (document.querySelector("[data-tinycloud-ui]") as HTMLElement).shadowRoot as ShadowRoot;
    const prompt = root.querySelector<HTMLElement>(promptSelector);
    return Boolean(prompt && root.activeElement === prompt && prompt.shadowRoot?.activeElement);
  }, selector);

/** Marks the first and last control Tab visits (panel, then toasts) and returns how many there are. */
const markEnds = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const root = (document.querySelector("[data-tinycloud-ui]") as HTMLElement).shadowRoot as ShadowRoot;
    const sel = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
    const all = [
      ...Array.from(root.querySelectorAll<HTMLElement>(`#tinycloud-ui-panel ${sel.split(",").join(",#tinycloud-ui-panel ")}`)),
      ...Array.from(root.querySelectorAll<HTMLElement>(`.tstack ${sel.split(",").join(",.tstack ")}`)),
    ].filter((el) => el.checkVisibility({ visibilityProperty: true }));
    for (const el of all) delete el.dataset.e2e;
    all[0]?.setAttribute("data-e2e", "first");
    all[all.length - 1]?.setAttribute("data-e2e", "last");
    return all.length;
  });

const focusMarked = (page: Page, mark: "first" | "last") =>
  page.evaluate((which) => {
    const root = (document.querySelector("[data-tinycloud-ui]") as HTMLElement).shadowRoot as ShadowRoot;
    (root.querySelector(`[data-e2e="${which}"]`) as HTMLElement).focus();
  }, mark);

const scrimStyle = (page: Page) =>
  page.evaluate(() => {
    const root = (document.querySelector("[data-tinycloud-ui]") as HTMLElement).shadowRoot as ShadowRoot;
    const cs = getComputedStyle(root.querySelector(".scrim") as HTMLElement);
    return {
      color: cs.backgroundColor,
      opacity: cs.opacity,
      visibility: cs.visibility,
      pointerEvents: cs.pointerEvents,
      transition: cs.transitionDuration,
    };
  });

/** True when a click at the point lands on the TinyCloud host (the scrim) rather than the host page. */
const hostCatches = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => document.elementFromPoint(px as number, py as number)?.hasAttribute("data-tinycloud-ui") === true, [x, y]);

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test("the drawer dims the page with the overlay colour and only then takes pointer events", async ({ page }) => {
      await mount(page, scheme);
      // Closed: no panel code has loaded, nothing dims, and the page gets every click.
      await expect(page.locator(".scrim")).toHaveCount(0);
      expect(await hostCatches(page, 100, 400)).toBe(false);

      await openDrawer(page);
      await expect
        .poll(() => scrimStyle(page))
        .toMatchObject({
          color: scheme === "light" ? "rgba(9, 9, 11, 0.4)" : "rgba(0, 0, 0, 0.6)",
          opacity: "1",
          visibility: "visible",
          pointerEvents: "auto",
        });
      expect(await hostCatches(page, 100, 400)).toBe(true);
    });
  });
}

test("the full page and a phone have no scrim, and their dialog is not aria-modal", async ({ page }) => {
  await mount(page);
  await openPageLayout(page);
  await expect(panel(page)).toHaveAttribute("data-layout", "page");
  await expect(panel(page)).toHaveAttribute("aria-modal", "false");
  await expect.poll(() => scrimStyle(page)).toMatchObject({ opacity: "0", visibility: "hidden", pointerEvents: "none" });

  await page.setViewportSize(PHONE);
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open());
  await expect(panel(page)).toHaveAttribute("data-layout", "page");
  await expect(panel(page)).toHaveAttribute("aria-modal", "false");
  await expect.poll(() => scrimStyle(page)).toMatchObject({ opacity: "0", visibility: "hidden", pointerEvents: "none" });
});

test("switching drawer to page and back moves the scrim, aria-modal and the focus trap with the layout", async ({ page }) => {
  await mount(page);
  await openDrawer(page);
  await expect(panel(page)).toHaveAttribute("aria-modal", "true");
  await expect.poll(() => scrimStyle(page)).toMatchObject({ opacity: "1", pointerEvents: "auto" });

  await panel(page).locator(".layout-switch").click();
  await expect(panel(page)).toHaveAttribute("data-layout", "page");
  await expect(panel(page)).toHaveAttribute("aria-modal", "false");
  await expect.poll(() => scrimStyle(page)).toMatchObject({ opacity: "0", visibility: "hidden", pointerEvents: "none" });
  // The trap is off: Tab from the last control leaves the panel, and the page can take focus.
  await markEnds(page);
  await focusMarked(page, "last");
  await page.keyboard.press("Tab");
  expect(await focusAt(page)).not.toMatch(/^(panel|toast):/);
  await page.evaluate(() => document.getElementById("page-btn")?.focus());
  expect(await focusAt(page)).toBe("page:page-btn");

  await panel(page).locator(".layout-switch").click();
  await expect(panel(page)).toHaveAttribute("data-layout", "drawer");
  await expect(panel(page)).toHaveAttribute("aria-modal", "true");
  await expect.poll(() => scrimStyle(page)).toMatchObject({ opacity: "1", pointerEvents: "auto" });
  // The trap is back: focus on the page is pulled into the panel.
  await page.evaluate(() => document.getElementById("page-btn")?.focus());
  expect(await focusAt(page)).toMatch(/^panel:/);
});

test.describe("closing", () => {
  test("a click on the dimmed page closes the drawer and returns focus to the page element that had it", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => document.getElementById("page-btn")?.focus());
    await openDrawer(page);
    expect(await focusAt(page)).toMatch(/^panel:/);

    await page.mouse.click(100, 400);
    await expect(panel(page)).toBeHidden();
    expect(await focusAt(page)).toBe("page:page-btn");
    await expect.poll(() => scrimStyle(page)).toMatchObject({ opacity: "0", pointerEvents: "none" });
  });

  test("opened from the launcher, a click on the scrim returns focus to the launcher", async ({ page }) => {
    await mount(page);
    await launcher(page).click();
    await expect(panel(page).locator(".nav-i").first()).toBeAttached();
    await page.mouse.click(100, 400);
    await expect(panel(page)).toBeHidden();
    await expect(launcher(page)).toBeFocused();
  });

  test("Escape closes the drawer and returns focus to the page element that had it", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => document.getElementById("page-link")?.focus());
    await openDrawer(page);
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
    expect(await focusAt(page)).toBe("page:page-link");
  });

  test("the close control returns focus too", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => document.getElementById("page-btn")?.focus());
    await openDrawer(page);
    await panel(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel(page)).toBeHidden();
    expect(await focusAt(page)).toBe("page:page-btn");
  });

  test("aria-modal follows the visible drawer through close, reopen, page, and phone", async ({ page }) => {
    await mount(page);
    await openDrawer(page);
    await expect(panel(page)).toHaveAttribute("aria-modal", "true");
    await panel(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect(panel(page)).toBeHidden();
    await expect(panel(page)).toHaveAttribute("aria-modal", "false");
    await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open());
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute("aria-modal", "true");
    await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.openPage());
    await expect(panel(page)).toHaveAttribute("aria-modal", "false");
    await page.setViewportSize(PHONE);
    await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open());
    await expect(panel(page)).toHaveAttribute("aria-modal", "false");
  });

  test("an element the page removed while the drawer was open falls back to the launcher", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => document.getElementById("page-btn")?.focus());
    await openDrawer(page);
    await page.evaluate(() => document.getElementById("page-btn")?.remove());
    await page.keyboard.press("Escape");
    await expect(launcher(page)).toBeFocused();
  });

  test("closing the page layout still returns focus to the launcher", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => document.getElementById("page-btn")?.focus());
    await openPageLayout(page);
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
    await expect(launcher(page)).toBeFocused();
  });
});

test.describe("focus trap", () => {
  test("Tab from the last control goes to the first, and Shift+Tab from the first goes to the last", async ({ page }) => {
    await mount(page);
    await openDrawer(page);
    expect(await markEnds(page)).toBeGreaterThan(3);

    await focusMarked(page, "last");
    await page.keyboard.press("Tab");
    expect(await focusAt(page)).toBe("panel:first");

    await focusMarked(page, "first");
    await page.keyboard.press("Shift+Tab");
    expect(await focusAt(page)).toBe("panel:last");
  });

  test("Tab only ever lands on the panel while the drawer is open", async ({ page }) => {
    await mount(page);
    await openDrawer(page);
    const total = await markEnds(page);
    const seen = new Set<string>();
    for (let i = 0; i < total * 2 + 2; i++) {
      await page.keyboard.press("Tab");
      const at = await focusAt(page);
      expect(at).toMatch(/^panel:/);
      seen.add(at);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  test("focus that reaches the page or the launcher is pulled back into the panel", async ({ page }) => {
    await mount(page);
    await openDrawer(page);
    await page.evaluate(() => document.getElementById("page-btn")?.focus());
    expect(await focusAt(page)).toMatch(/^panel:/);
    await page.evaluate(() => document.getElementById("page-link")?.focus());
    expect(await focusAt(page)).toMatch(/^panel:/);
    await launcher(page).evaluate((el) => el.focus());
    expect(await focusAt(page)).toMatch(/^panel:/);
  });

  test("a toast stays reachable: its dismiss control joins the cycle, and Escape from it closes the drawer", async ({ page }) => {
    await mount(page);
    await openDrawer(page);
    await page.evaluate(() => (window as unknown as HarnessWindow).__tc.toast("info"));
    await expect(page.locator(".tstack .toast")).toHaveCount(1);
    await markEnds(page);

    // The toast's control comes after the panel's last control, then the cycle wraps.
    await expect(page.locator(".tstack .toast__close")).toHaveAttribute("data-e2e", "last");
    await page.evaluate(() => {
      const root = (document.querySelector("[data-tinycloud-ui]") as HTMLElement).shadowRoot as ShadowRoot;
      const panelControls = Array.from(root.querySelectorAll<HTMLElement>("#tinycloud-ui-panel button")).filter((b) => b.checkVisibility({ visibilityProperty: true }));
      panelControls[panelControls.length - 1]?.focus();
    });
    await page.keyboard.press("Tab");
    expect(await focusAt(page)).toBe("toast:last");
    await page.keyboard.press("Tab");
    expect(await focusAt(page)).toBe("panel:first");
    await page.keyboard.press("Shift+Tab");
    expect(await focusAt(page)).toBe("toast:last");

    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
  });

  test("a confirm card keeps Tab inside the panel", async ({ page }) => {
    await mount(page);
    await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open("delegations"));
    await expect(panel(page).locator('section[data-section="delegations"] article.dl-card').first()).toBeVisible();
    await panel(page).getByRole("button", { name: /^Revoke access for / }).first().click();
    const box = panel(page).locator('[role="alertdialog"]');
    await expect(box).toBeVisible();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await focusAt(page)).toMatch(/^panel:/);
    }
    await box.getByRole("button", { name: "Keep access" }).focus();
    await page.keyboard.press("Escape");
    // The first Escape closes the confirm card, not the drawer.
    await expect(box).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
  });

  test("a prompt raised over the open drawer keeps its own focus, answers, and gives focus back to the panel", async ({ page }) => {
    await mount(page);
    await openDrawer(page);
    await panel(page).getByRole("button", { name: "Nodes", exact: true }).focus();
    await page.evaluate(() => (window as unknown as HarnessWindow).__tc.openPermission());
    const approve = page.getByRole("button", { name: "Approve" });
    await expect(approve).toBeVisible();
    // The prompt, not the panel, holds focus, and Tab stays on the prompt.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      expect(await focusAt(page)).toMatch(/^layer:/);
    }
    await approve.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).__permResult)).toBe(true);
    await expect.poll(() => focusAt(page)).toMatch(/^panel:/);
    await expect(panel(page)).toBeVisible();
  });

  for (const removal of ["auto-expiry", "dismiss click"] as const) {
    test(`focus returns to the drawer when a focused toast leaves on ${removal}`, async ({ page }) => {
      await mount(page, "light", DESKTOP, true);
      await openDrawer(page);
      await page.evaluate(() => (window as unknown as HarnessWindow).__tc.toast("info"));
      const toast = page.locator(".tstack .toast");
      const dismiss = toast.getByRole("button", { name: "Dismiss" });
      await expect(dismiss).toBeVisible();
      if (removal === "auto-expiry") await dismiss.focus();
      else await dismiss.click();
      if (removal === "auto-expiry") await expect(toast).toHaveCount(0, { timeout: 10_000 });
      else await expect(toast).toHaveCount(0);
      await expect.poll(() => focusAt(page)).toMatch(/^panel:/);
      await page.keyboard.press("Escape");
      await expect(panel(page)).toBeHidden();
    });
  }

  test("a prompt still owns Escape after a toast expires over the drawer", async ({ page }) => {
    await mount(page, "light", DESKTOP, true);
    await openDrawer(page);
    await page.evaluate(() => (window as unknown as HarnessWindow).__tc.toast("info"));
    const toast = page.locator(".tstack .toast");
    await toast.getByRole("button", { name: "Dismiss" }).focus();
    await page.evaluate(() => (window as unknown as HarnessWindow).__tc.openPermission());
    const prompt = page.locator("tinycloud-permission-request-modal");
    await expect(prompt.locator(".modal-content")).toBeVisible();
    await expect(toast).toHaveCount(0, { timeout: 10_000 });
    expect(await focusInPrompt(page, "tinycloud-permission-request-modal")).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => (window as unknown as HarnessWindow).__permResult)).toBe(false);
    await expect(panel(page)).toBeVisible();
  });

  test("a body-targeted Escape does not skip an open revoke confirmation", async ({ page }) => {
    await mount(page, "light", DESKTOP, true);
    await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open("delegations"));
    const section = panel(page).locator('section[data-section="delegations"]');
    await expect(section.locator(".dl-card").first()).toBeVisible();
    await section.getByRole("button", { name: /^Revoke access for / }).first().click();
    const confirm = section.locator('[role="alertdialog"]');
    await expect(confirm).toBeVisible();
    await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await expect(panel(page)).toBeVisible();
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Keep access" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
  });

  for (const kind of ["permission", "space creation"] as const) {
    test(`${kind} prompt mounted before the delayed panel keeps focus and Escape declines it without closing the drawer`, async ({ page }) => {
      await mount(page, "light", DESKTOP, true);
      let release: (() => void) | undefined;
      await page.route("**/panel-entry-*.js", async (route) => {
        await new Promise<void>((resolve) => {
          release = () => { void route.fallback().then(resolve); };
        });
      });
      await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open());
      await expect.poll(() => Boolean(release)).toBe(true);
      await page.evaluate((prompt) => {
        const harness = (window as unknown as HarnessWindow).__tc;
        if (prompt === "permission") harness.openPermission();
        else harness.openSpaceCreation();
      }, kind);
      const selector = kind === "permission" ? "tinycloud-permission-request-modal" : "tinycloud-space-modal";
      const prompt = page.locator(selector);
      await expect(prompt.locator(".modal-content")).toBeVisible();
      expect(await focusInPrompt(page, selector)).toBe(true);
      release?.();
      await expect(panel(page).locator(".nav-i").first()).toBeAttached();
      expect(await focusInPrompt(page, selector)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await focusInPrompt(page, selector)).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => page.evaluate((promptKind) => {
        const w = window as unknown as HarnessWindow;
        return promptKind === "permission" ? w.__permResult : w.__spaceResult;
      }, kind)).toBe(false);
      await expect(prompt).toHaveCount(0);
      await expect(panel(page)).toBeVisible();
      await expect.poll(() => focusAt(page)).toMatch(/^panel:/);
    });
  }
});

test("a long unbroken app name remains readable inside the permission prompt on a phone", async ({ page }) => {
  await mount(page, "light", PHONE, true);
  const longName = "A".repeat(120);
  await page.evaluate((name) => (window as unknown as HarnessWindow).__tc.openPermission(name), longName);
  const prompt = page.locator("tinycloud-permission-request-modal");
  const content = prompt.locator(".modal-content");
  await expect(content).toBeVisible();
  const bounds = await content.evaluate((el) => {
    const title = el.querySelector<HTMLElement>(".modal-title");
    const rect = el.getBoundingClientRect();
    return { width: el.clientWidth, scrollWidth: el.scrollWidth, right: rect.right,
      titleRight: title?.getBoundingClientRect().right, titleText: title?.textContent };
  });
  expect(bounds.titleText).toContain(longName);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width);
  expect(bounds.titleRight).toBeLessThanOrEqual(bounds.right);
  expect(bounds.right).toBeLessThanOrEqual(PHONE.width);
});

test("the scrim fades in over .35s", async ({ page }) => {
  await mount(page, "light", DESKTOP, false);
  await openDrawer(page);
  expect((await scrimStyle(page)).transition).toBe("0.35s");
});

test("with reduced motion the scrim has no transition", async ({ page }) => {
  await mount(page, "light", DESKTOP, true);
  await openDrawer(page);
  expect((await scrimStyle(page)).transition).toBe("0s");
  await expect.poll(() => scrimStyle(page)).toMatchObject({ opacity: "1" });
});
