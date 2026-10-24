import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
// Test-only deep import, pinned to jsdom 26.1.0 like storage-section.test.ts: a trusted click needs the event impl.
import { implSymbol } from "jsdom/lib/jsdom/living/generated/utils.js";

import type { StorageView, ViewResult } from "../../src/ui/data";
import { formatBinary, splitBinary, storageDisplay, storageSection } from "../../src/ui/sections/storage";
import type { PanelClient, SectionContext } from "../../src/ui/slots";
import { panelText } from "../../src/ui/strings-panel";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent"];
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

let page: Window;
const saved = new Map<string, unknown>();
const cleanups: Array<() => void> = [];

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: "https://app.example/page" }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
  g.MouseEvent = page.MouseEvent;
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  page.document.body.innerHTML = "";
});

function status(usedBytes: number, limitBytes: number | null, state: "ok" | "nearly_full" | "full", extra: object = {}) {
  return { source: "stub", usedBytes, limitBytes, state, manageUrl: "https://account.tinycloud.xyz/storage", ...extra };
}

describe("storageDisplay: state mapping", () => {
  // The word follows the status `state`; the panel has no threshold of its own.
  const cases: Array<[string, number, "ok" | "nearly_full" | "full", string, number]> = [
    ["0%", 0, "ok", "normal", 0],
    ["79%", 790, "ok", "normal", 79],
    ["80%", 800, "ok", "normal", 80],
    ["94% flagged nearly full", 940, "nearly_full", "nearly", 94],
    ["95% flagged nearly full", 950, "nearly_full", "nearly", 95],
    ["100%", 1000, "full", "full", 100],
    ["over the limit", 1500, "full", "full", 100],
  ];
  for (const [label, used, state, level, percent] of cases) {
    test(`${label}: ${level}, fill ${percent}%`, () => {
      const d = storageDisplay(status(used, 1000, state));
      expect(d?.level).toBe(level);
      expect(d?.percent).toBe(percent);
    });
  }

  test("over the limit leaves nothing", () => {
    expect(storageDisplay(status(1500, 1000, "full"))?.leftBytes).toBe(0);
    expect(storageDisplay(status(400, 1000, "ok"))?.leftBytes).toBe(600);
  });

  test("a zero limit has no meter to draw and nothing left", () => {
    const d = storageDisplay(status(0, 0, "full"));
    expect(d?.percent).toBeUndefined();
    expect(d?.leftBytes).toBe(0);
    expect(d?.level).toBe("full");
  });

  test("no limit: no meter, no left amount, never full", () => {
    const d = storageDisplay(status(5 * GIB, null, "ok"));
    expect(d?.percent).toBeUndefined();
    expect(d?.leftBytes).toBeUndefined();
    expect(d?.level).toBe("normal");
  });

  test("account totals win over the space; the plan is read from either, and blank means unknown", () => {
    const d = storageDisplay(
      status(10, 100, "ok", { plan: "free", account: { usedBytes: 600, limitBytes: 1000, plan: "paid" } }),
    );
    expect(d?.usedBytes).toBe(600);
    expect(d?.limitBytes).toBe(1000);
    expect(d?.plan).toBe("paid");
    expect(storageDisplay(status(10, 100, "ok", { plan: "free" }))?.plan).toBe("free");
    expect(storageDisplay(status(10, 100, "ok"))?.plan).toBeUndefined();
    expect(storageDisplay(status(10, 100, "ok", { plan: "" }))?.plan).toBeUndefined();
  });

  test("a malformed value is not a status", () => {
    expect(storageDisplay(undefined)).toBeUndefined();
    expect(storageDisplay({ usedBytes: -1, limitBytes: 10, state: "ok" })).toBeUndefined();
    expect(storageDisplay(status(1, 10, "ok", { state: "weird" }))).toBeUndefined();
  });

  test("no limit is never full, even when the body says full", () => {
    const d = storageDisplay(status(7, null, "full"));
    expect(d?.level).toBe("normal");
    expect(d?.percent).toBeUndefined();
  });

  test("account totals decide unlimited even when the space has a limit", () => {
    const d = storageDisplay(status(1, 10, "ok", { account: { usedBytes: 9, limitBytes: null } }));
    expect(d?.usedBytes).toBe(9);
    expect(d?.limitBytes).toBeNull();
    expect(d?.percent).toBeUndefined();
    expect(d?.level).toBe("normal");
  });

  test("malformed bodies are not a status: never a 0 and never a full bar", () => {
    const malformed: unknown[] = [
      null,
      "42",
      {},
      { usedBytes: -1, limitBytes: 10, state: "ok" },
      { usedBytes: 1.5, limitBytes: 10, state: "ok" },
      { usedBytes: "3", limitBytes: 10, state: "ok" },
      { usedBytes: 3, limitBytes: -10, state: "ok" },
      { usedBytes: 3, limitBytes: 10 },
      { usedBytes: 3, limitBytes: 10, state: "bogus" },
      { usedBytes: 3, limitBytes: 10, state: "ok", account: { usedBytes: -1, limitBytes: 100 } },
      { usedBytes: 3, limitBytes: 10, state: "ok", account: null },
    ];
    for (const value of malformed) expect(storageDisplay(value)).toBeUndefined();
  });

  test("a manage URL that is not https falls back to the account page", () => {
    expect(storageDisplay(status(1, 10, "ok", { manageUrl: "javascript:alert(1)" }))?.manageHref).toBe(
      "https://account.tinycloud.xyz/storage",
    );
    expect(storageDisplay(status(1, 10, "ok", { manageUrl: "https://a.example/m" }))?.manageHref).toBe(
      "https://a.example/m",
    );
  });
});

describe("storageDisplay: per space", () => {
  test("real data without perSpace shows no rows, not zero rows", () => {
    expect(storageDisplay(status(1, 10, "ok", { source: "real" }))?.spaces).toEqual([]);
  });

  test("rows are kept with their source; malformed rows are dropped", () => {
    const d = storageDisplay(
      status(300, 1000, "ok", {
        perSpace: [
          { source: "stub", space: "Personal", usage: { usedBytes: 200, limitBytes: null } },
          { source: "stub", space: "Work", usage: { usedBytes: -5, limitBytes: null } },
          { space: 7, usage: { usedBytes: 1, limitBytes: null } },
          null,
          { space: "Lab", usage: { usedBytes: 100, limitBytes: 500 } },
        ],
      }),
    );
    expect(d?.spaces).toEqual([
      { space: "Personal", usedBytes: 200, limitBytes: null, source: "stub" },
      { space: "Lab", usedBytes: 100, limitBytes: 500, source: "real" },
    ]);
  });
});

describe("binary sizes", () => {
  test("whole units, one decimal under a GiB, two from a GiB, carry at the unit edge", () => {
    expect(formatBinary(0)).toBe("0 B");
    expect(formatBinary(1000)).toBe("1000 B");
    expect(formatBinary(1536)).toBe("1.5 KiB");
    expect(formatBinary(GIB)).toBe("1 GiB");
    expect(formatBinary(Math.round(312.4 * MIB))).toBe("312.4 MiB");
    expect(formatBinary(Math.round(1.25 * GIB))).toBe("1.25 GiB");
    expect(formatBinary(1024 * 1024 - 1)).toBe("1 MiB");
    expect(splitBinary(5 * GIB)).toEqual({ amount: "5", unit: "GiB" });
  });
});

// ---- mounted page ----

function trustedClick(target: Element): void {
  const ev = new page.MouseEvent("click", { bubbles: true, cancelable: true });
  Object.defineProperty((ev as unknown as Record<symbol, object>)[implSymbol], "isTrusted", {
    get: () => true,
    set: () => {},
  });
  target.dispatchEvent(ev);
}

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

interface Rig {
  el: HTMLElement;
  set(result: ViewResult<StorageView> | undefined): void;
  /** An account change: the new account's cached view, then the reset listeners, as the shell does. */
  switchAccount(result: ViewResult<StorageView> | undefined): void;
  refreshes: string[];
  authority: string[];
  /** An own-storage-full episode starts or ends, as the client's episode view reports it. */
  setEpisode(on: boolean): void;
  /** How many times the page asked the shell to repaint statuses. */
  renders(): number;
}

interface RigOptions {
  authority?: () => { approved: boolean; code?: string };
  /** A request that settles when the test says so. Wins over `authority`. */
  authorityWith?: () => Promise<{ approved: boolean; code?: string }>;
  age?: number | undefined;
  refresh?: () => void;
  /** A read that settles when the test says so. */
  refreshWith?: () => Promise<void>;
  /** An own-storage-full episode is already on at mount. */
  episode?: boolean;
  /** No data source, as for a signed-out client. */
  noSource?: boolean;
  signedIn?: boolean;
}

function mount(initial: ViewResult<StorageView> | undefined, opts: RigOptions = {}): Rig {
  let latest = initial;
  const listeners = new Set<() => void>();
  const resetListeners = new Set<() => void>();
  const refreshes: string[] = [];
  const authority: string[] = [];
  const request = opts.authorityWith ?? (opts.authority ? async () => opts.authority!() : undefined);
  let episodeOn = opts.episode === true;
  const episodeListeners = new Set<() => void>();
  let renders = 0;
  const client = {
    id: 1,
    signedIn: () => opts.signedIn !== false,
    onReset: (fn: () => void) => {
      resetListeners.add(fn);
      return () => resetListeners.delete(fn);
    },
    storageEpisode: {
      current: () => (episodeOn ? {} : undefined),
      subscribe: (fn: () => void) => {
        episodeListeners.add(fn);
        return () => episodeListeners.delete(fn);
      },
    },
    requestAuthority: request
      ? async (kind: string) => {
          authority.push(kind);
          return request();
        }
      : undefined,
  } as unknown as PanelClient;
  const ctx = {
    client: () => client,
    onClientChange: () => () => undefined,
    appLabel: () => "Example app",
    requestRender: () => {
      renders += 1;
    },
    text: (code: string, params?: Record<string, string | number>) => panelText(code, params),
    data: {
      source: opts.noSource ? undefined : {},
      latest: () => latest,
      age: () => ("age" in opts ? opts.age : 5_000),
      refresh: async (key: string) => {
        refreshes.push(key);
        opts.refresh?.();
        await opts.refreshWith?.();
      },
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  } as unknown as SectionContext;
  const el = page.document.createElement("div");
  page.document.body.append(el);
  cleanups.push(storageSection.mount(el, ctx));
  const set = (result: ViewResult<StorageView> | undefined): void => {
    latest = result;
    for (const fn of [...listeners]) fn();
  };
  return {
    el,
    refreshes,
    authority,
    set,
    setEpisode(on) {
      episodeOn = on;
      for (const fn of [...episodeListeners]) fn();
    },
    renders: () => renders,
    switchAccount(result) {
      set(result);
      for (const fn of [...resetListeners]) fn();
    },
  };
}

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ready = (data: object): ViewResult<StorageView> => ({ state: "ready", data: data as StorageView });
const NORMAL = status(Math.round(312.4 * MIB), GIB, "ok", { plan: "early access demo" });

describe("storage page", () => {
  test("ready: the meter, its words, the plan, a new-tab manage link, and the age", () => {
    const { el } = mount(ready(NORMAL));
    expect(el.querySelector("h3.sec-title")?.textContent).toBe("Storage");
    expect(el.querySelector(".storage-fig")?.textContent).toBe("312.4 MiB of 1 GiB");
    const meter = el.querySelector('[role="meter"]');
    expect(meter?.getAttribute("aria-valuemin")).toBe("0");
    expect(meter?.getAttribute("aria-valuemax")).toBe(String(GIB));
    expect(meter?.getAttribute("aria-valuenow")).toBe(String(Math.round(312.4 * MIB)));
    expect(meter?.getAttribute("aria-valuetext")).toBe("312.4 MiB of 1 GiB used. Normal.");
    expect(meter?.getAttribute("aria-label")).toBe("Storage used");
    expect(el.querySelector(".storage-st")?.textContent).toBe("Normal");
    expect(el.querySelector(".storage-kv")?.textContent).toContain("Early access demo — 1 GiB");
    const link = el.querySelector<HTMLAnchorElement>("a.storage-manage");
    expect(link?.href).toBe("https://account.tinycloud.xyz/storage");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
    expect(el.querySelector(".storage-updated")?.textContent).toBe("Updated just now");
    expect(el.querySelector(".storage-banner")).toBeNull();
    expect(el.querySelector(".storage-near")).toBeNull();
  });

  test("no perSpace in the data: no By space section at all", () => {
    const { el } = mount(ready(status(1, 10, "ok", { source: "real" })));
    expect(el.querySelector(".storage-by-space")).toBeNull();
    expect(el.querySelectorAll('[role="meter"]').length).toBe(1);
  });

  test("perSpace renders a labelled meter per row, tagged with the row's source", () => {
    const { el } = mount(
      ready(
        status(300 * MIB, GIB, "ok", {
          perSpace: [
            { source: "stub", space: "Personal", usage: { usedBytes: 200 * MIB, limitBytes: null } },
            { source: "stub", space: "Work", usage: { usedBytes: 100 * MIB, limitBytes: null } },
          ],
        }),
      ),
    );
    const rows = el.querySelectorAll<HTMLElement>(".storage-space");
    expect(rows.length).toBe(2);
    expect(rows[0]?.dataset.source).toBe("stub");
    expect(rows[0]?.querySelector('[role="meter"]')?.getAttribute("aria-label")).toBe("Personal storage used");
    expect(rows[0]?.querySelector('[role="meter"]')?.getAttribute("aria-valuetext")).toBe("200 MiB of 1 GiB");
    expect(el.querySelector(".storage-by-space h4")?.textContent).toContain("2");
  });

  test("nearly full: amber word and a plain note, no banner", () => {
    const { el } = mount(ready(status(940, 1000, "nearly_full")));
    expect(el.querySelector(".storage-st")?.textContent).toBe("Nearly full");
    expect(el.querySelector(".storage-st")?.getAttribute("data-tone")).toBe("warn");
    expect(el.querySelector(".storage-near")?.textContent).toContain("close to your limit");
    expect(el.querySelector(".storage-banner")).toBeNull();
  });

  test("full: a banner in plain words with the manage link; the meter caps at the limit", () => {
    const { el } = mount(ready(status(1500, 1000, "full")));
    const banner = el.querySelector(".storage-banner");
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toContain("Storage full: you can't add more data right now.");
    expect(banner?.textContent).toContain("Your existing data stays as it is.");
    expect(banner?.querySelector("a")?.getAttribute("href")).toBe("https://account.tinycloud.xyz/storage");
    expect(el.querySelector(".storage-st")?.textContent).toBe("Full");
    const meter = el.querySelector('[role="meter"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe("1000");
    expect(meter?.getAttribute("aria-valuetext")).toBe("1.5 KiB of 1000 B used. Full.");
  });

  test("a zero limit draws no meter and still says full", () => {
    const { el } = mount(ready(status(0, 0, "full")));
    expect(el.querySelector('[role="meter"]')).toBeNull();
    expect(el.querySelector(".storage-st")?.textContent).toBe("Full");
  });

  test("no limit: the used amount without a meter or a made-up limit", () => {
    const { el } = mount(ready(status(2 * GIB, null, "ok")));
    expect(el.querySelector(".storage-fig")?.textContent).toBe("2 GiB No limit");
    expect(el.querySelector('[role="meter"]')).toBeNull();
    expect(el.querySelector(".storage-kv")?.textContent).toContain("No limit");
  });

  test("loading and a missing first read both say loading and show nothing else", () => {
    for (const first of [{ state: "loading" } as const, undefined]) {
      const { el } = mount(first);
      expect(el.querySelector('[role="status"]')?.textContent).toBe("Loading…");
      expect(el.querySelector('[role="meter"]')).toBeNull();
      expect(el.querySelector(".storage-updated")?.hasAttribute("hidden")).toBe(true);
    }
  });

  test("error: neutral words and Try again, which re-reads storage", async () => {
    const { el, refreshes } = mount({ state: "error", code: "boom" });
    expect(el.textContent).toContain("This didn't load.");
    const retry = [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => !b.hidden);
    expect(retry?.textContent).toBe("Try again");
    trustedClick(retry as HTMLButtonElement);
    await flush();
    expect(refreshes).toEqual(["storage"]);
    expect(el.textContent).not.toContain("boom");
  });

  test("a node that cannot report usage says so, with no Try again; any other error keeps Try again", () => {
    const visibleButtons = (el: HTMLElement) =>
      [...el.querySelectorAll("button")].filter((b) => b.closest("[hidden]") === null);
    for (const code of ["unsupported", "STORAGE_STATUS_UNAVAILABLE"]) {
      const { el } = mount({ state: "error", code });
      expect(el.querySelector('[role="status"]')?.textContent).toBe("Storage usage isn't available on this node.");
      expect(visibleButtons(el)).toEqual([]);
      expect(el.querySelector('[role="meter"]')).toBeNull();
      expect(el.textContent).not.toContain(code);
    }
    for (const code of ["NETWORK_ERROR", "boom"]) {
      const { el } = mount({ state: "error", code });
      expect(el.querySelector('[role="status"]')?.textContent).toBe("This didn't load.");
      expect(visibleButtons(el).map((b) => b.textContent)).toEqual(["Try again"]);
    }
  });

  test("a status that is not usable reads as unavailable, not as zeros", () => {
    const { el } = mount(ready({ source: "real", state: "ok" }));
    expect(el.querySelector('[role="status"]')?.textContent).toBe("Storage usage isn't available here.");
    expect(el.querySelector('[role="meter"]')).toBeNull();
  });

  test("needs permission with a request hook offers Allow storage details; approval re-reads", async () => {
    const { el, authority, refreshes } = mount(
      { state: "needs-permission", ability: "space/info" },
      { authority: () => ({ approved: true }) },
    );
    expect(el.querySelector(".storage-ask h4")?.textContent).toBe("Example app can't see your storage yet");
    const button = el.querySelector<HTMLButtonElement>(".storage-ask button");
    expect(button?.hidden).toBe(false);
    expect(button?.textContent).toBe("Allow storage details");
    expect(el.querySelector('[role="meter"]')).toBeNull();
    trustedClick(button as HTMLButtonElement);
    await flush();
    expect(authority).toEqual(["space/info"]);
    expect(refreshes).toEqual(["storage"]);
  });

  test("an untrusted click does not ask", async () => {
    const { el, authority } = mount(
      { state: "needs-permission", ability: "space/info" },
      { authority: () => ({ approved: true }) },
    );
    el.querySelector<HTMLButtonElement>(".storage-ask button")?.click();
    await flush();
    expect(authority).toEqual([]);
  });

  test("declined keeps the numbers hidden, says so, and offers Try again without re-reading", async () => {
    const { el, refreshes } = mount(
      { state: "needs-permission", ability: "space/info" },
      { authority: () => ({ approved: false, code: "declined" }) },
    );
    const button = el.querySelector<HTMLButtonElement>(".storage-ask button");
    trustedClick(button as HTMLButtonElement);
    await flush();
    expect(el.querySelector(".storage-ask .note")?.textContent).toBe("You declined. Storage usage stays hidden.");
    expect(button?.textContent).toBe("Try again");
    expect(refreshes).toEqual([]);
  });

  test("a refusal with code unsupported says this session is blocked, not that the user declined", async () => {
    const { el } = mount(
      { state: "needs-permission", ability: "space/info" },
      { authority: () => ({ approved: false, code: "unsupported" }) },
    );
    trustedClick(el.querySelector<HTMLButtonElement>(".storage-ask button") as HTMLButtonElement);
    await flush();
    expect(el.querySelector(".storage-ask .note")?.textContent).toBe("This session has no way to ask for it here.");
    expect(el.querySelector(".storage-ask .note")?.textContent).not.toContain("declined");
  });

  test("needs permission without a request hook: a neutral note and no button", () => {
    const { el } = mount({ state: "needs-permission", ability: "space/info" });
    expect(el.querySelector<HTMLButtonElement>(".storage-ask button")?.hidden).toBe(true);
    expect(el.querySelector(".storage-ask .note")?.textContent).toContain("no way to ask");
  });

  test("a permission for another ability is never asked as space/info", () => {
    const { el } = mount(
      { state: "needs-permission", ability: "space/list" },
      { authority: () => ({ approved: true }) },
    );
    expect(el.querySelector<HTMLButtonElement>(".storage-ask button")?.hidden).toBe(true);
  });

  test("a new cached result repaints; age text moves to minutes and hours", () => {
    const rig = mount(ready(NORMAL), { age: 3 * 60_000 });
    expect(rig.el.querySelector(".storage-updated")?.textContent).toBe("Updated 3 min ago");
    rig.set(ready(status(940, 1000, "nearly_full")));
    expect(rig.el.querySelector(".storage-st")?.textContent).toBe("Nearly full");
    rig.set({ state: "needs-permission", ability: "space/info" });
    expect(rig.el.querySelector('[role="meter"]')).toBeNull();
  });

  test("no age yet: no updated line", () => {
    const { el } = mount(ready(NORMAL), { age: undefined });
    expect(el.querySelector(".storage-updated")?.hasAttribute("hidden")).toBe(true);
  });

  test("state-only CSS is added when that state first renders, not before", () => {
    const rig = mount(ready(NORMAL));
    const css = () => rig.el.querySelector("style")?.textContent ?? "";
    expect(css()).not.toContain(".storage-banner");
    rig.set(ready(status(1000, 1000, "full")));
    expect(css()).toContain(".storage-banner");
    expect(css().split(".storage-banner strong{").length).toBe(2);
    rig.set(ready(status(1000, 1000, "full")));
    expect(css().split(".storage-banner strong{").length).toBe(2);
  });
});

describe("storage section: signed out", () => {
  test("it is not offered, and a mount without a data source shows the unavailable line, never a loading line or a retry", () => {
    const rig = mount(undefined, { noSource: true, signedIn: false });
    const visible = (selector: string) =>
      [...rig.el.querySelectorAll(selector)].filter((node) => node.closest("[hidden]") === null);
    expect(storageSection.isAvailable({ client: () => ({ signedIn: () => false }) } as unknown as SectionContext)).toBe(false);
    expect(rig.el.querySelector('[role="status"]')?.textContent).toBe("Storage usage isn't available here.");
    expect(rig.el.querySelector('[role="status"]')?.textContent).not.toContain("Loading");
    expect(visible("button")).toEqual([]);
    expect(rig.el.querySelector('[role="meter"]')).toBeNull();
  });

  test("a signed-in client is offered the section", () => {
    expect(storageSection.isAvailable({ client: () => ({ signedIn: () => true }) } as unknown as SectionContext)).toBe(true);
  });
});

describe("storage page: an own-storage-full episode", () => {
  const body = (el: HTMLElement) => ({
    word: el.querySelector(".storage-st")?.textContent,
    banner: el.querySelector(".storage-banner")?.textContent ?? "",
    meter: el.querySelector('[role="meter"]'),
    figure: el.querySelector(".storage-fig"),
  });

  test("the body says Full and drops the numbers even when the status says ok", () => {
    const { el } = mount(ready(NORMAL), { episode: true });
    const b = body(el);
    expect(b.word).toBe("Full");
    expect(b.banner).toContain("Storage full: you can't add more data right now.");
    expect(b.meter).toBeNull();
    expect(b.figure).toBeNull();
    expect(el.querySelector(".storage-updated")?.hasAttribute("hidden")).toBe(true);
  });

  test("an episode that starts while the page is open turns it to Full and asks the shell to repaint", () => {
    const rig = mount(ready(NORMAL));
    expect(body(rig.el).word).toBe("Normal");
    const before = rig.renders();
    rig.setEpisode(true);
    expect(body(rig.el).word).toBe("Full");
    expect(rig.renders()).toBe(before + 1);
  });

  test("when the episode ends the numbers come back after a re-read", async () => {
    const rig = mount(ready(NORMAL), { episode: true });
    rig.setEpisode(false);
    await flush();
    expect(rig.refreshes).toEqual(["storage"]);
    expect(body(rig.el).word).toBe("Normal");
    expect(body(rig.el).figure?.textContent).toContain("312.4");
  });

  test("a loading or failed read still says Full during an episode, with no loading line and no retry", () => {
    for (const result of [{ state: "loading" } as const, { state: "error", code: "boom" } as const]) {
      const { el } = mount(result, { episode: true });
      expect(body(el).word).toBe("Full");
      expect(el.querySelector('[role="status"]:not(.storage-banner)')?.hasAttribute("hidden")).toBe(true);
      expect([...el.querySelectorAll("button")].filter((b) => b.closest("[hidden]") === null).length).toBe(0);
    }
  });

  test("the manage link in the banner uses an https manageUrl from the last read, else the account page", () => {
    const withUrl = mount(ready(status(1, 10, "ok", { manageUrl: "https://a.example/m" })), { episode: true });
    expect(withUrl.el.querySelector<HTMLAnchorElement>(".storage-banner a")?.href).toBe("https://a.example/m");
    const without = mount({ state: "loading" }, { episode: true });
    expect(without.el.querySelector<HTMLAnchorElement>(".storage-banner a")?.href).toBe(
      "https://account.tinycloud.xyz/storage",
    );
  });
});

describe("storage status(ctx) alongside the page", () => {
  const ctx = (result: ViewResult<StorageView> | undefined) =>
    ({
      client: () => undefined,
      text: (code: string) => panelText(code),
      data: { source: {}, latest: () => result },
    }) as unknown as SectionContext;

  test("an own-storage-full episode makes the rail say Full whatever the cache says; no limit is never full", () => {
    const withEpisode = (on: boolean) =>
      ({
        client: () => ({ storageEpisode: { current: () => (on ? {} : undefined) } }),
        text: (code: string) => panelText(code),
        data: { source: {}, latest: () => ready(status(10, 1000, "ok")) },
      }) as unknown as SectionContext;
    expect(storageSection.status(withEpisode(true))).toEqual({ text: "Full", tone: "warn" });
    expect(storageSection.status(withEpisode(false))).toEqual({ text: "Normal", tone: "ok" });
    expect(storageSection.status(ctx(ready(status(7, null, "full"))))).toEqual({ text: "Normal", tone: "ok" });
  });

  test("Normal, Nearly full and Full from the cached view, with tones ok, warn, warn", () => {
    expect(storageSection.status(ctx(ready(status(0, 1000, "ok"))))).toEqual({ text: "Normal", tone: "ok" });
    expect(storageSection.status(ctx(ready(status(940, 1000, "nearly_full"))))).toEqual({
      text: "Nearly full",
      tone: "warn",
    });
    expect(storageSection.status(ctx(ready(status(1000, 1000, "full"))))).toEqual({ text: "Full", tone: "warn" });
  });
});

describe("storage page: results from a previous account", () => {
  const PERMISSION: ViewResult<StorageView> = { state: "needs-permission", ability: "space/info" };

  test("a refusal that arrives after an account change is not shown to the new account", async () => {
    const answer = deferred<{ approved: boolean; code?: string }>();
    const rig = mount(PERMISSION, { authorityWith: () => answer.promise });
    const button = rig.el.querySelector<HTMLButtonElement>(".storage-ask button") as HTMLButtonElement;
    trustedClick(button);
    await flush();

    rig.switchAccount(PERMISSION);
    answer.resolve({ approved: false, code: "declined" });
    await flush();

    expect(rig.el.querySelector(".storage-ask .note")?.hasAttribute("hidden")).toBe(true);
    expect(button.textContent).toBe("Allow storage details");
    expect(button.disabled).toBe(false);
  });

  test("an approval that arrives after an account change does not re-read for the new account", async () => {
    const answer = deferred<{ approved: boolean; code?: string }>();
    const rig = mount(PERMISSION, { authorityWith: () => answer.promise });
    trustedClick(rig.el.querySelector<HTMLButtonElement>(".storage-ask button") as HTMLButtonElement);
    await flush();

    rig.switchAccount(PERMISSION);
    answer.resolve({ approved: true });
    await flush();

    expect(rig.refreshes).toEqual([]);
  });

  test("a retry still in flight for the old account does not block the new account's retry", async () => {
    const first = deferred<void>();
    let calls = 0;
    const rig = mount(
      { state: "error", code: "boom" },
      { refreshWith: () => (++calls === 1 ? first.promise : new Promise<void>(() => undefined)) },
    );
    const retry = () =>
      [...rig.el.querySelectorAll<HTMLButtonElement>("button")].find((b) => !b.hidden && b.textContent === "Try again");
    trustedClick(retry() as HTMLButtonElement);
    await flush();
    expect(rig.refreshes).toEqual(["storage"]);

    rig.switchAccount({ state: "error", code: "other" });
    trustedClick(retry() as HTMLButtonElement);
    await flush();
    expect(rig.refreshes).toEqual(["storage", "storage"]);

    // The old read settling late changes nothing for the new account's read in flight.
    first.resolve();
    await flush();
    expect(rig.el.querySelector('[role="status"]')?.textContent).toBe("Loading…");
  });
});
