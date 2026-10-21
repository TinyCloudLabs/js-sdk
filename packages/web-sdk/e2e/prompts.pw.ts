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
    openSpaceCreation(): boolean;
    openPermission(): boolean;
    reset(): boolean;
  };
  __spaceResult?: boolean;
  __spaceError?: string;
  __permResult?: boolean;
  __permError?: string;
}

// No init script is added. The page only receives the bundle and mounts it.
// Both prompts and the host use open shadow roots, which Playwright pierces.
async function mountHarness(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/prompts.bundle.js") {
      return route.fulfill({ status: 200, contentType: "application/javascript", body: BUNDLE });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><html><body><script src="/prompts.bundle.js"></script></body></html>',
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => (window as unknown as PromptWindow).__tc.mount());
}

async function openSpaceCreation(page: Page) {
  await page.evaluate(() => (window as unknown as PromptWindow).__tc.openSpaceCreation());
}

async function openPermission(page: Page) {
  await page.evaluate(() => (window as unknown as PromptWindow).__tc.openPermission());
}

function spaceResult(page: Page) {
  return page.evaluate(() => (window as unknown as PromptWindow).__spaceResult);
}

function permResult(page: Page) {
  return page.evaluate(() => (window as unknown as PromptWindow).__permResult);
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
    await openSpaceCreation(page);
    await openPermission(page);

    // The prompt lives inside the host's shadow root, so document.querySelector
    // cannot reach it. Walk open shadow roots to find it and read each root's mode.
    const modes = await page.evaluate(
      ([space, permission]) => {
        const findIn = (root: Document | ShadowRoot, tag: string): Element | null => {
          const direct = root.querySelector(tag);
          if (direct) return direct;
          for (const el of Array.from(root.querySelectorAll("*"))) {
            if (el.shadowRoot) {
              const found = findIn(el.shadowRoot, tag);
              if (found) return found;
            }
          }
          return null;
        };
        const modeOf = (tag: string) => findIn(document, tag)?.shadowRoot?.mode ?? null;
        return { space: modeOf(space), permission: modeOf(permission) };
      },
      [SPACE, PERMISSION] as const,
    );
    expect(modes).toEqual({ space: "open", permission: "open" });
  });

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

  // Assertion e: reset dismisses a pending prompt and resolves it false.
  test(`${scheme}: reset dismisses a pending space prompt and resolves it false`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openSpaceCreation(page);

    const spaceModal = page.locator("tinycloud-space-modal");
    await expect(spaceModal).toHaveCount(1);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.reset());

    await expect(spaceModal).toHaveCount(0);
    await expect.poll(() => spaceResult(page)).toBe(false);
  });

  test(`${scheme}: reset dismisses a pending permission prompt and resolves it false`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openPermission(page);

    const permissionModal = page.locator(PERMISSION);
    await expect(permissionModal).toHaveCount(1);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.reset());

    await expect(permissionModal).toHaveCount(0);
    await expect.poll(() => permResult(page)).toBe(false);
  });
}
