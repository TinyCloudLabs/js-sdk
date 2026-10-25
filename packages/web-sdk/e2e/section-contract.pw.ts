import { expect, test, type Page } from "@playwright/test";
import { routeUiHarness } from "./fixtures/ui-route";

const ORIGIN = "http://tinycloud-ui.test";

interface HarnessWindow {
  __tc: { mount(ui?: unknown): boolean };
  tc?: { ui: { open(section?: string): void; openPage(section?: string): void } };
}

const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const hint = (page: Page) => panel(page).locator(".account-hint");

async function mountHarness(page: Page, scheme: "light" | "dark", viewport: { width: number; height: number }) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize(viewport);
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
}

async function open(page: Page, layout: "drawer" | "page") {
  await page.evaluate((target) => {
    const ui = (window as unknown as HarnessWindow).tc?.ui;
    if (target === "page") ui?.openPage();
    else ui?.open();
  }, layout);
  await expect(panel(page).locator(".account-avatar")).toBeVisible();
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test("the Overview intro line shows in the sidebar only", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 });
      await open(page, "drawer");
      await expect(hint(page)).toBeVisible();
      await expect(hint(page)).toHaveText("Need more room? Choose Open full page, at the top, for these same sections on a full screen.");

      // Switching to the page remounts Overview without the line, and back brings it back.
      await panel(page).getByRole("button", { name: "Open full page", exact: true }).click();
      await expect(panel(page)).toHaveAttribute("data-layout", "page");
      await expect(hint(page)).toBeHidden();
      await panel(page).getByRole("button", { name: "Show as sidebar", exact: true }).click();
      await expect(panel(page)).toHaveAttribute("data-layout", "drawer");
      await expect(hint(page)).toBeVisible();
    });

    test("the intro line is not shown on a phone, which is always the full page", async ({ page }) => {
      await mountHarness(page, scheme, { width: 390, height: 844 });
      await open(page, "drawer");
      await expect(panel(page)).toHaveAttribute("data-layout", "page");
      await expect(hint(page)).toBeHidden();
    });

    test("the page rail and the At-a-glance rows show the same section statuses", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 });
      await open(page, "page");

      // Rail meta is `count ?? text`; each row shows `text`. Both come from the section's status().
      const rail = await panel(page).locator(".nav-i").evaluateAll((items) =>
        items.map((item) => ({
          label: item.querySelector(".nav-l")?.textContent ?? "",
          meta: item.querySelector(".nav-m")?.textContent ?? "",
        })),
      );
      const rows = await panel(page).locator(".glance-row").evaluateAll((items) =>
        items.map((item) => ({
          label: item.querySelector("b")?.textContent ?? "",
          text: item.querySelector(".st")?.textContent ?? "",
        })),
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const item = rail.find((entry) => entry.label === row.label);
        expect(item, `rail item for ${row.label}`).toBeDefined();
        expect(row.text, `${row.label} row has a status`).not.toBe("");
        expect(item?.meta, `${row.label} rail meta`).not.toBe("");
        // Where the section gives a count the rail shows it; otherwise the same text as the row.
        if (!/^(\d+\+?|Clear)$/.test(item?.meta ?? "")) expect(item?.meta).toBe(row.text);
      }
      // Overview has no status while signed in.
      expect(rail[0]).toEqual({ label: "Overview", meta: "" });
    });

    test("the rail meta is hidden from the button name and given as its description", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 });
      await open(page, "page");
      const item = panel(page).locator(".nav-i", { hasText: "Storage" });
      await expect(panel(page).getByRole("button", { name: "Storage", exact: true })).toBeVisible();
      await expect(item.locator(".nav-m")).toBeVisible();
      await expect(item).toHaveAttribute("aria-description", /\S/);
    });
  });
}
