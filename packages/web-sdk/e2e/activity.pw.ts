import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { row as contrastRow, textRow } from "./fixtures/contrast";

// localhost is a secure context, so the real async clipboard exists and can be granted. The harness is served from memory.
const ORIGIN = "http://localhost:4173";
const DIR = resolve("e2e/.build/ui");
const FILES = new Map(
  readdirSync(DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => [name, readFileSync(resolve(DIR, name), "utf8")]),
);

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

type Row = Record<string, unknown>;

interface HarnessWindow {
  __tc: {
    mount(ui?: Record<string, unknown>): boolean;
    logPush(row: Row): boolean;
    logClear(): boolean;
    logListeners(): number;
  };
  tc?: { ui: { open(section?: string): void; openPage(section?: string): void } };
}

interface Options {
  scheme?: "light" | "dark";
  viewport?: { width: number; height: number };
  seed?: { requests: Row[] };
  ui?: Record<string, unknown>;
  reducedMotion?: "reduce" | "no-preference";
}

const panel = (page: Page) => page.locator("#tinycloud-ui-panel");

async function mountHarness(page: Page, options: Options = {}) {
  // Reduced motion by default: the panel's slide-in would otherwise move the boxes the layout specs measure.
  const { scheme = "light", viewport = { width: 1280, height: 800 }, seed, ui, reducedMotion = "reduce" } = options;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion });
  await page.setViewportSize(viewport);
  await page.route(`${ORIGIN}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const body = FILES.get(name);
    if (body !== undefined) {
      return route.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body });
    }
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><html><body><script type="module" src="/harness-entry.js"></script></body></html>',
    });
  });
  if (seed) await page.addInitScript((value) => Reflect.set(window, "__TC_STUB_SEED__", value), JSON.stringify(seed));
  await page.goto(`${ORIGIN}/`);
  await page.evaluate((option) => (window as unknown as HarnessWindow).__tc.mount(option), ui);
}

async function openActivity(page: Page, layout: "drawer" | "page") {
  await page.evaluate((target) => {
    const api = (window as unknown as HarnessWindow).tc?.ui;
    if (target === "page") api?.openPage("activity");
    else api?.open("activity");
  }, layout);
  await expect(panel(page).locator(".act-root")).toBeVisible();
}

const dataRows = (page: Page) => panel(page).locator(".act-table .act-ar:not(.act-hd)");
const toggle = (page: Page) => panel(page).getByRole("switch", { name: "Errors only" });
const pauseButton = (page: Page) => panel(page).getByRole("button", { name: /^(Pause|Resume) live$/ });
const copyAll = (page: Page) => panel(page).getByRole("button", { name: "Copy all" });
const count = (page: Page) => panel(page).locator(".act-count");

function failing(id: number): Row {
  return {
    v: 1,
    id,
    at: Date.now(),
    service: "kv",
    op: "kv/put",
    path: "notes/",
    space: "personal",
    host: "node.tinycloud.xyz",
    bytes: 10,
    durationMs: 5,
    attempts: 1,
    ok: false,
    code: "HTTP_500",
    source: "network",
  };
}

const READ_CLIPBOARD = () => navigator.clipboard.readText();

test.describe("developer mode", () => {
  test("on: Activity is in the nav with its error count and on Overview; off: it is in neither", async ({ page }) => {
    await mountHarness(page, { viewport: { width: 1280, height: 800 } });
    await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.openPage());
    await expect(panel(page).locator(".nav-i", { hasText: "Activity" })).toBeVisible();
    await expect(panel(page).locator(".nav-i", { hasText: "Activity" }).locator(".nav-m")).toHaveText("2 errors");
    await expect(panel(page).locator(".glance-row", { hasText: "Activity" }).locator(".st")).toHaveText("2 errors");

    await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount({ developerMode: false }));
    await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.openPage("activity"));
    await expect(panel(page).locator(".nav-i").first()).toBeAttached();
    await expect(panel(page).locator(".nav-i", { hasText: "Activity" })).toHaveCount(0);
    await expect(panel(page).locator(".glance-row", { hasText: "Activity" })).toHaveCount(0);
    await expect(panel(page).locator(".act-root")).toHaveCount(0);
  });
});

test.describe("layout", () => {
  test("sidebar: the log is the stacked two-line list with no header row, and nothing scrolls sideways", async ({ page }) => {
    await mountHarness(page);
    await openActivity(page, "drawer");
    await expect(panel(page)).toHaveAttribute("data-layout", "drawer");
    await expect(dataRows(page)).toHaveCount(14);
    await expect(panel(page).locator(".act-hd")).toBeHidden();
    const fit = await panel(page).locator(".main").evaluate((main) => main.scrollWidth <= main.clientWidth);
    expect(fit).toBe(true);
  });

  test("page: ten columns with a header row, every row inside the table, Copy in view, host on one line", async ({ page }) => {
    await mountHarness(page);
    await openActivity(page, "page");
    await expect(panel(page)).toHaveAttribute("data-layout", "page");
    const headers = await panel(page).locator(".act-hd [role=columnheader]").allTextContents();
    expect(headers).toEqual(["Time", "Operation", "Path", "Space", "Host", "Bytes", "Took", "Result", "Source", "Copy"]);
    await expect(panel(page).locator(".act-hd")).toBeVisible();

    const geometry = await panel(page).locator(".act-table").evaluate((table) => {
      const box = table.getBoundingClientRect();
      const rows = [...table.querySelectorAll<HTMLElement>(".act-ar:not(.act-hd)")];
      return {
        table: { left: box.left, right: box.right },
        viewport: window.innerWidth,
        scrolls: table.scrollWidth > table.clientWidth,
        rows: rows.map((row) => {
          const cells = [...row.querySelectorAll(":scope > [role=cell]")].map((cell) => {
            const rect = cell.getBoundingClientRect();
            return { left: rect.left, right: rect.right, height: rect.height, overflow: cell.scrollWidth > cell.clientWidth + 1 };
          });
          const host = row.querySelector(".act-c-host")?.getBoundingClientRect();
          return { cells, hostHeight: host?.height ?? 0 };
        }),
      };
    });
    expect(geometry.scrolls).toBe(false);
    for (const [index, row] of geometry.rows.entries()) {
      expect(row.cells, `row ${index} cells`).toHaveLength(10);
      for (const cell of row.cells) {
        expect(cell.left).toBeGreaterThanOrEqual(geometry.table.left - 1);
        expect(cell.right).toBeLessThanOrEqual(geometry.table.right + 1);
        expect(cell.overflow).toBe(false);
      }
      expect(row.cells[9]?.right).toBeLessThanOrEqual(geometry.viewport);
      expect(row.hostHeight, `row ${index} host wraps`).toBeLessThan(20);
    }
    // Column order: each cell starts to the right of the previous one.
    const first = geometry.rows[0]?.cells ?? [];
    for (let i = 1; i < first.length; i++) expect(first[i]?.left).toBeGreaterThanOrEqual(first[i - 1]?.right ?? 0);
  });

  for (const width of [390, 360]) {
    test(`phone ${width}: two lines per request, Copy in view, nothing scrolls sideways`, async ({ page }) => {
      await mountHarness(page, { viewport: { width, height: 800 } });
      await openActivity(page, "drawer");
      await expect(panel(page)).toHaveAttribute("data-layout", "page");
      await expect(panel(page).locator(".act-hd")).toBeHidden();
      const lines = await dataRows(page).evaluateAll((rows) =>
        rows.map((row) => {
          const rect = (name: string) => row.querySelector(`.${name}`)?.getBoundingClientRect();
          const top = (name: string) => rect(name)?.top ?? NaN;
          return {
            ok: !row.classList.contains("act-err"),
            first: ["act-c-time", "act-c-op", "act-c-path", "act-c-res", "act-c-source"].map(top),
            second: ["act-c-space", "act-c-host", "act-c-bytes", "act-c-took"].map(top),
            timeBottom: rect("act-c-time")?.bottom ?? NaN,
            copyRight: rect("act-c-copy")?.right ?? NaN,
            copyLeft: rect("act-c-copy")?.left ?? NaN,
            copyTop: rect("act-c-copy")?.top ?? NaN,
            opLength: row.querySelector(".act-c-op")?.textContent?.length ?? 0,
          };
        }),
      );
      for (const [index, line] of lines.entries()) {
        const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
        if (line.ok) expect(spread(line.first), `row ${index} first line`).toBeLessThan(4);
        expect(spread(line.second), `row ${index} second line`).toBeLessThan(4);
        expect(Math.min(...line.second), `row ${index} second line is below the first`).toBeGreaterThanOrEqual(line.timeBottom - 1);
        // Copy shares the first line, unless a long operation name has filled it (a 9-character one at 360px).
        if (line.ok && line.opLength <= (width === 360 ? 8 : 9)) expect(line.copyTop, `row ${index} copy on first line`).toBeLessThan(line.timeBottom);
        expect(line.copyLeft).toBeGreaterThanOrEqual(0);
        expect(line.copyRight).toBeLessThanOrEqual(width);
      }
      const fit = await panel(page).locator(".main").evaluate((main) => main.scrollWidth <= main.clientWidth);
      expect(fit).toBe(true);
      // Every control of the section is inside the viewport.
      for (const control of [toggle(page), pauseButton(page), copyAll(page)]) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      }
    });
  }

  test("controls and row copy buttons are at least 44px", async ({ page }) => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 360, height: 800 },
    ]) {
      await mountHarness(page, { viewport });
      await openActivity(page, "page");
      const targets = [toggle(page), pauseButton(page), copyAll(page), panel(page).locator(".act-chk"), panel(page).locator(".act-c-copy button").first()];
      for (const [index, target] of targets.entries()) {
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        expect(box?.height, `${viewport.width}px target ${index} height`).toBeGreaterThanOrEqual(44);
        expect(box?.width, `${viewport.width}px target ${index} width`).toBeGreaterThanOrEqual(44);
      }
    }
  });
});

test.describe("filter, pause and clear", () => {
  test("errors only shows the failures, says so in the count, and works from the keyboard", async ({ page }) => {
    await mountHarness(page);
    await openActivity(page, "page");
    await expect(count(page)).toHaveText("14 of 14 requests · 2 errors");
    await toggle(page).focus();
    await page.keyboard.press("Space");
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
    await expect(dataRows(page)).toHaveCount(2);
    await expect(count(page)).toHaveText("2 of 14 requests · 2 errors");
    await expect(dataRows(page).locator(".act-c-res")).toHaveText(["HTTP_403", "TIMEOUT"]);
    await page.keyboard.press("Space");
    await expect(dataRows(page)).toHaveCount(14);
  });

  test("pause holds the table, resume brings in what arrived, and a failure moves the rail count", async ({ page }) => {
    await mountHarness(page);
    await openActivity(page, "page");
    await page.evaluate((row) => (window as unknown as HarnessWindow).__tc.logPush(row), failing(100));
    await expect(dataRows(page)).toHaveCount(15);
    await expect(panel(page).locator(".nav-i", { hasText: "Activity" }).locator(".nav-m")).toHaveText("3 errors");
    await expect(dataRows(page).first().locator(".act-c-res")).toHaveText("HTTP_500");

    await pauseButton(page).click();
    await expect(pauseButton(page)).toHaveText("Resume live");
    await page.evaluate((row) => (window as unknown as HarnessWindow).__tc.logPush(row), failing(101));
    await page.waitForTimeout(250);
    await expect(dataRows(page)).toHaveCount(15);
    await pauseButton(page).click();
    await expect(pauseButton(page)).toHaveText("Pause live");
    await expect(dataRows(page)).toHaveCount(16);
  });

  test("a new request does not take focus from a Copy button", async ({ page }) => {
    await mountHarness(page);
    await openActivity(page, "page");
    const second = dataRows(page).nth(1).getByRole("button");
    const label = await second.getAttribute("aria-label");
    await second.focus();
    for (const id of [200, 201, 202]) await page.evaluate((row) => (window as unknown as HarnessWindow).__tc.logPush(row), failing(id));
    await expect(dataRows(page)).toHaveCount(17);
    await expect(panel(page).locator(":focus")).toHaveAttribute("aria-label", label ?? "");
  });

  test("a clear empties the table and the rail count, including rows held by Pause", async ({ page }) => {
    await mountHarness(page);
    await openActivity(page, "page");
    await pauseButton(page).click();
    await page.evaluate(() => (window as unknown as HarnessWindow).__tc.logClear());
    await expect(dataRows(page)).toHaveCount(0);
    await expect(panel(page).locator(".act-table")).toContainText("No requests yet.");
    await expect(count(page)).toHaveText("0 of 0 requests · 0 errors");
    await expect(panel(page).locator(".nav-i", { hasText: "Activity" }).locator(".nav-m")).toHaveText("Clear");
  });

  test("the empty log: the empty line, Copy all off, Clear on the rail and No errors on Overview", async ({ page }) => {
    await mountHarness(page, { seed: { requests: [] } });
    await openActivity(page, "page");
    await expect(panel(page).locator(".act-table")).toContainText("No requests yet.");
    await expect(copyAll(page)).toBeDisabled();
    await expect(panel(page).locator(".nav-i", { hasText: "Activity" }).locator(".nav-m")).toHaveText("Clear");
    await panel(page).locator(".nav-i", { hasText: "Overview" }).click();
    await expect(panel(page).locator(".glance-row", { hasText: "Activity" }).locator(".st")).toHaveText("No errors");
  });

  test("errors only with no failures says everything went through", async ({ page }) => {
    await mountHarness(page, { seed: { requests: [{ ...failing(1), ok: true, code: "ok" }] } });
    await openActivity(page, "page");
    await toggle(page).click();
    await expect(dataRows(page)).toHaveCount(0);
    await expect(panel(page).locator(".act-table")).toContainText("No errors. Everything this app asked for went through.");
  });

  test("leaving the section removes its log listeners", async ({ page }) => {
    await mountHarness(page);
    expect(await page.evaluate(() => (window as unknown as HarnessWindow).__tc.logListeners())).toBe(0);
    await openActivity(page, "page");
    expect(await page.evaluate(() => (window as unknown as HarnessWindow).__tc.logListeners())).toBe(2);
    await panel(page).locator(".nav-i", { hasText: "Overview" }).click();
    await expect(panel(page).locator(".act-root")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as HarnessWindow).__tc.logListeners())).toBe(0);
  });
});

test.describe("copy", () => {
  test("one request and Copy all put the mockup's plain text on the clipboard and raise a toast", async ({ page }) => {
    await mountHarness(page);
    await openActivity(page, "page");
    const first = dataRows(page).first();
    const cells = (await first.locator(":scope > [role=cell]").allTextContents()).slice(0, 9);
    await first.getByRole("button").click();
    await expect(page.locator(".toast", { hasText: "Request copied." })).toBeVisible();
    expect(await page.evaluate(READ_CLIPBOARD)).toBe(cells.join("  "));

    await copyAll(page).click();
    await expect(page.locator(".toast", { hasText: "Requests copied as text." })).toBeVisible();
    const all = (await page.evaluate(READ_CLIPBOARD)).split("\n");
    expect(all).toHaveLength(14);
    expect(all[0]).toBe(cells.join("  "));

    await toggle(page).click();
    await copyAll(page).click();
    await expect.poll(async () => (await page.evaluate(READ_CLIPBOARD)).split("\n").length).toBe(2);
  });

  test("when the clipboard and the copy command both refuse, a toast says so", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "clipboard", {
        configurable: true,
        get: () => ({ writeText: () => Promise.reject(new Error("denied")) }),
      });
      document.execCommand = () => false;
    });
    await mountHarness(page);
    await openActivity(page, "page");
    await copyAll(page).click();
    await expect(page.locator(".toast", { hasText: "Could not copy." })).toBeVisible();
  });

  test("a token-like field on a log entry is never drawn or copied", async ({ page }) => {
    const secret = "tok_SECRET_0123456789";
    const entry = {
      ...failing(1),
      ok: true,
      code: "ok",
      token: secret,
      authorization: `Bearer ${secret}`,
      delegation: secret,
      value: secret,
      headers: { cookie: secret },
    };
    await mountHarness(page, { seed: { requests: [entry] } });
    await openActivity(page, "page");
    await expect(dataRows(page)).toHaveCount(1);
    await dataRows(page).first().getByRole("button").click();
    await copyAll(page).click();
    await expect(page.locator(".toast", { hasText: "Requests copied as text." })).toBeVisible();
    expect(await page.evaluate(READ_CLIPBOARD)).not.toContain("SECRET");
    expect(await panel(page).evaluate((el) => el.textContent)).not.toContain("SECRET");
    expect(await panel(page).evaluate((el) => el.innerHTML)).not.toContain("SECRET");
  });
});

test.describe("keyboard", () => {
  test("tab order: Errors only, Pause, Copy all, then each row's Copy", async ({ page }) => {
    await mountHarness(page);
    await openActivity(page, "page");
    await toggle(page).focus();
    await page.keyboard.press("Tab");
    await expect(pauseButton(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(copyAll(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dataRows(page).nth(0).getByRole("button")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dataRows(page).nth(1).getByRole("button")).toBeFocused();
  });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} colors`, () => {
    test("text is 4.5:1 and the failure mark and bar 3:1 on the table", async ({ page }) => {
      await mountHarness(page, { scheme });
      await openActivity(page, "page");
      const table = panel(page).locator(".act-table");
      const surface = await table.evaluate((el) => getComputedStyle(el).backgroundColor);
      const header = await panel(page).locator(".act-hd").evaluate((el) => getComputedStyle(el).backgroundColor);
      const failedRow = panel(page).locator(".act-err").first();
      const rows = [
        await textRow("time", dataRows(page).first().locator(".act-c-time"), surface),
        await textRow("operation", dataRows(page).first().locator(".act-c-op"), surface),
        await textRow("space", dataRows(page).first().locator(".act-c-space"), surface),
        await textRow("host", dataRows(page).first().locator(".act-c-host"), surface),
        await textRow("bytes", dataRows(page).first().locator(".act-c-bytes"), surface),
        await textRow("source", dataRows(page).first().locator(".act-c-source"), surface),
        await textRow("result", dataRows(page).first().locator(".act-c-res"), surface),
        await textRow("failed result", failedRow.locator(".act-c-res"), surface),
        await textRow("header", panel(page).locator(".act-hd .act-c-time"), header),
      ];
      const page_bg = await panel(page).locator(".main").evaluate((el) => getComputedStyle(el.closest(".panel") ?? el).backgroundColor);
      for (const [label, locator] of [
        ["lede", ".act-lede"],
        ["count", ".act-count"],
        ["note", ".act-devnote"],
        ["chip", ".act-chip"],
        ["errors only", ".act-chk"],
      ] as const) {
        rows.push(await textRow(label, panel(page).locator(locator), page_bg));
      }
      for (const entry of rows) {
        expect(entry.opaque, `${entry.label} opaque`).toBe(true);
        expect(entry.ratio, `${entry.label} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      const mark = await failedRow.locator(".act-c-res svg").evaluate((el) => getComputedStyle(el).color);
      expect(contrastRow("failure mark", mark, surface).ratio).toBeGreaterThanOrEqual(3);
      const bar = await failedRow.evaluate((el) => getComputedStyle(el).backgroundImage);
      const barColor = /rgb\([^)]*\)/.exec(bar)?.[0] ?? "";
      expect(contrastRow("failure bar", barColor, surface).ratio).toBeGreaterThanOrEqual(3);
    });
  });
}

test.describe("motion", () => {
  test("an arriving row slides in, and not when reduced motion is on", async ({ page }) => {
    for (const [reducedMotion, expected] of [
      ["no-preference", "act-in"],
      ["reduce", "none"],
    ] as const) {
      await mountHarness(page, { reducedMotion });
      await openActivity(page, "page");
      await page.evaluate((row) => (window as unknown as HarnessWindow).__tc.logPush(row), failing(300));
      const arrived = dataRows(page).first();
      await expect(arrived).toHaveClass(/act-new/);
      expect(await arrived.evaluate((el) => getComputedStyle(el).animationName)).toBe(expected);
    }
  });
});

test.describe("unknown values", () => {
  const unknownRow = { v: 1, id: 1, op: "kv/get", path: "notes/", space: "personal", host: "node.tinycloud.xyz" };

  test("a request with no size, time, result or source shows dashes and 'unknown', and gives the rail no status", async ({ page }) => {
    await mountHarness(page, { seed: { requests: [unknownRow] } });
    await openActivity(page, "page");
    const row = dataRows(page).first();
    for (const name of ["act-c-time", "act-c-bytes", "act-c-took", "act-c-source"]) {
      await expect(row.locator(`.${name}`)).toHaveText("\u2014");
    }
    await expect(row.locator(".act-c-res")).toHaveText("unknown");
    await expect(row).not.toHaveClass(/act-err/);
    expect(await row.evaluate((el) => el.textContent)).not.toMatch(/\b0 (B|ms)\b|network|\bok\b/);
    await expect(count(page)).toHaveText("1 of 1 requests · \u2014 errors");
    // No known outcome and no known failure: nothing to say on the rail or on Overview, not "Clear".
    await expect(panel(page).locator(".nav-i", { hasText: "Activity" }).locator(".nav-m")).toHaveText("");
    await panel(page).locator(".nav-i", { hasText: "Overview" }).click();
    await expect(panel(page).locator(".glance-row", { hasText: "Activity" }).locator(".st")).toHaveCount(0);

    await panel(page).locator(".nav-i", { hasText: "Activity" }).click();
    await copyAll(page).click();
    await expect(page.locator(".toast", { hasText: "Requests copied as text." })).toBeVisible();
    expect(await page.evaluate(READ_CLIPBOARD)).toBe("\u2014  kv/get  notes/  personal  node.tinycloud.xyz  \u2014  \u2014  unknown  \u2014");
  });
});
