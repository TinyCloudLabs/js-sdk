import { expect, test, type Locator, type Page } from "@playwright/test";
import { textRow, type ContrastRow } from "./fixtures/contrast";
import { routeUiHarness } from "./fixtures/ui-route";

const ORIGIN = "http://tinycloud-ui.test";
const HOST = "http://127.0.0.1:8787";
const DID = "did:key:z6MkEXAMPLEabcdefghijklmnopqrstuvwxyz0123456789";

interface HarnessWindow {
  __tc: { mount(ui?: unknown): boolean };
  __TC_STUB_SEED__?: unknown;
  tc?: { ui: { open(section?: string): void } };
}

type Scheme = "light" | "dark";
const DESKTOP = { width: 1280, height: 800 };
const PHONE_360 = { width: 360, height: 740 };

const NODES = {
  looking: { connection: "looking" },
  found: { connection: "found", url: HOST, identity: { origin: HOST, nodeDid: DID }, version: "v0.14.2" },
  "not-found": { connection: "not-found" },
  unavailable: { connection: "unavailable" },
} as const;

const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const toggle = (page: Page) => panel(page).locator("button.switch");

// Page and console errors are collected per test and asserted empty in afterEach.
const pageErrors = new Map<Page, string[]>();

test.beforeEach(({ page }) => {
  const list: string[] = [];
  pageErrors.set(page, list);
  page.on("pageerror", (error) => list.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") list.push(`console: ${message.text()}`);
  });
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

interface MountOptions {
  scheme?: Scheme;
  viewport?: { width: number; height: number };
  node?: unknown;
  reduced?: boolean;
}

// `node` seeds the stub's local-node state; without it the stub default (off) applies.
async function mount(page: Page, options: MountOptions = {}) {
  await page.emulateMedia({
    colorScheme: options.scheme ?? "light",
    reducedMotion: options.reduced ? "reduce" : "no-preference",
  });
  await page.setViewportSize(options.viewport ?? DESKTOP);
  if (options.node) {
    await page.addInitScript(
      (seed) => {
        const w: HarnessWindow = window;
        w.__TC_STUB_SEED__ = seed;
      },
      { localNode: options.node },
    );
  }
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => {
    const w: HarnessWindow = window;
    w.__tc.mount();
  });
}

// Opens the panel directly on the Local TinyCloud section, the same path the other specs use.
async function openLocal(page: Page) {
  await page.evaluate(() => {
    const w: HarnessWindow = window;
    w.tc?.ui.open("local-tinycloud");
  });
  await expect(toggle(page)).toBeVisible();
}

// The nearest ancestor with a non-transparent background, so contrast uses what the text sits on.
async function surfaceOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
    }
    return "rgb(255, 255, 255)";
  });
}

async function expectAA(page: Page, rows: Array<{ label: string; selector: string }>) {
  const results: ContrastRow[] = [];
  for (const { label, selector } of rows) {
    const locator = panel(page).locator(selector).first();
    await expect(locator).toBeVisible();
    results.push(await textRow(label, locator, await surfaceOf(locator)));
  }
  for (const result of results) {
    expect(result.opaque, `${result.label} sits on an opaque background`).toBe(true);
    expect(result.ratio, `${result.label} contrast`).toBeGreaterThanOrEqual(4.5);
  }
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test("off: the switch reads Off and the card explains what turning it on does", async ({ page }) => {
      await mount(page, { scheme });
      await openLocal(page);
      await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
      await expect(toggle(page)).toBeEnabled();
      await expect(panel(page).locator(".ll-word")).toHaveText("Off");
      await expect(panel(page).locator(".ll-card")).toContainText("talks to your hosted TinyCloud only");
    });

    test("switch label uses the display face at 16 px", async ({ page }) => {
      await mount(page, { scheme });
      await openLocal(page);
      await expect(panel(page).locator(".ll-label")).toHaveCSS("font-family", /Literata/);
      await expect(panel(page).locator(".ll-label")).toHaveCSS("font-size", "16px");
    });

    // The sub-line sits 2 px under the label (mock `.swrow .sub`), and the label+sub block is centred on the switch.
    for (const [state, node] of [
      ["off", undefined],
      ["found", NODES.found],
      ["not-found", NODES["not-found"]],
    ] as const) {
      test(`switch row: sub-line sits under the label and the block is centred on the switch (${state})`, async ({ page }) => {
        await mount(page, { scheme, node, viewport: PHONE_360 });
        await openLocal(page);
        const label = await panel(page).locator(".ll-label").boundingBox();
        const sub = await panel(page).locator(".ll-sub").boundingBox();
        const sw = await toggle(page).boundingBox();
        if (!label || !sub || !sw) throw new Error("switch row is not laid out");
        const gap = sub.y - (label.y + label.height);
        expect(gap, "label bottom to sub-line top").toBeGreaterThanOrEqual(0);
        expect(gap, "label bottom to sub-line top").toBeLessThanOrEqual(4);
        const blockCentre = (label.y + sub.y + sub.height) / 2;
        expect(Math.abs(blockCentre - (sw.y + sw.height / 2)), "block centre vs switch centre").toBeLessThanOrEqual(4);
      });
    }

    test("off card: white on the full-page layout in light, the dark card surface in dark", async ({ page }) => {
      await mount(page, { scheme, viewport: PHONE_360 });
      await openLocal(page);
      await expect(panel(page).locator(".ll-card")).toHaveCSS(
        "background-color",
        scheme === "light" ? "rgb(255, 255, 255)" : "rgb(21, 21, 23)",
      );
    });

    test("looking: the switch stays on and Cancel turns the node off", async ({ page }) => {
      await mount(page, { scheme, node: NODES.looking });
      await openLocal(page);
      await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
      await expect(toggle(page)).toBeEnabled();
      await panel(page).locator(".ll-card").getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
    });

    test("found: the node id, version, and host show, each with a copy action", async ({ page }) => {
      await mount(page, { scheme, node: NODES.found });
      await openLocal(page);
      await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
      await expect(panel(page).locator(".ll-did")).toHaveAttribute("title", DID);
      await expect(panel(page).locator(".ll-did")).toHaveText(`${DID.slice(0, 12)}…${DID.slice(-6)}`);
      await expect(panel(page).locator(".ll-mono").first()).toHaveText(HOST);
      await expect(panel(page).locator(".ll-kv button")).toHaveCount(2);
      await expect(panel(page).getByRole("button", { name: "Check again", exact: true })).toBeVisible();
    });

    test("found with details missing: each value reads Unknown, with no copy action and no zero", async ({ page }) => {
      await mount(page, { scheme, node: { source: "stub", connection: "found" } });
      await openLocal(page);
      await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
      await expect(panel(page).locator(".ll-kv dd")).toHaveText(["Unknown", "Unknown", "Unknown"]);
      await expect(panel(page).locator(".ll-unknown")).toHaveCount(3);
      await expect(panel(page).locator(".ll-kv button")).toHaveCount(0);
    });

    test("not found: lists the three steps with the start command, and offers a retry", async ({ page }) => {
      await mount(page, { scheme, node: NODES["not-found"] });
      await openLocal(page);
      await expect(panel(page).locator(".ll-steps li")).toHaveCount(3);
      await expect(panel(page).locator(".ll-steps code")).toHaveText("tinycloud start");
      await expect(panel(page).getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    });

    test("not found: the title and the unchanged line share one paragraph, and the steps heading is an eyebrow", async ({ page }) => {
      await mount(page, { scheme, node: NODES["not-found"] });
      await openLocal(page);
      await expect(panel(page).locator(".ll-body")).toHaveCount(1);
      await expect(panel(page).locator(".ll-body strong")).toHaveText("We couldn't find TinyCloud on this computer.");
      await expect(panel(page).locator(".ll-eyebrow")).toHaveText("To start it");
    });

    test("not found eyebrow meets AA contrast on its surface", async ({ page }) => {
      await mount(page, { scheme, node: NODES["not-found"] });
      await openLocal(page);
      await expectAA(page, [{ label: "steps heading", selector: ".ll-eyebrow" }]);
    });

    test("unavailable: the switch is disabled and the card says why", async ({ page }) => {
      await mount(page, { scheme, node: NODES.unavailable });
      await openLocal(page);
      await expect(toggle(page)).toBeDisabled();
      await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
      await expect(panel(page).locator(".ll-card")).toContainText("can't be checked from this app");
    });

    test("off text meets AA contrast on its surface", async ({ page }) => {
      await mount(page, { scheme });
      await openLocal(page);
      await expectAA(page, [
        { label: "intro", selector: ".ll-intro" },
        { label: "sub line", selector: ".ll-sub" },
        { label: "switch word", selector: ".ll-word" },
        { label: "card body", selector: ".ll-body" },
      ]);
    });

    test("found text meets AA contrast on its surface", async ({ page }) => {
      await mount(page, { scheme, node: NODES.found });
      await openLocal(page);
      await expectAA(page, [
        { label: "key label", selector: ".ll-kv dt" },
        { label: "node id", selector: ".ll-did" },
        { label: "host", selector: ".ll-mono" },
      ]);
    });

    test("not found text meets AA contrast on its surface", async ({ page }) => {
      await mount(page, { scheme, node: NODES["not-found"] });
      await openLocal(page);
      await expectAA(page, [
        { label: "card body", selector: ".ll-body" },
        { label: "steps", selector: ".ll-steps" },
      ]);
    });
  });
}

for (const [name, viewport] of [["desktop", DESKTOP], ["360 px", PHONE_360]] as const) {
  test(`found: each Copy button sits clear of its value at ${name}`, async ({ page }) => {
    await mount(page, { viewport, node: NODES.found });
    await openLocal(page);
    const cells = panel(page).locator(".ll-kv dd > .ll-cell");
    await expect(cells).toHaveCount(2);
    // Both boxes are read in one evaluate so the drawer's slide-in transform applies to both alike.
    for (const cell of await cells.all()) {
      const gap = await cell.evaluate((el) => {
        const value = el.querySelector(".ll-did, .ll-mono")?.getBoundingClientRect();
        const copy = el.querySelector("button")?.getBoundingClientRect();
        return value && copy ? copy.left - value.right : null;
      });
      expect(gap).not.toBeNull();
      expect(gap ?? 0).toBeGreaterThanOrEqual(4);
    }
  });
}

test("keyboard: Space turns the node on and settles on found; Enter turns it off", async ({ page }) => {
  await mount(page);
  await openLocal(page);
  await toggle(page).focus();
  await expect(toggle(page)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true", { timeout: 5000 });
  await expect(panel(page).locator(".ll-did")).toBeVisible({ timeout: 5000 });
  await toggle(page).focus();
  await page.keyboard.press("Enter");
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false", { timeout: 5000 });
});

test("focus order: from the switch, Tab reaches the card's first control", async ({ page }) => {
  await mount(page, { node: NODES.found });
  await openLocal(page);
  await toggle(page).focus();
  await page.keyboard.press("Tab");
  await expect(panel(page).getByRole("button", { name: "Check again", exact: true })).toBeFocused();
});

test.describe("touch", () => {
  test.use({ hasTouch: true });

  test("tapping the switch turns the node on", async ({ page }) => {
    await mount(page);
    await openLocal(page);
    await toggle(page).tap();
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true", { timeout: 5000 });
  });
});

test("reduced motion: the looking spinner does not animate", async ({ page }) => {
  await mount(page, { node: NODES.looking, reduced: true });
  await openLocal(page);
  const animation = await panel(page).locator(".ll-spin").evaluate((el) => getComputedStyle(el).animationName);
  expect(animation).toBe("none");
});

test("at 360 px every control is reachable, meets 44 px, and no label is clipped", async ({ page }) => {
  await mount(page, { viewport: PHONE_360, node: NODES.found });
  await openLocal(page);
  await expect(toggle(page)).toBeInViewport();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // .ll-did is ellipsized by design; its full value is in the title attribute and the copy action.
  const clipped = await panel(page)
    .locator(".ll-intro, .ll-sub, .ll-word, .ll-strong, .ll-body, .ll-mono, .ll-steps")
    .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className));
  expect(clipped).toEqual([]);

  const controls = [toggle(page), panel(page).locator(".ll-kv button").first(), panel(page).locator(".ll-kv button").last()];
  for (const control of controls) {
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE_360.width);
  }
});
