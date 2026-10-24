import { expect, test, type Locator, type Page } from "@playwright/test";
import { row } from "./fixtures/contrast";
import { routeUiHarness } from "./fixtures/ui-route";

const ORIGIN = "http://tinycloud-ui.test";
const REPLICA_DB = "tinycloud-replica-kv";
const TOMBSTONE_KEY = "tinycloud-replica:deny-tombstone";
const TOMBSTONE = '{"epoch":3,"deniedAt":1700000000000}';

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

type PurgeAnswer = "real" | "skip" | "fail" | "fail-now";

interface HarnessWindow {
  __tc: {
    mount(ui?: unknown): boolean;
    setSync(state: unknown): boolean;
    setPurge(answers: PurgeAnswer[]): boolean;
    setWipe(mode: "ok" | "fail" | "hold"): boolean;
    releaseWipe(): boolean;
    wipeCalls(): number;
    purgeCalls(): number;
    callLog(): string[];
    signOutCalls(): number;
    createReplicaDb(): Promise<void>;
    replicaDatabases(): Promise<string[]>;
  };
  tc?: { ui: { open(section?: string): void; openPage(section?: string): void } };
}

const SYNC = {
  off: { requested: false, effective: "off" },
  on: { requested: true, effective: "on" },
  enabling: { requested: true, effective: "enabling" },
  pending: { requested: true, effective: "pending", reason: "erase-pending" },
  unavailable: { requested: true, effective: "unavailable", reason: "storage-blocked" },
} as const;

/** Local copy status the stub serves, as the mockup's "on with folders" state. */
function seedOn(over: Record<string, unknown> = {}) {
  return {
    source: "stub",
    requested: true,
    effective: "on",
    pending: 3,
    bytesOnDevice: 50_540_000,
    lastSyncedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    folders: [
      { prefix: "notes/", state: "ok", items: 214, bytes: 6_710_000, waiting: 2 },
      { prefix: "recordings/", state: "ok", items: 31, bytes: 43_830_000, waiting: 1 },
    ],
    ...over,
  };
}

interface MountOptions {
  scheme?: "light" | "dark";
  viewport?: { width: number; height: number };
  seed?: Record<string, unknown>;
  sync?: (typeof SYNC)[keyof typeof SYNC];
  purge?: PurgeAnswer[];
  wipe?: "ok" | "fail" | "hold";
}

async function mount(page: Page, options: MountOptions = {}) {
  await page.emulateMedia({ colorScheme: options.scheme ?? "light" });
  await page.setViewportSize(options.viewport ?? { width: 1280, height: 800 });
  const seed = options.seed;
  if (seed !== undefined) {
    await page.addInitScript((value) => {
      (window as unknown as { __TC_STUB_SEED__: unknown }).__TC_STUB_SEED__ = { localCopy: value };
    }, seed);
  }
  await routeUiHarness(page);
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(
    ({ sync, purge, wipe }) => {
      const tc = (window as unknown as HarnessWindow).__tc;
      if (sync) tc.setSync(sync);
      if (purge) tc.setPurge(purge);
      if (wipe) tc.setWipe(wipe);
      tc.mount();
    },
    { sync: options.sync, purge: options.purge, wipe: options.wipe },
  );
}

const panel = (page: Page) => page.locator("#tinycloud-ui-panel");
const toggle = (page: Page) => panel(page).getByRole("switch", { name: "Keep a local copy on this device" });
const wipeButton = (page: Page) => panel(page).locator("section.lc-wipe > button.action");
const confirmBox = (page: Page) => panel(page).locator(".confirm");
const keepButton = (page: Page) => confirmBox(page).getByRole("button", { name: "Keep local data" });
const confirmButton = (page: Page) => confirmBox(page).getByRole("button", { name: /^Wipe local data$|^Wiping…$/ });
const toastText = (page: Page) => page.locator(".toast__message");

async function openCopy(page: Page, layout: "drawer" | "page" = "drawer") {
  await page.evaluate((target) => {
    const ui = (window as unknown as HarnessWindow).tc?.ui;
    if (target === "page") ui?.openPage("local-copy");
    else ui?.open("local-copy");
  }, layout);
  await expect(panel(page).locator(".sec-title")).toHaveText("Local copy");
}

const call = <T,>(page: Page, run: (tc: HarnessWindow["__tc"]) => T) =>
  page.evaluate(`(${run.toString()})(window.__tc)`) as Promise<Awaited<T>>;

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test("off with a known empty copy: heading, lede, switch off, plain explanation, no wipe", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn({ requested: false, effective: "off", bytesOnDevice: 0, pending: 0, folders: [] }) });
      await openCopy(page);
      await expect(panel(page).locator(".lc-lede")).toHaveText(/Keep a copy of your data in this browser/);
      await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
      await expect(panel(page)).toContainText("Reads and writes go straight to your TinyCloud");
      await expect(panel(page)).toContainText("The local copy is off.");
      await expect(panel(page)).toContainText("Nothing is kept on this device.");
      // The mockup hides the Wipe block when the copy is off and known empty.
      await expect(panel(page).locator(".lc-wipe")).toBeHidden();
      await expect(wipeButton(page)).toBeHidden();
    });

    test("off with an unknown size never says nothing is kept, and still offers the wipe", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn({ requested: false, effective: "off", bytesOnDevice: undefined, folders: [] }) });
      await openCopy(page);
      await expect(panel(page)).toContainText("What is kept on this device is unknown.");
      await expect(panel(page)).not.toContainText("Nothing is kept on this device");
      await expect(wipeButton(page)).toBeVisible();
      await expect(wipeButton(page)).toBeEnabled();
    });

    test("unknown size, waiting count, sync time and folder figures read 'unknown', never zero", async ({ page }) => {
      await mount(page, {
        scheme,
        seed: seedOn({ bytesOnDevice: undefined, pending: undefined, lastSyncedAt: undefined, folders: [{ prefix: "notes/", state: "ok" }] }),
        sync: SYNC.on,
      });
      await openCopy(page);
      await expect(panel(page).locator(".st")).toHaveText("Last synced: unknown");
      await expect(panel(page).locator(".lc-cozy > div").nth(0)).toHaveText(/Waiting to sync\s*unknown/);
      await expect(panel(page).locator(".lc-cozy > div").nth(1)).toHaveText(/Size on this device\s*unknown/);
      await expect(panel(page).locator("section.lc-sec dl.lc-kv > div").nth(0)).toHaveText(/notes\/\s*details unknown/);
      await expect(panel(page)).not.toContainText(/\b0 B\b/);
      await expect(panel(page)).not.toContainText("Nothing is kept on this device");
      await wipeButton(page).click();
      await expect(confirmBox(page)).toContainText("It isn't known whether all changes have synced.");
    });

    test("switch on shows the status, ledger rows and folders; the switch keeps focus", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn() });
      await openCopy(page);
      await toggle(page).focus();
      await toggle(page).press("Space");
      await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
      await expect(toggle(page)).toBeFocused();
      await expect(panel(page).locator(".st")).toHaveText("Synced 2 min ago");
      await expect(panel(page).locator(".lc-cozy > div").nth(0)).toHaveText(/Waiting to sync\s*3 changes/);
      await expect(panel(page).locator(".lc-cozy > div").nth(1)).toHaveText(/Size on this device\s*48\.2 MiB/);
      await expect(panel(page).locator("section.lc-sec dl.lc-kv > div").nth(0)).toHaveText(/notes\/\s*214 items · 6\.4 MiB · 2 waiting/);
      await expect(panel(page).locator(".lc-cnt")).toHaveText("2");
      await expect(toggle(page)).toBeFocused();
    });

    test("wipe is two steps: the button only asks; Keep takes the safe action and nothing is erased", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn(), sync: SYNC.on });
      await openCopy(page);
      await expect(panel(page).locator(".lc-wipe > p")).toHaveText(
        "Erases TinyCloud's copy on this device. Your data stays on your TinyCloud; the app's own files are not touched.",
      );
      await call(page, (tc) => tc.createReplicaDb());
      await wipeButton(page).click();
      await expect(confirmBox(page)).toHaveAttribute("role", "alertdialog");
      await expect(keepButton(page)).toBeFocused();
      const keepBox = await keepButton(page).boundingBox();
      const wipeBox = await confirmButton(page).boundingBox();
      expect(Math.abs((keepBox?.y ?? 0) - (wipeBox?.y ?? 99))).toBeLessThan(2);
      expect((wipeBox?.x ?? 0) > (keepBox?.x ?? 0)).toBe(true);
      await expect(confirmBox(page)).toContainText("Erases TinyCloud's copy on this device.");
      await expect(confirmBox(page)).toContainText("3 changes haven't synced yet. Wiping now loses them.");
      expect(await call(page, (tc) => tc.wipeCalls())).toBe(0);
      await keepButton(page).click();
      await expect(confirmBox(page)).toHaveCount(0);
      await expect(wipeButton(page)).toBeFocused();
      expect(await call(page, (tc) => tc.wipeCalls())).toBe(0);
      expect(await call(page, (tc) => tc.replicaDatabases())).toContain(REPLICA_DB);
    });

    test("Escape takes the safe action and the panel stays open", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn(), sync: SYNC.on });
      await openCopy(page);
      await wipeButton(page).click();
      await expect(keepButton(page)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(confirmBox(page)).toHaveCount(0);
      await expect(panel(page)).toBeVisible();
      await expect(wipeButton(page)).toBeFocused();
      expect(await call(page, (tc) => tc.wipeCalls())).toBe(0);
    });

    test("confirm wipes once, shows Wiping…, then the copy is gone and a toast says so", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn(), sync: SYNC.on, wipe: "hold" });
      await openCopy(page);
      await call(page, (tc) => tc.createReplicaDb());
      await wipeButton(page).click();
      await confirmButton(page).dblclick();
      await expect(confirmButton(page)).toHaveText("Wiping…");
      await expect(confirmButton(page)).toBeDisabled();
      await expect(toggle(page)).toBeDisabled();
      await expect(wipeButton(page)).toBeDisabled();
      expect(await call(page, (tc) => tc.wipeCalls())).toBe(1);
      await call(page, (tc) => tc.releaseWipe());
      await expect(confirmBox(page)).toHaveCount(0);
      await expect(toastText(page)).toContainText("Local data wiped. Your TinyCloud still has everything.");
      expect(await call(page, (tc) => tc.wipeCalls())).toBe(1);
      expect(await call(page, (tc) => tc.replicaDatabases())).not.toContain(REPLICA_DB);
      await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
      await expect(toggle(page)).toBeFocused();
    });

    test("turning the copy off asks first, and Keep leaves it on", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn(), sync: SYNC.on });
      await openCopy(page);
      await toggle(page).click();
      await expect(confirmBox(page)).toContainText("Turn off local copy and wipe local data?");
      await expect(keepButton(page)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
      await expect(toggle(page)).toBeFocused();
      expect(await call(page, (tc) => tc.wipeCalls())).toBe(0);
      await toggle(page).click();
      await confirmButton(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
      expect(await call(page, (tc) => tc.wipeCalls())).toBe(1);
    });

    test("a failed wipe shows a neutral line and Try again, which asks again; no raw code", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn(), sync: SYNC.on, wipe: "fail" });
      await openCopy(page);
      await wipeButton(page).click();
      await confirmButton(page).click();
      const fail = panel(page).locator(".lc-wipe .lc-fail");
      await expect(fail).toContainText("The wipe didn't finish. The copy may still be on this device.");
      await expect(panel(page)).not.toContainText("RAW_CODE_NOT_SHOWN");
      await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
      const retry = fail.getByRole("button", { name: "Try again" });
      await expect(retry).toBeFocused();
      await retry.click();
      await expect(confirmBox(page)).toBeVisible();
      expect(await call(page, (tc) => tc.wipeCalls())).toBe(1);
      await call(page, (tc) => tc.setWipe("ok"));
      await confirmButton(page).click();
      await expect(toastText(page)).toContainText("Local data wiped");
      expect(await call(page, (tc) => tc.wipeCalls())).toBe(2);
    });

    test("unavailable: plain words, no wipe, switch locked, rail says Unavailable", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn({ effective: "unavailable", reason: "storage-blocked" }), sync: SYNC.unavailable, viewport: { width: 1280, height: 800 } });
      await openCopy(page, "page");
      await expect(panel(page)).toContainText("This browser blocks the storage the local copy needs.");
      await expect(panel(page)).toContainText("Your data in TinyCloud is not affected.");
      await expect(wipeButton(page)).toBeHidden();
      await expect(toggle(page)).toBeDisabled();
      await expect(panel(page).locator(".nav-i", { hasText: "Local copy" }).locator(".nav-m")).toHaveText("Unavailable");
    });

    test("pending: warns on the rail, explains itself, and still offers the wipe", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn({ effective: "pending", reason: "erase-pending" }), sync: SYNC.pending });
      await openCopy(page, "page");
      await expect(panel(page).locator(".nav-i", { hasText: "Local copy" }).locator(".nav-m")).toHaveText("Pending");
      await expect(panel(page)).toContainText("Some local data may still be on this device.");
      await expect(toggle(page)).toBeDisabled();
      await expect(wipeButton(page)).toBeEnabled();
    });

    test("enabling: switch locked with the plain word", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn({ effective: "enabling" }), sync: SYNC.enabling });
      await openCopy(page);
      await expect(panel(page).locator(".lc-state")).toHaveText("Turning on the local copy");
      await expect(toggle(page)).toBeDisabled();
      await expect(wipeButton(page)).toBeDisabled();
    });

    test("rail shows On on the full page", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn(), sync: SYNC.on });
      await openCopy(page, "page");
      await expect(panel(page).locator(".nav-i", { hasText: "Local copy" }).locator(".nav-m")).toHaveText("On");
    });

    test("F7: data source says on while the facade is off: the rail and the body both say Off, and both follow a switch change", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn() }); // the harness facade starts off
      await openCopy(page, "page");
      const railWord = panel(page).locator(".nav-i", { hasText: "Local copy" }).locator(".nav-m");
      await expect(railWord).toHaveText("Off");
      await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
      await expect(panel(page)).toContainText("The local copy is off.");
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
      await expect(railWord).toHaveText("On");
    });

    test("text and the switch meet AA contrast on the surface they sit on", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn(), sync: SYNC.on });
      await openCopy(page, "page");
      const rows = await page.evaluate(() => {
        const read = (selector: string) => {
          const el = document.querySelector("[data-tinycloud-ui]")?.shadowRoot?.querySelector("#tinycloud-ui-panel")?.querySelector(selector);
          if (!el) return undefined;
          let bg = el;
          let background = "rgba(0, 0, 0, 0)";
          while (bg instanceof Element) {
            background = getComputedStyle(bg).backgroundColor;
            if (background !== "rgba(0, 0, 0, 0)") break;
            bg = bg.parentElement as Element;
          }
          return { color: getComputedStyle(el).color, background };
        };
        return {
          lede: read(".lc-lede"),
          sub: read(".lc-sub"),
          dt: read(".lc-cozy dt"),
          dd: read(".lc-cozy dd"),
          cnt: read(".lc-cnt"),
          status: read(".st"),
          body: read(".lc-wipe p"),
          prefix: read(".lc-prefix"),
        };
      });
      for (const [label, pair] of Object.entries(rows)) {
        expect(pair, label).toBeDefined();
        const result = row(label, pair!.color, pair!.background);
        expect(result.opaque, label).toBe(true);
        expect(result.ratio, label).toBeGreaterThanOrEqual(4.5);
      }
      const knob = await page.evaluate(() => {
        const el = document.querySelector("[data-tinycloud-ui]")?.shadowRoot?.querySelector("#tinycloud-ui-panel")?.querySelector(".switch .knob");
        return el ? getComputedStyle(el).backgroundColor : "";
      });
      const surface = await page.evaluate(() => {
        const el = document.querySelector("[data-tinycloud-ui]")?.shadowRoot?.querySelector("#tinycloud-ui-panel .main");
        return el ? getComputedStyle(el.closest(".panel") ?? el).backgroundColor : "";
      });
      expect(row("knob", knob, surface).ratio).toBeGreaterThanOrEqual(3);
    });

    test("the wipe confirm question and both actions meet AA contrast", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn(), sync: SYNC.on });
      await openCopy(page);
      await wipeButton(page).click();
      const pairs = await page.evaluate(() => {
        const root = document.querySelector("[data-tinycloud-ui]")?.shadowRoot?.querySelector("#tinycloud-ui-panel");
        const read = (el: Element | null | undefined, own: boolean) => {
          if (!el) return undefined;
          let node: Element | null = own ? el : el.parentElement;
          let background = "rgba(0, 0, 0, 0)";
          while (node) {
            background = getComputedStyle(node).backgroundColor;
            if (background !== "rgba(0, 0, 0, 0)") break;
            node = node.parentElement;
          }
          return { color: getComputedStyle(el).color, background };
        };
        const buttons = root?.querySelectorAll(".lc-confirm .action");
        return {
          question: read(root?.querySelector(".lc-confirm .busy"), false),
          keep: read(buttons?.[0], true),
          wipe: read(buttons?.[1], true),
        };
      });
      for (const [label, pair] of Object.entries(pairs)) {
        expect(pair, label).toBeDefined();
        const result = row(label, pair!.color, pair!.background);
        expect(result.opaque, label).toBe(true);
        expect(result.ratio, label).toBeGreaterThanOrEqual(4.5);
      }
    });

    test("the focus ring shows on the switch and the wipe button", async ({ page }) => {
      await mount(page, { scheme, seed: seedOn(), sync: SYNC.on });
      await openCopy(page);
      await page.keyboard.press("Tab");
      for (const control of [toggle(page), wipeButton(page)] as Locator[]) {
        while (!(await control.evaluate((el) => el.matches(":focus")))) await page.keyboard.press("Tab");
        const outline = await control.evaluate((el) => {
          const style = getComputedStyle(el);
          return { style: style.outlineStyle, width: style.outlineWidth };
        });
        expect(outline.style).not.toBe("none");
        expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
      }
    });
  });
}

for (const size of [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
]) {
  test.describe(`phone ${size.width}`, () => {
  test.use({ hasTouch: true });
  test(`phone ${size.width}: full page only, controls are 44px, reachable by touch, no horizontal overflow`, async ({ page }) => {
    await mount(page, { viewport: size, seed: seedOn(), sync: SYNC.on, wipe: "hold" });
    await openCopy(page);
    await expect(panel(page)).toHaveAttribute("data-layout", "page");
    for (const control of [toggle(page), wipeButton(page)]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
    const overflow = await panel(page).locator(".main").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // Touch: tap the Wipe button, then the safe action.
    await wipeButton(page).scrollIntoViewIfNeeded();
    const wipeBox = await wipeButton(page).boundingBox();
    await page.touchscreen.tap((wipeBox?.x ?? 0) + 10, (wipeBox?.y ?? 0) + 10);
    await expect(confirmBox(page)).toBeVisible();
    // Narrow widths stack the two actions, as the mockup does: same left edge, Keep above Wipe, equal width.
    const stackKeep = await keepButton(page).boundingBox();
    const stackWipe = await confirmButton(page).boundingBox();
    expect(Math.abs((stackKeep?.x ?? 0) - (stackWipe?.x ?? 99))).toBeLessThan(2);
    expect((stackKeep?.y ?? 99) < (stackWipe?.y ?? 0)).toBe(true);
    expect(Math.abs((stackKeep?.width ?? 0) - (stackWipe?.width ?? 99))).toBeLessThan(2);
    for (const control of [keepButton(page), confirmButton(page)]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width);
    }
    await keepButton(page).tap();
    await expect(confirmBox(page)).toHaveCount(0);
    expect(await call(page, (tc) => tc.wipeCalls())).toBe(0);
  });
  });
}

// Sign-out removes the local copy once the session has ended. The harness's fake purge performs a real
// indexedDB.deleteDatabase on the real replica database name.
const PURGE_REAL: PurgeAnswer = process.env.TC_E2E_PURGE_SKIPPED === "1" ? "skip" : "real";

async function signOutThroughPanel(page: Page) {
  await page.evaluate(() => (window as unknown as HarnessWindow).tc?.ui.open());
  await panel(page).locator(".account-signout").click();
  await panel(page).locator(".confirm").getByRole("button", { name: "Sign out", exact: true }).click();
}

async function signedOutWithReplica(page: Page, purge: PurgeAnswer[]) {
  await mount(page, { sync: SYNC.on, seed: seedOn(), purge });
  await call(page, (tc) => tc.createReplicaDb());
  await page.evaluate(([key, value]) => localStorage.setItem(key as string, value as string), [TOMBSTONE_KEY, TOMBSTONE]);
  expect(await call(page, (tc) => tc.replicaDatabases())).toContain(REPLICA_DB);
}

test.describe("sign-out removes the local copy", () => {
  test("the copy is purged strictly after sign-out resolves; no database remains, also after a reload", async ({ page }) => {
    await signedOutWithReplica(page, [PURGE_REAL]);
    await signOutThroughPanel(page);
    await expect(panel(page).getByText("TinyCloud is signed out in this app")).toBeVisible();
    expect(await call(page, (tc) => tc.callLog())).toEqual(["signOut:start", "signOut:end", `purge:${PURGE_REAL}`]);
    expect(await call(page, (tc) => tc.replicaDatabases())).not.toContain(REPLICA_DB);
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __tc?: unknown }).__tc !== undefined);
    expect(await call(page, (tc) => tc.replicaDatabases())).not.toContain(REPLICA_DB);
  });

  test("the panel never touches the deny tombstone", async ({ page }) => {
    await signedOutWithReplica(page, [PURGE_REAL]);
    await signOutThroughPanel(page);
    await expect(panel(page).getByText("TinyCloud is signed out in this app")).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), TOMBSTONE_KEY)).toBe(TOMBSTONE);
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("tinycloud-replica:")));
    expect(keys).toEqual([TOMBSTONE_KEY]);
  });

  test("a failed purge warns neutrally with Retry; Retry calls purge again and clears it", async ({ page }) => {
    await signedOutWithReplica(page, ["fail", PURGE_REAL]);
    await signOutThroughPanel(page);
    await expect(toastText(page)).toContainText("The local copy on this browser was not removed yet. Try again from Local copy.");
    await expect(toastText(page)).not.toContainText("Signed out");
    expect(await call(page, (tc) => tc.replicaDatabases())).toContain(REPLICA_DB);
    expect(await call(page, (tc) => tc.purgeCalls())).toBe(1);
    await openCopy(page);
    const retry = panel(page).locator(".lc-purge").getByRole("button", { name: "Try again" });
    await expect(panel(page).locator(".lc-purge")).toContainText("The local copy on this browser was not removed yet.");
    await expect(panel(page).locator(".lc-purge")).not.toContainText("we'll try again");
    await retry.click();
    await expect(panel(page).locator(".lc-purge")).toBeHidden();
    expect(await call(page, (tc) => tc.purgeCalls())).toBe(2);
    expect(await call(page, (tc) => tc.replicaDatabases())).not.toContain(REPLICA_DB);
    expect(await page.evaluate((key) => localStorage.getItem(key), TOMBSTONE_KEY)).toBe(TOMBSTONE);
  });

  test("retryNow retries once at once, with no warning when that works", async ({ page }) => {
    await signedOutWithReplica(page, ["fail-now", PURGE_REAL]);
    await signOutThroughPanel(page);
    await expect(panel(page).getByText("TinyCloud is signed out in this app")).toBeVisible();
    expect(await call(page, (tc) => tc.callLog())).toEqual(["signOut:start", "signOut:end", "purge:fail-now", `purge:${PURGE_REAL}`]);
    await expect(toastText(page)).toHaveCount(0);
    expect(await call(page, (tc) => tc.replicaDatabases())).not.toContain(REPLICA_DB);
  });

  test("retryNow that still fails warns that the copy may still be readable", async ({ page }) => {
    await signedOutWithReplica(page, ["fail-now"]);
    await signOutThroughPanel(page);
    await expect(toastText(page)).toContainText("may still be readable here");
    expect((await call(page, (tc) => tc.callLog())).filter((entry) => entry.startsWith("purge"))).toHaveLength(2);
    await openCopy(page);
    await expect(panel(page).locator(".lc-purge")).toContainText("may still be readable here");
    expect(await call(page, (tc) => tc.replicaDatabases())).toContain(REPLICA_DB);
  });
});

// The plain text that says what Wipe does is on screen before anything is pressed, and the confirm repeats
// what happens before its destructive action is pressed.
const WIPE_EXPLAINS = "Erases TinyCloud's copy on this device. Your data stays on your TinyCloud; the app's own files are not touched.";
const WIPE_LAYOUTS = [
  { name: "sidebar", viewport: { width: 1280, height: 800 }, layout: "drawer" as const },
  { name: "page", viewport: { width: 1280, height: 800 }, layout: "page" as const },
  { name: "phone 390", viewport: { width: 390, height: 844 }, layout: "drawer" as const },
];

for (const scheme of ["light", "dark"] as const) {
  for (const { name, viewport, layout } of WIPE_LAYOUTS) {
    test(`${scheme} ${name}: the wipe explanation is visible before Wipe is pressed, and the confirm says what happens`, async ({ page }) => {
      await mount(page, { scheme, viewport, seed: seedOn(), sync: SYNC.on });
      await openCopy(page, layout);
      const explanation = panel(page).locator(".lc-wipe > p");
      await wipeButton(page).scrollIntoViewIfNeeded();
      await expect(explanation).toBeVisible();
      await expect(explanation).toHaveText(WIPE_EXPLAINS);
      await expect(wipeButton(page)).toBeVisible();
      await expect(confirmBox(page)).toHaveCount(0);

      // Assistive tech reads the explanation with the button: check the browser's accessibility tree, not the attribute.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Accessibility.enable");
      const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
        nodes: Array<{ role?: { value?: string }; name?: { value?: string }; description?: { value?: string } }>;
      };
      const buttons = nodes.filter((node) => node.role?.value === "button" && node.name?.value === "Wipe local data");
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.description?.value).toBe(WIPE_EXPLAINS);
      await cdp.detach();

      await wipeButton(page).click();
      await expect(confirmBox(page)).toBeVisible();
      const question = confirmBox(page).locator(".busy");
      await expect(question).toBeVisible();
      await expect(question).toContainText(WIPE_EXPLAINS);
      await expect(question).toContainText("3 changes haven't synced yet. Wiping now loses them.");
      // Nothing is erased until the destructive action is pressed.
      expect(await call(page, (tc) => tc.wipeCalls())).toBe(0);
      await expect(confirmButton(page)).toBeVisible();
    });
  }
}

// Escape during a running wipe must not close the confirm box, so the Wiping… state stays on screen.
// The shared confirm box ignores Escape while its actions are disabled.
test("Escape during a running wipe keeps the confirm box and its Wiping… state", async ({ page }) => {
  await mount(page, { seed: seedOn(), sync: SYNC.on, wipe: "hold" });
  await openCopy(page);
  await wipeButton(page).click();
  await confirmButton(page).click();
  await expect(confirmButton(page)).toHaveText("Wiping…");
  await confirmBox(page).dispatchEvent("keydown", { key: "Escape", bubbles: true });
  await expect(confirmBox(page)).toBeVisible();
  await expect(confirmButton(page)).toHaveText("Wiping…");
  await call(page, (tc) => tc.releaseWipe());
});
