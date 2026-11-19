import { expect, test } from "@playwright/test";
import { routeUiHarness } from "./fixtures/ui-route";

const ORIGIN = "http://tinycloud-ui.test";
const FAILURE_LOG = "[tinycloud] ui-panel-load-failed";
const PRIVATE_ERROR = "PRIVATE_PANEL_CHUNK_CONTEXT_SENTINEL";

interface HarnessWindow {
  __tc: { mount(ui?: unknown): boolean };
}

test("a rejected lazy panel import shows recovery and logs no rejection details", async ({ page }) => {
  const panelFailureLogs: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().startsWith(FAILURE_LOG)) panelFailureLogs.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await routeUiHarness(page);
  await page.route(`${ORIGIN}/panel-entry-*.js`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: `throw new TypeError(${JSON.stringify(PRIVATE_ERROR)});`,
    }),
  );
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());

  await page.getByRole("button", { name: "TinyCloud settings", exact: true }).click();
  await expect(page.locator("#tinycloud-ui-panel [role='status']")).toHaveText(
    "This didn't load. Reloading the page can fix it. Save anything you're working on first.",
  );
  await expect(page.getByRole("button", { name: "Reload page", exact: true })).toBeVisible();
  expect(panelFailureLogs).toEqual([`${FAILURE_LOG} type-error`]);
  expect(panelFailureLogs.join(" ")).not.toContain(PRIVATE_ERROR);
  expect(pageErrors).toEqual([]);

  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Reload page", exact: true }).click();
  await reloaded;
});
