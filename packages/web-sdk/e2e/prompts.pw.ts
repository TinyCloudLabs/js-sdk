import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Built by `bun run build:e2e-prompts`; the test scripts run from the package root.
const BUNDLE = readFileSync(resolve("e2e/.build/prompts.bundle.js"), "utf8");
const ORIGIN = "http://tinycloud-ui.test";

interface PromptWindow {
  __tc: {
    mount(): boolean;
    openSpaceCreation(): boolean;
    reset(): boolean;
  };
  __spaceResult?: boolean;
  __spaceError?: string;
}

// No init script is added. The page only receives the bundle and mounts it.
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

function spaceResult(page: Page) {
  return page.evaluate(() => (window as unknown as PromptWindow).__spaceResult);
}

for (const scheme of ["light", "dark"] as const) {
  // These two expressions are copied verbatim from apps/openkey-example/e2e.
  // `page.locator('tinycloud-space-modal')` is used 21 times there.
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

  // The prompt sits in the host at z-index 999990. Any page element with a
  // higher z-index covers it. A lower one must not: the Create click has to
  // reach the prompt, and Playwright only clicks when the prompt is the hit target.
  test(`${scheme}: prompt is hit-testable above a page overlay at z-index 1000`, async ({ page }) => {
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

  test(`${scheme}: prompt content has an opaque surface and a text colour distinct from it`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openSpaceCreation(page);

    const content = page.locator("tinycloud-space-modal .modal-content");
    await expect(content).toBeVisible();

    // The content box may be transparent; the painted surface is its nearest
    // ancestor (in the shadow tree or beyond) with a non-transparent background.
    const result = await content.evaluate((el) => {
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

    expect(result.surface).not.toBeNull();
    const background = result.surface!.background;
    expect(background).toMatch(/^rgba?\(/);
    const alpha = background.match(/^rgba\(.*,\s*([0-9.]+)\)$/);
    expect(alpha === null || Number(alpha[1]) === 1, `background ${background} is not opaque`).toBe(true);
    expect(result.text).not.toBe(background);
  });

  test(`${scheme}: reset dismisses a pending prompt and resolves it false`, async ({ page }) => {
    await mountHarness(page, scheme);
    await openSpaceCreation(page);

    const spaceModal = page.locator("tinycloud-space-modal");
    await expect(spaceModal).toHaveCount(1);

    await page.evaluate(() => (window as unknown as PromptWindow).__tc.reset());

    await expect(spaceModal).toHaveCount(0);
    await expect.poll(() => spaceResult(page)).toBe(false);
  });
}
