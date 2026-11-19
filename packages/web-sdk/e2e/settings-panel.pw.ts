import { expect, test, type Page } from "@playwright/test";
import { entryBundle, isPanelChunk, PANEL_ONLY_MARKER, routeUiHarness } from "./fixtures/ui-route";

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
  __tc: { mount(ui?: unknown): boolean; toast(kind: string): string; dismiss(id: string): void; rejectWithTinyCloudError(): boolean; setSync(state: unknown): boolean; signOutCalls(): number };
  tc?: { ui: { open(): void } };
}

// Expected surfaces, matching the panel's background token in each scheme.
const PANEL_BACKGROUND = {
  light: "rgb(255, 255, 255)",
  dark: "rgb(21, 21, 23)",
} as const;

async function mountHarness(page: Page, scheme: "light" | "dark", ui?: Record<string, unknown>) {
  await page.emulateMedia({ colorScheme: scheme });
  const requested = await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate((option) => (window as unknown as HarnessWindow).__tc.mount(option), ui);
  return requested;
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: panel is clickable, Hide hides the launcher, and open() restores it`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountHarness(page, scheme);

    const launcher = page.getByRole("button", { name: "TinyCloud settings", exact: true });
    const panel = page.locator("#tinycloud-ui-panel");

    await launcher.click();
    await expect(panel).toBeVisible();
    // The stand-in shares the panel id and is visible first; wait for the lazy shell to replace it before measuring.
    await expect(panel.locator(".nav-i").first()).toBeAttached();

    // The panel must receive pointer events and paint its own surface. A
    // missing `.panel` class left it with pointer-events:none and no background.
    const computed = await panel.evaluate((el) => {
      const style = getComputedStyle(el);
      return { pointerEvents: style.pointerEvents, background: style.backgroundColor };
    });
    expect(computed.pointerEvents).toBe("auto");
    expect(computed.background).toBe(PANEL_BACKGROUND[scheme]);

    // Playwright's click waits until the target is the hit-test element at the
    // button centre. A click-through panel makes this click time out.
    await page.getByRole("button", { name: "Hide button", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(launcher).toBeHidden();

    await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open());
    await expect(panel).toBeVisible();
    await expect(launcher).toBeVisible();
  });
}

test("the settings panel is fetched on first open, not with the page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const requested = await mountHarness(page, "light");
  expect(entryBundle()).not.toContain(PANEL_ONLY_MARKER);
  expect(requested.filter(isPanelChunk)).toEqual([]);

  await page.getByRole("button", { name: "TinyCloud settings", exact: true }).click();
  await expect(page.locator("#tinycloud-ui-panel")).toBeVisible();
  // The stand-in is visible before the chunk request is recorded; wait for the lazy shell.
  await expect(page.locator("#tinycloud-ui-panel .nav-i").first()).toBeAttached();
  expect(requested.filter(isPanelChunk)).toHaveLength(1);
});

// The launcher's focus ring must clear 3:1 on a light and a dark page. Its
// outline sits outside the element, so the 6px halo of the opposite ink covers
// whichever page is behind it.
for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: at least one of launcher focus ring and halo is at least 3:1 on light and dark pages`, async ({ page }) => {
    await mountHarness(page, scheme);
    const launcher = page.getByRole("button", { name: "TinyCloud settings" });
    await launcher.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const ring = await launcher.evaluate((el) => {
      const s = getComputedStyle(el);
      return { focusVisible: el.matches(":focus-visible"), outline: s.outlineColor, shadow: s.boxShadow };
    });
    expect(ring.focusVisible).toBe(true);
    const halo = /(rgba?\([^)]*\)) 0px 0px 0px 6px/.exec(ring.shadow)?.[1];
    expect(halo, ring.shadow).toBeTruthy();
    for (const page_bg of ["rgb(255, 255, 255)", "rgb(11, 12, 16)"]) {
      expect(Math.max(contrast(ring.outline, page_bg), contrast(halo!, page_bg))).toBeGreaterThanOrEqual(3);
    }
  });
}

// The launcher's 1px border is the only edge against the page, so it must clear 3:1 on both.
for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: launcher border is at least 3:1 on light and dark pages`, async ({ page }) => {
    await mountHarness(page, scheme);
    const border = await page.getByRole("button", { name: "TinyCloud settings" }).evaluate((el) => getComputedStyle(el).borderTopColor);
    for (const page_bg of ["rgb(255, 255, 255)", "rgb(11, 12, 16)"]) {
      expect(contrast(border, page_bg)).toBeGreaterThanOrEqual(3);
    }
  });
}

// Action buttons (Hide button, Close, Erase, Cancel, ...) are identified by their 1px border, so it must clear 3:1 on the button surface.
for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: action button border is at least 3:1 on its surface`, async ({ page }) => {
    await mountHarness(page, scheme);
    await page.getByRole("button", { name: "TinyCloud settings", exact: true }).click();
    await expect(page.locator("#tinycloud-ui-panel .nav-i").first()).toBeAttached();
    const action = page.getByRole("button", { name: "Hide button", exact: true });
    await expect(action).toHaveClass(/\baction\b/);
    const colours = await action.evaluate((el) => {
      const style = getComputedStyle(el);
      return { border: style.borderTopColor, surface: style.backgroundColor };
    });
    expect(contrast(colours.border, colours.surface)).toBeGreaterThanOrEqual(3);
  });
}

// Each toast's left stripe must be its kind colour in the rendered page, and at
// least 3:1 against the toast surface. Dark warning is the only dark override.
const KINDS = ["info", "success", "warning", "error"] as const;
const STRIPE = {
  light: { info: "rgb(37, 99, 235)", success: "rgb(22, 163, 74)", warning: "rgb(217, 119, 6)", error: "rgb(220, 38, 38)" },
  dark: { info: "rgb(37, 99, 235)", success: "rgb(22, 163, 74)", warning: "rgb(251, 189, 35)", error: "rgb(220, 38, 38)" },
} as const;

function channel(c: number) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: string) {
  const [r, g, b] = (rgb.match(/\d+/g) ?? []).map(Number);
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

for (const scheme of ["light", "dark"] as const) {
  for (const kind of KINDS) {
    test(`${scheme} ${kind} toast stripe is its kind colour and at least 3:1 on the toast`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await mountHarness(page, scheme);
      await page.evaluate((k) => (window as unknown as HarnessWindow).__tc.toast(k), kind);

      const toast = page.locator(`.toast.toast--${kind}`);
      await expect(toast).toBeVisible();
      const computed = await toast.evaluate((el) => {
        const style = getComputedStyle(el);
        return { stripe: style.borderLeftColor, surface: style.backgroundColor };
      });
      expect(computed.stripe).toBe(STRIPE[scheme][kind]);
      expect(contrast(computed.stripe, computed.surface)).toBeGreaterThanOrEqual(3);
    });
  }
}

// The button-off test also proves the mount option reached the host: the launcher is absent and the host renders.
for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: ui.toasts:false shows no toast for a TinyCloud error, and the host stays`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountHarness(page, scheme, { button: false, toasts: false });
    await page.evaluate(() => (window as unknown as HarnessWindow).__tc.rejectWithTinyCloudError());

    await expect(page.locator("[data-tinycloud-ui]")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "TinyCloud settings", exact: true })).toHaveCount(0);
    await expect(page.locator(".toast")).toHaveCount(0);
  });

  test(`${scheme}: the same TinyCloud error shows a toast when ui.toasts is not false`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountHarness(page, scheme);
    await page.evaluate(() => (window as unknown as HarnessWindow).__tc.rejectWithTinyCloudError());

    await expect(page.locator(".toast")).toHaveCount(1);
  });
}

// Toasts stack above the open panel and above the launcher once it closes. Three toasts is the worst stack.
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
} as const;

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function insideViewport(box: Box, size: { width: number; height: number }): boolean {
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height;
}

async function toastBoxes(page: Page): Promise<Box[]> {
  const count = await page.locator(".toast").count();
  const boxes: Box[] = [];
  for (let i = 0; i < count; i++) {
    const box = await page.locator(".toast").nth(i).boundingBox();
    if (box) boxes.push(box);
  }
  return boxes;
}

async function openPanelViolations(page: Page, size: { width: number; height: number }): Promise<string[]> {
  const panel = await page.locator("#tinycloud-ui-panel").boundingBox();
  if (!panel) return ["panel not rendered"];
  const problems: string[] = [];
  if (!insideViewport(panel, size)) problems.push("panel outside viewport");
  const toasts = await toastBoxes(page);
  if (toasts.length !== 3) problems.push(`expected 3 toasts, found ${toasts.length}`);
  toasts.forEach((toast, i) => {
    if (!insideViewport(toast, size)) problems.push(`toast ${i} outside viewport`);
  });
  // The drawer is a side panel with no reserved toast room, so toasts paint over it.
  // Each toast must still be the topmost element at its centre, so it can be read and dismissed.
  const occluded = await page.locator(".toast").evaluateAll((els) =>
    els.flatMap((el, i) => {
      const r = el.getBoundingClientRect();
      const hit = (el.getRootNode() as ShadowRoot).elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit && el.contains(hit) ? [] : [i];
    }),
  );
  for (const i of occluded) problems.push(`toast ${i} is covered`);
  return problems;
}

async function closedLauncherViolations(page: Page, size: { width: number; height: number }): Promise<string[]> {
  const launcher = await page.getByRole("button", { name: "TinyCloud settings", exact: true }).boundingBox();
  if (!launcher) return ["launcher not rendered"];
  const problems: string[] = [];
  const toasts = await toastBoxes(page);
  if (toasts.length !== 3) problems.push(`expected 3 toasts, found ${toasts.length}`);
  toasts.forEach((toast, i) => {
    if (!insideViewport(toast, size)) problems.push(`toast ${i} outside viewport`);
    if (overlaps(toast, launcher)) problems.push(`toast ${i} overlaps launcher`);
  });
  return problems;
}

for (const scheme of ["light", "dark"] as const) {
  for (const [name, size] of Object.entries(VIEWPORTS)) {
    test(`${scheme} ${name}: toasts stay above the open panel and above the launcher after close, inside the viewport`, async ({ page }) => {
      await page.setViewportSize(size);
      await mountHarness(page, scheme);
      const launcher = page.getByRole("button", { name: "TinyCloud settings", exact: true });
      await launcher.click();
      await expect(page.locator("#tinycloud-ui-panel")).toBeVisible();
      await expect(page.locator("#tinycloud-ui-panel .nav-i").first()).toBeAttached();
      await page.evaluate(() => {
        const harness = window as unknown as HarnessWindow;
        harness.__tc.toast("info");
        harness.__tc.toast("success");
        harness.__tc.toast("warning");
      });
      await expect(page.locator(".toast")).toHaveCount(3);

      await expect.poll(() => openPanelViolations(page, size)).toEqual([]);

      // The open drawer covers the launcher, so close it through its own control.
      await page.locator("#tinycloud-ui-panel").getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.locator("#tinycloud-ui-panel")).toBeHidden();
      await expect.poll(() => closedLauncherViolations(page, size)).toEqual([]);
    });
  }
}

// Sign out: the safe action takes focus, Escape takes it too, and a confirmed
// sign-out signs out once and keeps the panel open in the signed-out state.
for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: sign-out confirm focuses the safe action, Escape keeps the session, confirm signs out once`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountHarness(page, scheme);

    await page.getByRole("button", { name: "TinyCloud settings", exact: true }).click();
    const panel = page.locator("#tinycloud-ui-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".nav-i").first()).toBeAttached();

    const signOut = panel.getByRole("button", { name: "Sign out", exact: true });
    await signOut.click();
    const dialog = panel.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Stay signed in", exact: true })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(signOut).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as HarnessWindow).__tc.signOutCalls())).toBe(0);

    await signOut.click();
    await dialog.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(panel.getByText("TinyCloud is signed out in this app. Sign in to see your account.")).toBeVisible();
    await expect(panel).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as HarnessWindow).__tc.signOutCalls())).toBe(1);
    expect(pageErrors.get(page)).toEqual([]);
  });
}
