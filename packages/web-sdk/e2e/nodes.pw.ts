import { expect, test, type Locator, type Page } from "@playwright/test";
import { textRow, type ContrastRow } from "./fixtures/contrast";
import { routeUiHarness } from "./fixtures/ui-route";

const ORIGIN = "http://tinycloud-ui.test";

// Every test fails on an uncaught page error or a console error.
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

// The harness origin is plain http, where the browser hides navigator.clipboard. The copy tests record
// the writes the button makes instead; production is served over https and uses the real clipboard.
async function recordClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const writes: string[] = [];
    Object.defineProperty(window, "__clipboardWrites", { value: writes });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => { writes.push(text); return Promise.resolve(); } },
    });
  });
}
function lastClipboardWrite(page: Page): Promise<string | undefined> {
  return page.evaluate<string | undefined>(() => Reflect.get(window, "__clipboardWrites")?.at(-1));
}

interface HarnessWindow {
  __tc: { mount(ui?: unknown): boolean };
  tc?: { ui: { open(section?: string): void; openPage(section?: string): void } };
}

// Expected panel surfaces in each scheme, matching the panel background token.
const PANEL_BACKGROUND = {
  light: "rgb(255, 255, 255)",
  dark: "rgb(21, 21, 23)",
} as const;

const HOSTED_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

// Seed rows are the mockup fixtures. `lastSeenAt` is an ISO string; the harness revives it to a Date.
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const populatedSeed = {
  nodes: {
    state: "ready",
    data: [
      {
        origin: "https://node.tinycloud.xyz",
        kind: "hosted",
        active: true,
        nodeDid: HOSTED_DID,
        status: "ok",
        version: "0.14.2",
        latencyMs: 84,
        lastSeenAt: ago(3000),
        spaces: ["Personal", "Work"],
      },
      {
        origin: "https://lab.example.org",
        kind: "hosted",
        active: false,
        status: "slow",
        version: "0.13.9",
        latencyMs: 640,
        lastSeenAt: ago(21000),
        spaces: ["lab-notes"],
      },
      {
        origin: "http://127.0.0.1:8787",
        kind: "local",
        active: false,
        status: "ok",
        latencyMs: 3,
        lastSeenAt: ago(1000),
        spaces: ["Personal"],
      },
    ],
  },
} as const;

type Seed = Record<string, unknown>;

async function mountHarness(page: Page, scheme: "light" | "dark", viewport: { width: number; height: number }, seed?: Seed) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize(viewport);
  if (seed !== undefined) {
    const json = JSON.stringify(seed);
    // The stub seed is read once, at mount. Set it before any script runs.
    await page.addInitScript((value) => {
      const holder: Record<string, unknown> = window as unknown as Record<string, unknown>;
      holder.__TC_STUB_SEED__ = value;
    }, json);
  }
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => (window as unknown as HarnessWindow).__tc.mount());
}

async function open(page: Page, layout: "drawer" | "page") {
  await page.evaluate((target) => {
    const ui = (window as unknown as HarnessWindow).tc?.ui;
    if (target === "page") ui?.openPage("nodes");
    else ui?.open("nodes");
  }, layout);
  await expect(panel(page).locator('section[data-section="nodes"]')).toBeVisible();
}

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("element has no box");
  return box;
};
// The host is a block that fills its column, so measure the text itself for the line it sits on.
const textBoxOf = (locator: Locator) =>
  locator.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const section = (page: Page) => panel(page).locator('section[data-section="nodes"]');
const cards = (page: Page) => section(page).locator("li.nd-card");
const stateLine = (page: Page) => section(page).locator('p[role="status"]');
const copyButton = (page: Page) => section(page).locator('.nd-card .icon-btn[aria-label^="Copy the node ID"]');
const retryButton = (page: Page) => section(page).locator("button.action");

// True when the element is the focused element of its own root (works through the panel's shadow root).
async function isFocused(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const root = el.getRootNode();
    return "activeElement" in root && root.activeElement === el;
  });
}

// The page layout slides in over about 250 ms. Measure positions only after the section stops moving.
async function settleSlide(locator: Locator): Promise<void> {
  let previous = NaN;
  await expect
    .poll(async () => {
      const left = await locator.evaluate((el) => el.getBoundingClientRect().left);
      const settled = left === previous;
      previous = left;
      return settled;
    })
    .toBe(true);
}

// Tab until the target has focus. Bounded so a missing stop fails rather than hangs.
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 60; i++) {
    if (await isFocused(target)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("target never received keyboard focus");
}

// Nearest non-transparent background behind an element, falling back to the panel surface.
async function backdrop(locator: Locator, scheme: "light" | "dark"): Promise<string> {
  const fallback = PANEL_BACKGROUND[scheme];
  return locator.evaluate((el, fallbackColor) => {
    let node: Element | null = el;
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
      node = node.parentElement;
    }
    return fallbackColor;
  }, fallback);
}

function expectAA(rows: ContrastRow[]) {
  for (const entry of rows) {
    expect(entry.opaque, `${entry.label} is opaque`).toBe(true);
    expect(entry.ratio, `${entry.label} contrast`).toBeGreaterThanOrEqual(4.5);
  }
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme}`, () => {
    test("populated: the cards show the mockup copy, the active node's ID, and the slow status", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 }, populatedSeed);
      await open(page, "drawer");

      await expect(section(page).locator(".sec-title")).toHaveText("Connected nodes");
      await expect(section(page).locator("p.note").first()).toHaveText(
        "The nodes this session is talking to right now. TinyCloud picks the node for each space; there is nothing to switch here.",
      );

      await expect(cards(page)).toHaveCount(3);
      const hosts = await cards(page).evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
      expect(hosts).toEqual(["node.tinycloud.xyz", "lab.example.org", "127.0.0.1:8787"]);

      const first = cards(page).nth(0);
      await expect(first).toContainText("Your hosted TinyCloud");
      await expect(first).toContainText("Connected");
      await expect(first).toContainText(HOSTED_DID);
      await expect(first).toContainText("84 ms · seen");
      await expect(first).toContainText("Version");
      await expect(first).toContainText("0.14.2");

      const second = cards(page).nth(1);
      await expect(second).toContainText("Slow to respond");
      await expect(second).toContainText("640 ms");
      await expect(second).not.toContainText(HOSTED_DID);

      // The local node is described as this computer, and the DID row is absent for non-active nodes.
      await expect(cards(page).nth(2)).toContainText("On this computer");
      await expect(cards(page).nth(2)).not.toContainText("Node ID");
    });

    test("populated: the status sits right of the host, centred on the host line", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 }, populatedSeed);
      await open(page, "drawer");
      await settleSlide(section(page));

      const host = await textBoxOf(cards(page).nth(0).locator(".nd-host"));
      const status = await boxOf(cards(page).nth(0).locator(".st"));
      expect(status.x).toBeGreaterThan(host.x + host.width);
      const statusMiddle = status.y + status.height / 2;
      expect(statusMiddle).toBeGreaterThanOrEqual(host.y);
      expect(statusMiddle).toBeLessThanOrEqual(host.y + host.height);
    });

    test("populated: the lede takes the body ink token, not the grey note colour", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 }, populatedSeed);
      await open(page, "drawer");

      const colourOf = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).color);
      const lede = await colourOf(section(page).locator(".nd-lede"));
      // The mockup lede has no colour of its own, so it takes the ink token: #09090b light, #fafafa dark.
      expect(lede).toBe(scheme === "light" ? "rgb(9, 9, 11)" : "rgb(250, 250, 250)");
    });

    test("populated: the DID copy button writes the ID to the clipboard", async ({ page }) => {
      await recordClipboard(page);
      await mountHarness(page, scheme, { width: 1280, height: 800 }, populatedSeed);
      await open(page, "drawer");

      await copyButton(page).click();
      await expect.poll(() => lastClipboardWrite(page)).toBe(HOSTED_DID);
    });

    test("populated: keyboard reaches the copy button and Enter copies", async ({ page }) => {
      await recordClipboard(page);
      await mountHarness(page, scheme, { width: 1280, height: 800 }, populatedSeed);
      await open(page, "drawer");

      await tabTo(page, copyButton(page));
      await page.keyboard.press("Enter");
      await expect.poll(() => lastClipboardWrite(page)).toBe(HOSTED_DID);
    });

    test("populated: copy buttons are 44 px and text meets AA contrast on the card surface", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 }, populatedSeed);
      await open(page, "drawer");

      const box = await copyButton(page).boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);

      const label = cards(page).nth(0).locator(".label");
      const note = cards(page).nth(0).locator(".note").first();
      const did = cards(page).nth(0).locator(".nd-did");
      const slowWord = cards(page).nth(1).locator(".st");
      expectAA([
        await textRow("origin label", label, await backdrop(label, scheme)),
        await textRow("role note", note, await backdrop(note, scheme)),
        await textRow("node ID", did, await backdrop(did, scheme)),
        await textRow("slow status", slowWord, await backdrop(slowWord, scheme)),
      ]);
    });

    test("empty: a ready list with no nodes shows the empty note and no cards", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 }, { nodes: { state: "ready", data: [] } });
      await open(page, "drawer");

      await expect(cards(page)).toHaveCount(0);
      await expect(section(page).locator("p.note", { hasText: "No node is in use right now." })).toBeVisible();
    });

    test("loading: the section shows the loading line", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 }, { nodes: { state: "loading" } });
      await open(page, "drawer");

      await expect(stateLine(page)).toHaveText("Loading…");
      await expect(cards(page)).toHaveCount(0);
    });

    test("needs-permission: the neutral permission line shows, not an error, with no cards", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 }, { nodes: { state: "needs-permission", ability: "space/list" } });
      await open(page, "drawer");

      await expect(stateLine(page)).toHaveText("This session can't show this yet.");
      await expect(cards(page)).toHaveCount(0);
      // The permission state is neutral copy, so the error retry is not offered.
      await expect(retryButton(page)).toBeHidden();
    });

    test("error: the failure line and a Try again button show and the button is clickable", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 }, { nodes: { state: "error", code: "network" } });
      await open(page, "drawer");

      await expect(stateLine(page)).toHaveText("This didn't load.");
      await expect(retryButton(page)).toBeVisible();
      await expect(retryButton(page)).toHaveText("Try again");
      await retryButton(page).click();
      // The static stub returns the same error on retry, so the line stays and no error is thrown.
      await expect(stateLine(page)).toHaveText("This didn't load.");
    });

    test("error: the retry button is the first control in the section", async ({ page }) => {
      await mountHarness(page, scheme, { width: 1280, height: 800 }, { nodes: { state: "error", code: "network" } });
      await open(page, "drawer");

      await tabTo(page, retryButton(page));
      await expect(retryButton(page)).toBeFocused();
    });
  });
}

test.describe("phone and touch", () => {
  test.use({ hasTouch: true });

  test("touch: tapping the copy button copies the active node ID on a phone", async ({ page }) => {
    await recordClipboard(page);
    await mountHarness(page, "light", { width: 390, height: 844 }, populatedSeed);
    await open(page, "page");

    await copyButton(page).tap();
    await expect.poll(() => lastClipboardWrite(page)).toBe(HOSTED_DID);
  });

  test("reduced motion: no animation runs on the node cards", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mountHarness(page, "light", { width: 1280, height: 800 }, populatedSeed);
    await open(page, "drawer");

    const running = await cards(page).first().evaluate((el) => el.getAnimations({ subtree: true }).length);
    expect(running).toBe(0);
  });

  test("360 px: the page reflows without horizontal scroll and every control is on screen", async ({ page }) => {
    await mountHarness(page, "light", { width: 360, height: 740 }, populatedSeed);
    await open(page, "page");
    await settleSlide(section(page));

    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(360);

    const copy = await copyButton(page).boundingBox();
    expect(copy).not.toBeNull();
    expect(copy!.x).toBeGreaterThanOrEqual(0);
    expect(copy!.x + copy!.width).toBeLessThanOrEqual(360);
    expect(copy!.width).toBeGreaterThanOrEqual(44);
    expect(copy!.height).toBeGreaterThanOrEqual(44);

    // Labels and values wrap; none is clipped by its box.
    const clipped = await cards(page).evaluateAll((items) =>
      items.flatMap((item) =>
        Array.from(item.querySelectorAll<HTMLElement>(".label, .note, .nd-did, dd")).filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent ?? ""),
      ),
    );
    expect(clipped).toEqual([]);
  });
});
