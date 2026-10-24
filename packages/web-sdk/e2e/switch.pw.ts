import { expect, test, type Page } from "@playwright/test";
import { routeUiHarness } from "./fixtures/ui-route";

const ORIGIN = "http://tinycloud-ui.test";

interface HarnessWindow {
  __tc: { mount(ui?: unknown): boolean };
  tc?: { ui: { open(section?: string): void } };
}

async function openSection(page: Page, scheme: "light" | "dark", section: "local-tinycloud" | "local-copy") {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width: 1280, height: 800 });
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
  await page.evaluate((id) => (window as unknown as HarnessWindow).tc?.ui.open(id), section);
  const toggle = page.locator(`#tinycloud-ui-panel section[data-section="${section}"] [role="switch"]`);
  await expect(toggle).toBeVisible();
  // The slide-in transform adds float error to a measured box; wait for it.
  await page.locator("#tinycloud-ui-panel").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
  return toggle;
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: Local copy and Local TinyCloud draw the same switch, the mockup's 56x30 track with a 22px thumb`, async ({ page }) => {
    const seen: Array<{ track: [number, number]; thumb: [string, string]; hit: [number, number] }> = [];
    for (const section of ["local-tinycloud", "local-copy"] as const) {
      const toggle = await openSection(page, scheme, section);
      const knob = toggle.locator(".knob");
      const measured = await knob.evaluate((el) => {
        const track = el.getBoundingClientRect();
        const thumb = getComputedStyle(el, "::after");
        return {
          track: [Math.round(track.width), Math.round(track.height)] as [number, number],
          thumb: [thumb.width, thumb.height] as [string, string],
        };
      });
      const hit = await toggle.boundingBox();
      expect(hit!.height).toBeGreaterThanOrEqual(44);
      seen.push({ ...measured, hit: [Math.round(hit!.width), Math.round(hit!.height)] });
    }
    expect(seen[0].track).toEqual([56, 30]);
    expect(seen[0].thumb).toEqual(["22px", "22px"]);
    expect(seen[1]).toEqual(seen[0]);
  });

  test(`${scheme}: the thumb of an off switch is the ink colour, not grey`, async ({ page }) => {
    const toggle = await openSection(page, scheme, "local-tinycloud");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const thumb = await toggle.locator(".knob").evaluate((el) => getComputedStyle(el, "::after").backgroundColor);
    expect(thumb).toBe(scheme === "light" ? "rgb(9, 9, 11)" : "rgb(250, 250, 250)");
  });
}
