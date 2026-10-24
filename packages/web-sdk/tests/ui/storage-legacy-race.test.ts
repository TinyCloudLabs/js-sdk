import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
// Test-only deep import, pinned to jsdom 26.1.0 like storage-section.test.ts: a trusted click needs the event impl.
import { implSymbol } from "jsdom/lib/jsdom/living/generated/utils.js";

import { storageSection } from "../../src/ui/sections/storage";
import type { HostContext, PanelClient } from "../../src/ui/slots";
import { text } from "../../src/ui/strings";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent"];

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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const usage = (usedBytes: number) => ({
  data: { usedBytes, limitBytes: 1000, state: "ok", manageUrl: "https://a.example/manage" },
});
const DENIED = { error: { code: "PERMISSION_DENIED" } };

function mount(opts: {
  status: (call: number) => Promise<unknown>;
  authority?: () => Promise<{ approved: boolean; code?: string }>;
}) {
  let calls = 0;
  const resetListeners = new Set<() => void>();
  const client = {
    id: 1,
    signedIn: () => true,
    onReset: (fn: () => void) => {
      resetListeners.add(fn);
      return () => resetListeners.delete(fn);
    },
    storage: { status: () => opts.status(++calls) },
    requestAuthority: opts.authority,
  } as unknown as PanelClient;
  const ctx = {
    client: () => client,
    onClientChange: () => () => undefined,
    topStatus: () => null,
    text,
  } as unknown as HostContext;
  const el = page.document.createElement("div");
  page.document.body.append(el);
  cleanups.push(storageSection.mount(el, ctx));
  return {
    el,
    calls: () => calls,
    switchAccount: () => {
      for (const fn of [...resetListeners]) fn();
    },
  };
}

describe("storage section without a data source: results from a previous account", () => {
  test("a status read that settles after an account change is dropped", async () => {
    const old = deferred<unknown>();
    const h = mount({ status: (call) => (call === 1 ? old.promise : Promise.resolve(usage(700))) });
    await flush();

    h.switchAccount();
    await flush();
    expect(h.calls()).toBe(2);
    old.resolve(usage(100));
    await flush();

    const shown = h.el.querySelectorAll("p")[1]?.textContent ?? "";
    expect(shown).toContain("700");
    expect(shown).not.toContain("100");
  });

  test("a refusal that arrives after an account change is not shown to the new account", async () => {
    const answer = deferred<{ approved: boolean; code?: string }>();
    const h = mount({ status: () => Promise.resolve(DENIED), authority: () => answer.promise });
    await flush();
    trustedClick(h.el.querySelector("button.action") as HTMLButtonElement);
    await flush();

    h.switchAccount();
    await flush();
    answer.resolve({ approved: false, code: "declined" });
    await flush();

    expect(h.el.querySelectorAll("p")[2]?.textContent).toBe(text("storage.permission"));
  });
});
