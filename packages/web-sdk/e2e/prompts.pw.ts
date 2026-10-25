import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Built by `bun run build:e2e-prompts`; the test scripts run from the package root.
const BUNDLE = readFileSync(resolve("e2e/.build/prompts.bundle.js"), "utf8");
const ORIGIN = "http://tinycloud-ui.test";

const SPACE = "tinycloud-space-modal";
const PERMISSION = "tinycloud-permission-request-modal";

interface PromptWindow {
  __tc: {
    mount(): boolean;
    mountWithKeeper(): boolean;
    mountWithConfig(legacy: Record<string, unknown>): boolean;
    openSpaceCreation(): boolean;
    openPermission(extraEntries?: number): boolean;
    openThrowingSpaceCreation(): boolean;
    reset(): boolean;
    unregister(): boolean;
  };
  __spaceResult?: boolean;
  __spaceError?: string;
  __permResult?: boolean;
  __permError?: string;
}

// No init script is added. The page only receives the bundle and mounts it.
// Both prompts and the host use open shadow roots, which Playwright pierces.
async function mountHarness(
  page: Page,
  scheme: "light" | "dark",
  withKeeper = false,
  legacy?: Record<string, unknown>,
) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/prompts.bundle.js") {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: BUNDLE });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><html><body><button id="opener">Open</button><script src="/prompts.bundle.js"></script></body></html>',
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(
    ({ keeper, legacy }) => {
      const tc = (window as unknown as PromptWindow).__tc;
      if (legacy) return tc.mountWithConfig(legacy);
      return keeper ? tc.mountWithKeeper() : tc.mount();
    },
    { keeper: withKeeper, legacy },
  );
}

// The modal sets data-state="visible" in a requestAnimationFrame, and its backdrop ignores the
// pointer until then, so the focus guard refuses a covered control. Wait for it before any key press.
async function modalShown(page: Page, selector: string) {
  await expect(page.locator(`${selector} .modal-backdrop[data-state="visible"]`)).toBeAttached();
}

async function openSpaceCreation(page: Page) {
  await page.evaluate(() => (window as unknown as PromptWindow).__tc.openSpaceCreation());
  await modalShown(page, SPACE);
}

async function openPermission(page: Page, extraEntries = 0) {
  await page.evaluate((n) => (window as unknown as PromptWindow).__tc.openPermission(n), extraEntries);
  await modalShown(page, PERMISSION);
}

async function openThrowingSpaceCreation(page: Page) {
  await page.evaluate(() => (window as unknown as PromptWindow).__tc.openThrowingSpaceCreation());
}

function spaceResult(page: Page) {
  return page.evaluate(() => (window as unknown as PromptWindow).__spaceResult);
}

function permResult(page: Page) {
  return page.evaluate(() => (window as unknown as PromptWindow).__permResult);
}

// True while the host's layer is mounted in some element's open shadow root.
function hostMounted(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("*")].some(
      (el) => el.shadowRoot?.querySelector("div.layer[data-position]") != null,
    ),
  );
}

// Walks up from the content box to the nearest opaque background and returns
// its colour and the text colour, for the surface-contrast assertion.
function surfaceOf(content: import("@playwright/test").Locator) {
  return content.evaluate((el) => {
    const transparent = (bg: string) => bg === "transparent" || /^rgba\(0, 0, 0, 0\)$/.test(bg);
    let node: Element | null = el;
    let surface: { background: string } | null = null;
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (!transparent(bg)) {
        surface = { background: bg };
        break;
      }
      const parent: Element | null = node.parentElement;
      node = parent ?? ((node.getRootNode() as ShadowRoot).host ?? null);
    }
    return { surface, text: getComputedStyle(el).color };
  });
}

// How each prompt is found and driven. `tabOrder` is the Tab order from the
// dialog container; each label is the control's data-action, data-role, or class.
const PROMPTS = {
  space: {
    selector: SPACE,
    name: "Create Your TinyCloud Space",
    description: "Your signature is required",
    open: openSpaceCreation,
    confirm: /create/i,
    tabOrder: ["modal-close", "learn-more", "create"],
    result: spaceResult,
  },
  permission: {
    selector: PERMISSION,
    name: /is requesting additional permissions$/,
    description: "This app is asking you to grant scoped permission",
    open: openPermission,
    confirm: "Approve",
    tabOrder: ["modal-close", "suppress-prompt", "decline", "approve"],
    result: permResult,
  },
} as const;

// Label of the focused element, descending through open shadow roots.
function focusedLabel(page: Page) {
  return page.evaluate(() => {
    let el: Element | null = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (!el) return null;
    return el.getAttribute("data-action") ?? el.getAttribute("data-role") ?? el.className;
  });
}

// True when the focus chain, descending through open shadow roots, passes through
// the prompt host. Focus inside a closed overlay is not visible here, so it reads false.
function focusInside(page: Page, selector: string) {
  return page.evaluate((sel) => {
    let el: Element | null = document.activeElement;
    while (el) {
      if (el.matches(sel)) return true;
      el = el.shadowRoot?.activeElement ?? null;
    }
    return false;
  }, selector);
}

// Adds a full-viewport overlay above the prompts, like OpenKey's. `style` sets how it
// covers the page. `focusable` gives its closed-root button focus when it is added.
function addOverlay(page: Page, id: string, style: string, focusable: boolean) {
  return page.evaluate(
    ({ id, style, focusable }) => {
      const overlay = document.createElement("div");
      overlay.id = id;
      overlay.setAttribute("style", `position:fixed;inset:0;z-index:999999;${style}`);
      const shadow = overlay.attachShadow({ mode: "closed" });
      shadow.innerHTML = '<button type="button">Close overlay</button>';
      document.body.appendChild(overlay);
      if (focusable) (shadow.querySelector("button") as HTMLButtonElement).focus();
    },
    { id, style, focusable },
  );
}

function removeOverlay(page: Page, id: string) {
  return page.evaluate((overlayId) => document.getElementById(overlayId)?.remove(), id);
}

for (const scheme of ["light", "dark"] as const) {
  // These locators mirror the ones apps/openkey-example/e2e uses for the space
  // prompt (the tag selector is used 21 times there). Quote style differs; the
  // selectors are the same. The proof runs against the harness DOM, not openkey.
  test(`${scheme}: openkey locators match the space prompt and Create resolves true`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openSpaceCreation(page);

    const spaceModal = page.locator("tinycloud-space-modal");
    await expect(spaceModal).toHaveCount(1);
    await expect(spaceModal.locator(".modal-content")).toBeVisible();

    const create = spaceModal.locator("button").filter({ hasText: /create/i });
    await expect(create).toHaveCount(1);
    await expect(create).toBeVisible();
    await create.click();

    await expect.poll(() => spaceResult(page)).toBe(true);
  });

  // Assertion a: both prompts are visible when shown.
  test(`${scheme}: both prompts are visible when shown`, async ({ page }) => {
    await mountHarness(page, scheme);

    await openSpaceCreation(page);
    await expect(page.locator(`${SPACE} .modal-content`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(SPACE)).toHaveCount(0);

    await openPermission(page);
    await expect(page.locator(`${PERMISSION} .modal-content`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(PERMISSION)).toHaveCount(0);
  });

  // The prompt elements and the host expose open shadow roots, so Playwright's
  // piercing locators reach the prompt DOM without an init script. `shadowRoot`
  // is null for a closed root, so this fails if a root is closed.
  test(`${scheme}: prompts and host use open shadow roots`, async ({ page }) => {
    await mountHarness(page, scheme);
    // The prompt lives inside the host's shadow root, so document.querySelector
    // cannot reach it. Walk open shadow roots to find it and read its root's mode.
    // Read each prompt while it is open: a prompt that is displaced is removed.
    const readMode = (target: string) =>
      page.evaluate((tag) => {
        const findIn = (root: Document | ShadowRoot, name: string): Element | null => {
          const direct = root.querySelector(name);
          if (direct) return direct;
          for (const el of Array.from(root.querySelectorAll("*"))) {
            if (el.shadowRoot) {
              const found = findIn(el.shadowRoot, name);
              if (found) return found;
            }
          }
          return null;
        };
        return findIn(document, tag)?.shadowRoot?.mode ?? null;
      }, target);
    await openSpaceCreation(page);
    const space = await readMode(SPACE);
    await openPermission(page);
    const permission = await readMode(PERMISSION);
    expect({ space, permission }).toEqual({ space: "open", permission: "open" });
  });

  // Both prompts are announced as modal dialogs, named by their title and
  // described by their body text, and they manage focus like a modal.
  for (const kind of ["space", "permission"] as const) {
    const p = PROMPTS[kind];

    test(`${scheme}: ${kind} prompt is a modal dialog named by its title`, async ({ page }) => {
      await mountHarness(page, scheme);
      await p.open(page);
      const dialog = page.getByRole("dialog", { name: p.name });
      await expect(dialog).toHaveCount(1);
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      const described = await dialog.evaluate((el) => {
        const id = el.getAttribute("aria-describedby") ?? "";
        return (el.getRootNode() as Document | ShadowRoot).getElementById(id)?.textContent ?? "";
      });
      expect(described).toContain(p.description);
    });

    test(`${scheme}: ${kind} prompt takes focus on the dialog, not a control`, async ({ page }) => {
      await mountHarness(page, scheme);
      await p.open(page);
      expect(await focusedLabel(page)).toBe("modal-container");
    });

    test(`${scheme}: ${kind} prompt: Enter on the dialog does not confirm`, async ({ page }) => {
      await mountHarness(page, scheme);
      await p.open(page);
      await page.keyboard.press("Enter");
      // Give a stray confirm time to land before asserting that none did.
      await page.waitForTimeout(300);
      await expect(page.locator(p.selector)).toHaveCount(1);
      expect(await p.result(page)).toBeFalsy();
    });

    test(`${scheme}: ${kind} prompt keeps Tab and Shift+Tab inside the dialog`, async ({ page }) => {
      await mountHarness(page, scheme);
      await p.open(page);
      const order = p.tabOrder;
      const forward: (string | null)[] = [];
      for (let i = 0; i <= order.length; i++) {
        await page.keyboard.press("Tab");
        forward.push(await focusedLabel(page));
      }
      // The last Tab wraps from the final control back to the first.
      expect(forward).toEqual([...order, order[0]]);
      await page.keyboard.press("Shift+Tab");
      expect(await focusedLabel(page)).toBe(order[order.length - 1]);
    });

    test(`${scheme}: ${kind} prompt returns focus to the opener on Escape`, async ({ page }) => {
      await mountHarness(page, scheme);
      await page.locator("#opener").focus();
      await p.open(page);
      expect(await focusedLabel(page)).toBe("modal-container");
      await page.keyboard.press("Escape");
      // Focus returns when the prompt hides, not when its fade-out removes it (200 ms later).
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("opener");
      await expect(page.locator(p.selector)).toHaveCount(0);
      await expect(page.locator("#opener")).toBeFocused();
    });

    test(`${scheme}: ${kind} confirm returns focus to the opener`, async ({ page }) => {
      await mountHarness(page, scheme);
      await page.locator("#opener").focus();
      await p.open(page);
      await page.getByRole("button", { name: p.confirm }).click();
      await expect(page.locator(p.selector)).toHaveCount(0);
      await expect(page.locator("#opener")).toBeFocused();
    });
  }

  // Assertion b: Approve, Deny, and Escape each settle the permission prompt.
  test(`${scheme}: permission Approve resolves true and removes the prompt`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openPermission(page);

    const approve = page.locator(PERMISSION).locator('[data-action="approve"]');
    await expect(approve).toBeVisible();
    await approve.click();

    await expect.poll(() => permResult(page)).toBe(true);
    await expect(page.locator(PERMISSION)).toHaveCount(0);
  });

  test(`${scheme}: permission Deny resolves false and removes the prompt`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openPermission(page);

    const decline = page.locator(PERMISSION).locator('[data-action="decline"]');
    await expect(decline).toBeVisible();
    await decline.click();

    await expect.poll(() => permResult(page)).toBe(false);
    await expect(page.locator(PERMISSION)).toHaveCount(0);
  });

  test(`${scheme}: Escape on the permission prompt resolves false and removes the prompt`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openPermission(page);
    await expect(page.locator(`${PERMISSION} .modal-content`)).toBeVisible();

    await page.keyboard.press("Escape");

    await expect.poll(() => permResult(page)).toBe(false);
    await expect(page.locator(PERMISSION)).toHaveCount(0);
  });

  test(`${scheme}: Escape on the space prompt resolves false and removes the prompt`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openSpaceCreation(page);
    await expect(page.locator(`${SPACE} .modal-content`)).toBeVisible();

    await page.keyboard.press("Escape");

    await expect.poll(() => spaceResult(page)).toBe(false);
    await expect(page.locator(SPACE)).toHaveCount(0);
  });

  // Assertion c: the prompt is hit-testable above a page overlay at z-index 1000.
  // The prompt sits in the host at z-index 999990, so the overlay must not cover it.
  test(`${scheme}: space prompt is hit-testable above a page overlay at z-index 1000`, async ({ page }) => {
    await mountHarness(page, scheme);
    await page.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.id = "e2e-page-overlay";
      overlay.setAttribute("style", "position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5);");
      document.body.appendChild(overlay);
    });
    await openSpaceCreation(page);

    const create = page
      .locator("tinycloud-space-modal")
      .locator("button")
      .filter({ hasText: /create/i });
    await create.click();

    await expect.poll(() => spaceResult(page)).toBe(true);
  });

  test(`${scheme}: permission prompt is hit-testable above a page overlay at z-index 1000`, async ({ page }) => {
    await mountHarness(page, scheme);
    await page.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.id = "e2e-page-overlay";
      overlay.setAttribute("style", "position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.5);");
      document.body.appendChild(overlay);
    });
    await openPermission(page);

    await page.locator(PERMISSION).locator('[data-action="approve"]').click();

    await expect.poll(() => permResult(page)).toBe(true);
  });

  // An overlay at z-index 999999 in document.body stands in for OpenKey's layer.
  // The host is 999990, so the overlay must win the hit-test at the prompt's own
  // button. If the host ever rises above 999999, this fails.
  for (const [name, selector, action, open] of [
    ["space", SPACE, "create", openSpaceCreation],
    ["permission", PERMISSION, "approve", openPermission],
  ] as const) {
    test(`${scheme}: ${name} prompt is covered by a body overlay at z-index 999999`, async ({ page }) => {
      await mountHarness(page, scheme);
      await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.id = "e2e-openkey-stand-in";
        overlay.setAttribute("style", "position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.5);");
        document.body.appendChild(overlay);
      });
      await open(page);

      const box = await page.locator(selector).locator(`[data-action="${action}"]`).boundingBox();
      expect(box).not.toBeNull();
      const hit = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.id ?? null,
        [box!.x + box!.width / 2, box!.y + box!.height / 2],
      );
      expect(hit).toBe("e2e-openkey-stand-in");
    });
  }

  // A Tab pressed in an overlay above the prompt must not pull focus into the prompt.
  // One Tab from an overlay after the host does not reach the prompt in the browser's
  // own order, so this case isolates the Tab trap. Shift+Tab does reach the covered
  // control in the browser's order; the Shift+Tab cases below cover that path.
  for (const [name, selector, open, result] of [
    ["space", SPACE, openSpaceCreation, spaceResult],
    ["permission", PERMISSION, openPermission, permResult],
  ] as const) {
    test(`${scheme}: ${name} prompt does not take focus from a Tab pressed in an overlay above it`, async ({ page }) => {
      await mountHarness(page, scheme);
      await open(page);
      await expect(page.locator(`${selector} .modal-content`)).toBeVisible();
      await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.id = "e2e-openkey-focus-stand-in";
        overlay.setAttribute("style", "position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,.5);");
        const shadow = overlay.attachShadow({ mode: "closed" });
        shadow.innerHTML = '<button type="button">Close overlay</button>';
        document.body.appendChild(overlay);
        (shadow.querySelector("button") as HTMLButtonElement).focus();
      });
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("e2e-openkey-focus-stand-in");

      await page.keyboard.press("Tab");
      expect(await focusInside(page, selector), "Tab moved focus into the covered prompt").toBe(false);
      await page.keyboard.press("Enter");
      // Give a stray confirm time to land before asserting that none did.
      await page.waitForTimeout(300);
      await expect(page.locator(selector)).toHaveCount(1);
      expect(await result(page)).toBeUndefined();
    });
  }

  // Keyboard activation of a covered control. Shift+Tab from an overlay after the host
  // lands on the prompt's last control (Create or Approve) in the browser's own order,
  // which the Tab trap leaves alone. Enter then clicks it. The click handler checks
  // isTopmostControl at activation, so nothing confirms while the overlay covers it.
  for (const [name, selector, action, open, result] of [
    ["space", SPACE, "create", openSpaceCreation, spaceResult],
    ["permission", PERMISSION, "approve", openPermission, permResult],
  ] as const) {
    const coverings = {
      "semi-transparent (rgba .5)": "background:rgba(0,0,0,.5);",
      "translucent (opacity .3)": "background:#000;opacity:.3;",
    };
    for (const [covering, style] of Object.entries(coverings)) {
      test(`${scheme}: ${name} prompt is not confirmed by Shift+Tab then Enter under a ${covering} overlay`, async ({ page }) => {
        await mountHarness(page, scheme);
        await open(page);
        await expect(page.locator(`${selector} .modal-content`)).toBeVisible();
        await addOverlay(page, "e2e-overlay", style, true);
        await page.keyboard.press("Shift+Tab");
        expect(await focusedLabel(page), "Shift+Tab did not reach the covered control").toBe(action);
        await page.keyboard.press("Enter");
        // Give a stray confirm time to land before asserting that none did.
        await page.waitForTimeout(300);
        await expect(page.locator(selector)).toHaveCount(1);
        expect(await result(page)).toBeUndefined();
      });
    }

    // The overlay is added after the prompt opened and still covers the control when
    // Enter is pressed. The check runs at activation, so the press is blocked.
    test(`${scheme}: ${name} prompt blocks Enter on its focused control when an overlay appears after it opened`, async ({ page }) => {
      await mountHarness(page, scheme);
      await open(page);
      await expect(page.locator(`${selector} .modal-content`)).toBeVisible();
      await page.locator(`${selector} [data-action="${action}"]`).focus();
      expect(await focusedLabel(page)).toBe(action);
      await addOverlay(page, "e2e-overlay", "background:rgba(0,0,0,.5);", false);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      await expect(page.locator(selector)).toHaveCount(1);
      expect(await result(page)).toBeUndefined();
    });

    // The overlay covers the prompt from before it opens, then is removed. Nothing is
    // cached at show time, so the control confirms once it is uncovered.
    test(`${scheme}: ${name} prompt confirms from its focused control once the overlay covering it is removed`, async ({ page }) => {
      await mountHarness(page, scheme);
      await addOverlay(page, "e2e-overlay", "background:rgba(0,0,0,.5);", false);
      await open(page);
      await expect(page.locator(`${selector} .modal-content`)).toBeVisible();
      await removeOverlay(page, "e2e-overlay");
      await page.locator(`${selector} [data-action="${action}"]`).focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => result(page)).toBe(true);
      await expect(page.locator(selector)).toHaveCount(0);
    });

    // With no overlay, keyboard Tab to the control and Enter still confirms.
    test(`${scheme}: ${name} prompt confirms from keyboard Tab to ${action} then Enter with no overlay`, async ({ page }) => {
      await mountHarness(page, scheme);
      await open(page);
      await expect(page.locator(`${selector} .modal-content`)).toBeVisible();
      let label: string | null = null;
      for (let i = 0; i < 8 && label !== action; i++) {
        await page.keyboard.press("Tab");
        label = await focusedLabel(page);
      }
      expect(label).toBe(action);
      await page.keyboard.press("Enter");
      await expect.poll(() => result(page)).toBe(true);
      await expect(page.locator(selector)).toHaveCount(0);
    });

    // With no overlay, a mouse click on the control still confirms.
    test(`${scheme}: ${name} prompt confirms on a mouse click of ${action} with no overlay`, async ({ page }) => {
      await mountHarness(page, scheme);
      await open(page);
      await page.locator(`${selector} [data-action="${action}"]`).click();
      await expect.poll(() => result(page)).toBe(true);
      await expect(page.locator(selector)).toHaveCount(0);
    });

    // Documents the limit of the hit test, not a guarantee. elementFromPoint skips an
    // element with pointer-events:none, so an overlay like that does not block the
    // control even though it is painted on top. Keyboard activation then confirms.
    test(`${scheme}: ${name} prompt is confirmed by Shift+Tab then Enter under a pointer-events:none overlay (documented limit)`, async ({ page }) => {
      await mountHarness(page, scheme);
      await open(page);
      await expect(page.locator(`${selector} .modal-content`)).toBeVisible();
      await addOverlay(page, "e2e-overlay", "background:rgba(0,0,0,.5);pointer-events:none;", true);
      await page.keyboard.press("Shift+Tab");
      expect(await focusedLabel(page)).toBe(action);
      await page.keyboard.press("Enter");
      await expect.poll(() => result(page)).toBe(true);
      await expect(page.locator(selector)).toHaveCount(0);
    });
  }

  // Assertion d: colour scheme. Each prompt paints an opaque surface whose
  // text colour differs from it, in both light and dark emulation.
  for (const [name, selector, open] of [
    ["space", SPACE, openSpaceCreation],
    ["permission", PERMISSION, openPermission],
  ] as const) {
    test(`${scheme}: ${name} prompt content has an opaque surface and a text colour distinct from it`, async ({ page }) => {
      await mountHarness(page, scheme);
      await open(page);

      const content = page.locator(`${selector} .modal-content`);
      await expect(content).toBeVisible();

      // The content box may be transparent; the painted surface is its nearest
      // ancestor (in the shadow tree or beyond) with a non-transparent background.
      const result = await surfaceOf(content);

      expect(result.surface).not.toBeNull();
      const background = result.surface!.background;
      expect(background).toMatch(/^rgba?\(/);
      const alpha = background.match(/^rgba\(.*,\s*([0-9.]+)\)$/);
      expect(alpha === null || Number(alpha[1]) === 1, `background ${background} is not opaque`).toBe(true);
      expect(result.text).not.toBe(background);
    });
  }

  // Assertion e: a second prompt displaces the first. The displaced space prompt
  // settles as dismissed (false), is removed, and the permission prompt stays.
  test(`${scheme}: a second prompt displaces the first and settles it`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openSpaceCreation(page);
    await expect(page.locator(SPACE)).toHaveCount(1);

    await openPermission(page);

    await expect.poll(() => spaceResult(page)).toBe(false);
    await expect(page.locator(SPACE)).toHaveCount(0);
    await expect(page.locator(`${PERMISSION} .modal-content`)).toBeVisible();

    await page.locator(PERMISSION).locator('[data-action="approve"]').click();
    await expect.poll(() => permResult(page)).toBe(true);
  });

  // The displaced prompt is removed in the same turn it is displaced. Its hide
  // timer runs only after 200 ms, so a leftover element is still counted at 50 ms.
  test(`${scheme}: a displaced prompt is removed at once, leaving one prompt in the DOM`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openSpaceCreation(page);
    await openPermission(page);
    await page.waitForTimeout(50);
    expect(await page.locator(`${SPACE}, ${PERMISSION}`).count()).toBe(1);
    expect(await page.locator(PERMISSION).count()).toBe(1);
  });

  // A displaced prompt's hide timer must not clear the scroll lock of the prompt that replaced it.
  test(`${scheme}: a displaced prompt keeps the scroll lock of the prompt that replaced it`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openSpaceCreation(page);
    await openPermission(page);
    await expect(page.locator(SPACE)).toHaveCount(0);

    // Read after the displaced modal's 200 ms hide timer has run.
    const overflow = await page.evaluate(
      () => new Promise<string>((resolve) => setTimeout(() => resolve(document.body.style.overflow), 400)),
    );
    expect(overflow).toBe("hidden");
    await expect(page.locator(PERMISSION)).toHaveCount(1);
  });

  // A throwing onDismiss on the displaced prompt must not orphan it: the new prompt still mounts,
  // the scroll lock is released, and the error still reaches the page.
  test(`${scheme}: a throwing onDismiss on the displaced prompt still removes it and mounts the new one`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await mountHarness(page, scheme);
    await openThrowingSpaceCreation(page);
    await openPermission(page);

    await expect(page.locator(`${SPACE}, ${PERMISSION}`)).toHaveCount(1);
    await expect(page.locator(`${PERMISSION} .modal-content`)).toBeVisible();
    await page.locator(PERMISSION).locator(".modal-content").click({ trial: true });
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await expect.poll(() => pageErrors).toEqual(["probe onDismiss"]);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.reset());
    await expect.poll(() => permResult(page)).toBe(false);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
  });

  // Assertion e: reset dismisses a pending prompt and resolves it false.
  test(`${scheme}: sole-client reset dismisses a pending space prompt and resolves it false`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openSpaceCreation(page);

    const spaceModal = page.locator("tinycloud-space-modal");
    await expect(spaceModal).toHaveCount(1);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.reset());

    await expect(spaceModal).toHaveCount(0);
    await expect.poll(() => spaceResult(page)).toBe(false);
  });

  test(`${scheme}: sole-client reset dismisses a pending permission prompt and resolves it false`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openPermission(page);

    const permissionModal = page.locator(PERMISSION);
    await expect(permissionModal).toHaveCount(1);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.reset());

    await expect(permissionModal).toHaveCount(0);
    await expect.poll(() => permResult(page)).toBe(false);
  });

  test(`${scheme}: keeper reset dismisses a pending space prompt and keeps the host mounted`, async ({ page }) => {
    await mountHarness(page, scheme, true);
    await openSpaceCreation(page);

    const spaceModal = page.locator(SPACE);
    await expect(spaceModal).toHaveCount(1);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.reset());

    await expect(spaceModal).toHaveCount(0);
    await expect.poll(() => spaceResult(page)).toBe(false);
    expect(await hostMounted(page)).toBe(true);
  });

  test(`${scheme}: keeper reset dismisses a pending permission prompt and keeps the host mounted`, async ({ page }) => {
    await mountHarness(page, scheme, true);
    await openPermission(page);

    const permissionModal = page.locator(PERMISSION);
    await expect(permissionModal).toHaveCount(1);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.reset());

    await expect(permissionModal).toHaveCount(0);
    await expect.poll(() => permResult(page)).toBe(false);
    expect(await hostMounted(page)).toBe(true);
  });

  test(`${scheme}: unregister dismisses a pending space prompt while the keeper keeps the host mounted`, async ({ page }) => {
    await mountHarness(page, scheme, true);
    await openSpaceCreation(page);

    const spaceModal = page.locator(SPACE);
    await expect(spaceModal).toHaveCount(1);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.unregister());

    await expect(spaceModal).toHaveCount(0);
    await expect.poll(() => spaceResult(page)).toBe(false);
    expect(await hostMounted(page)).toBe(true);
  });

  test(`${scheme}: unregister dismisses a pending permission prompt while the keeper keeps the host mounted`, async ({ page }) => {
    await mountHarness(page, scheme, true);
    await openPermission(page);

    const permissionModal = page.locator(PERMISSION);
    await expect(permissionModal).toHaveCount(1);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.unregister());

    await expect(permissionModal).toHaveCount(0);
    await expect.poll(() => permResult(page)).toBe(false);
    expect(await hostMounted(page)).toBe(true);
  });

  // A throwing onDismiss must not block cleanup: unregister still removes the sole client's host.
  test(`${scheme}: unregister with a throwing onDismiss still unmounts the host and surfaces the error`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await mountHarness(page, scheme);
    await openThrowingSpaceCreation(page);
    await expect(page.locator(SPACE)).toHaveCount(1);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.unregister());
    await expect(page.locator(SPACE)).toHaveCount(0);
    await expect(page.locator("[data-tinycloud-ui]")).toHaveCount(0);
    await expect.poll(() => pageErrors).toEqual(["probe onDismiss"]);
  });

  test(`${scheme}: reset with a throwing onDismiss still settles the prompt and releases the scroll lock`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await mountHarness(page, scheme);
    await openThrowingSpaceCreation(page);
    await expect(page.locator(SPACE)).toHaveCount(1);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.reset());
    await expect(page.locator(SPACE)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
    await expect.poll(() => pageErrors).toEqual(["probe onDismiss"]);
  });

  // Legacy `notifications.popups: false` maps to ui.button/toasts off. The host stays mounted,
  // the launcher is absent, the prompts still render, and the deprecation warns exactly once.
  const LEGACY_POPUPS_WARN = "[tinycloud] notifications.popups is deprecated, use ui (code: legacy-notification-key)";
  async function mountLegacyPopupsOff(page: Page, scheme: "light" | "dark") {
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    await mountHarness(page, scheme, false, { notifications: { popups: false } });
    await expect(page.locator("[data-tinycloud-ui]")).toHaveCount(1);
    await expect(page.locator("button.button")).toHaveCount(0);
    return warnings;
  }

  test(`${scheme}: legacy popups:false still shows the space prompt and Escape resolves false`, async ({ page }) => {
    const warnings = await mountLegacyPopupsOff(page, scheme);
    await openSpaceCreation(page);

    const spaceModal = page.locator(SPACE);
    await expect(spaceModal).toHaveCount(1);
    await expect(spaceModal.locator(".modal-content")).toBeVisible();
    await expect.poll(() => warnings.filter((text) => text === LEGACY_POPUPS_WARN)).toHaveLength(1);

    await page.keyboard.press("Escape");
    await expect(spaceModal).toHaveCount(0);
    await expect.poll(() => spaceResult(page)).toBe(false);
  });

  test(`${scheme}: legacy popups:false still shows the permission prompt and Escape resolves false`, async ({ page }) => {
    const warnings = await mountLegacyPopupsOff(page, scheme);
    await openPermission(page);

    const permissionModal = page.locator(PERMISSION);
    await expect(permissionModal).toHaveCount(1);
    await expect(permissionModal.locator(".modal-content")).toBeVisible();
    await expect.poll(() => warnings.filter((text) => text === LEGACY_POPUPS_WARN)).toHaveLength(1);

    await page.keyboard.press("Escape");
    await expect(permissionModal).toHaveCount(0);
    await expect.poll(() => permResult(page)).toBe(false);
  });
}

// Small-height prompts. The backdrop scrolls, so Approve and Create stay reachable
// by keyboard and mouse at every window height. The permission prompt gets two extra
// entries (three in all), so it is taller than the window at the short heights.
const SWEEP_HEIGHTS = [140, 200, 260, 360, 480, 700];
const CONFIRM = { space: "create", permission: "approve" } as const;
const CONFIRM_SELECTOR = { space: '[data-action="create"]', permission: '[data-action="approve"]' } as const;

function openSized(page: Page, kind: "space" | "permission") {
  return kind === "space" ? openSpaceCreation(page) : openPermission(page, 2);
}

// Presses `key` until the confirm control has focus. A Tab from an overlay does not
// reach the prompt in browser order, so the overlay tests use Shift+Tab.
async function focusConfirm(page: Page, kind: "space" | "permission", key: "Tab" | "Shift+Tab") {
  const want = CONFIRM[kind];
  for (let i = 0; i < 12; i++) {
    if ((await focusedLabel(page)) === want) return;
    await page.keyboard.press(key);
  }
  expect(await focusedLabel(page), `${key} never reached ${want}`).toBe(want);
}

for (const scheme of ["light", "dark"] as const) {
  for (const kind of ["space", "permission"] as const) {
    const selector = PROMPTS[kind].selector;
    const result = PROMPTS[kind].result;

    // The 1024x200 space prompt and 1024x360 three-entry permission prompt are both in the sweep.
    for (const height of SWEEP_HEIGHTS) {
      test(`${scheme}: ${kind} at 1024x${height}: Tab to confirm and Enter approves`, async ({ page }) => {
        await page.setViewportSize({ width: 1024, height });
        await mountHarness(page, scheme);
        await openSized(page, kind);
        await focusConfirm(page, kind, "Tab");
        await page.keyboard.press("Enter");
        await expect.poll(() => result(page)).toBe(true);
      });

      test(`${scheme}: ${kind} at 1024x${height}: Shift+Tab under a covering overlay is blocked`, async ({ page }) => {
        await page.setViewportSize({ width: 1024, height });
        await mountHarness(page, scheme);
        await openSized(page, kind);
        await addOverlay(page, "cover", "background:rgba(0,0,0,.5)", true);
        await focusConfirm(page, kind, "Shift+Tab");
        await page.keyboard.press("Enter");
        await expect(page.locator(selector)).toHaveCount(1);
        expect(await result(page)).toBeUndefined();
      });
    }

    // The mouse must reach the clipped confirm control after Playwright scrolls it into view.
    test(`${scheme}: ${kind}: mouse click on the clipped confirm control approves`, async ({ page }) => {
      const height = kind === "space" ? 200 : 360;
      await page.setViewportSize({ width: 1024, height });
      await mountHarness(page, scheme);
      await openSized(page, kind);
      const confirm = page.locator(`${selector} ${CONFIRM_SELECTOR[kind]}`);
      await expect(confirm).not.toBeInViewport();
      await confirm.click();
      await expect.poll(() => result(page)).toBe(true);
    });
  }
}
