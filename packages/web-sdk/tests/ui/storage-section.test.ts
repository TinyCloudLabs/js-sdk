import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
// Test-only. This deep import reaches into jsdom internals to reach the impl
// of a jsdom event, so it depends on jsdom's file layout. It is pinned to
// jsdom 26.1.0 (exact version in packages/web-sdk/package.json devDependencies).
// Re-check this path whenever jsdom is upgraded. It is not part of the SDK.
import { implSymbol } from "jsdom/lib/jsdom/living/generated/utils.js";

import { STORAGE_MANAGE_URL } from "@tinycloud/sdk-core";

import { storageSection } from "../../src/ui/sections/storage";
import type { HostContext, PanelClient } from "../../src/ui/slots";
import { text } from "../../src/ui/strings";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const ORIGIN = "https://app.example";
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent"];

let page: Window;
const saved = new Map<string, unknown>();
const cleanups: Array<() => void> = [];

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: `${ORIGIN}/page` }).window as unknown as Window;
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

// jsdom makes isTrusted non-configurable and resets it during dispatch. Pin the
// impl field to true for trusted clicks. Untrusted clicks dispatch as they are.
function clickEl(target: Element, trusted: boolean): void {
  const ev = new page.MouseEvent("click", { bubbles: true, cancelable: true });
  if (trusted) {
    const impl = (ev as unknown as Record<symbol, object>)[implSymbol];
    Object.defineProperty(impl, "isTrusted", { get: () => true, set: () => {} });
  }
  target.dispatchEvent(ev);
}

// The stubs resolve on microtasks only, so draining the queue is enough; no timers.
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const OK = {
  ok: true,
  data: { usedBytes: 50, limitBytes: 100, state: "ok", manageUrl: "https://a.example/manage" },
};
const DENIED = { ok: false, error: { code: "PERMISSION_DENIED" } };

interface Harness {
  client: PanelClient;
  statusCalls: () => number;
  authorityCalls: string[];
  setEpisode(on: boolean): void;
  fireEpisode(): void;
}

function harness(opts: {
  status: (call: number) => unknown;
  authority?: () => { approved: boolean; code?: string };
}): Harness {
  let statusCalls = 0;
  const authorityCalls: string[] = [];
  const listeners = new Set<() => void>();
  let episodeOn = false;
  const client = {
    id: 1,
    signedIn: () => true,
    onReset: () => () => undefined,
    storage: {
      status: async () => {
        statusCalls += 1;
        return opts.status(statusCalls);
      },
    },
    storageEpisode: {
      current: () => (episodeOn ? {} : undefined),
      subscribe(cb: () => void) {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    },
    requestAuthority: opts.authority
      ? async (kind: "kv/sync" | "space/info") => {
          authorityCalls.push(kind);
          return opts.authority!();
        }
      : undefined,
  } as unknown as PanelClient;
  return {
    client,
    statusCalls: () => statusCalls,
    authorityCalls,
    setEpisode(on) {
      episodeOn = on;
    },
    fireEpisode() {
      for (const cb of [...listeners]) cb();
    },
  };
}

function ctxFor(client: PanelClient): HostContext {
  return {
    client: () => client,
    onClientChange: () => () => undefined,
    developerMode: () => false,
    setStatus: () => undefined,
    topStatus: () => null,
    onStatusChange: () => () => undefined,
    toast: () => "",
    openPanel: () => undefined,
    closePanel: () => undefined,
    text,
  };
}

function mountStorage(client: PanelClient): HTMLElement {
  const el = page.document.createElement("div");
  page.document.body.append(el);
  cleanups.push(storageSection.mount(el, ctxFor(client)));
  return el;
}

// Rendered order: word, usage line, bar, note, action, manage link.
const parts = (el: HTMLElement) => {
  const paragraphs = el.querySelectorAll("p");
  return {
    word: paragraphs[0] as HTMLElement,
    usage: paragraphs[1] as HTMLElement,
    note: paragraphs[2] as HTMLElement,
    bar: el.querySelector(".storage-bar") as HTMLElement,
    action: el.querySelector("button.action") as HTMLButtonElement,
    manage: el.querySelector("a.action") as HTMLAnchorElement,
  };
};

describe("storage section", () => {
  test("permission approved refetches status and shows the state", async () => {
    const h = harness({
      status: (call) => (call === 1 ? DENIED : OK),
      authority: () => ({ approved: true }),
    });
    const el = mountStorage(h.client);
    await flush();

    const p = parts(el);
    expect(p.note.textContent).toBe(text("storage.permission"));
    expect(p.action.textContent).toBe(text("storage.allow"));

    clickEl(p.action, true);
    await flush();

    expect(h.authorityCalls).toEqual(["space/info"]);
    expect(h.statusCalls()).toBe(2);
    expect(parts(el).word.textContent).toBe(text("storage.state.ok"));
    expect(parts(el).action.hidden).toBe(true);
  });

  test("declined stays put: no status re-read, and an untrusted click does nothing", async () => {
    const h = harness({
      status: () => DENIED,
      authority: () => ({ approved: false, code: "declined" }),
    });
    const el = mountStorage(h.client);
    await flush();

    clickEl(parts(el).action, false);
    await flush();
    expect(h.authorityCalls).toEqual([]);

    clickEl(parts(el).action, true);
    await flush();

    expect(h.authorityCalls).toEqual(["space/info"]);
    expect(h.statusCalls()).toBe(1);
    expect(parts(el).note.textContent).toBe(text("storage.declined"));
    expect(parts(el).action.textContent).toBe(text("storage.try_again"));
  });

  test("an episode says full and shows no numbers even when status says ok", async () => {
    const h = harness({ status: () => OK });
    h.setEpisode(true);
    const el = mountStorage(h.client);
    await flush();

    const p = parts(el);
    expect(p.word.textContent).toBe(text("storage.state.full"));
    expect(p.usage.hidden).toBe(true);
    expect(p.bar.hidden).toBe(true);
  });

  test("an episode that starts while open re-reads and shows full", async () => {
    const h = harness({ status: () => OK });
    const el = mountStorage(h.client);
    await flush();
    expect(parts(el).word.textContent).toBe(text("storage.state.ok"));

    h.setEpisode(true);
    h.fireEpisode();
    await flush();

    expect(h.statusCalls()).toBe(2);
    expect(parts(el).word.textContent).toBe(text("storage.state.full"));
    expect(parts(el).usage.hidden).toBe(true);
  });

  test("the manage link uses an https manageUrl from status", async () => {
    const h = harness({ status: () => OK });
    const el = mountStorage(h.client);
    await flush();
    expect(parts(el).manage.href).toBe("https://a.example/manage");
  });

  test("a non-https manageUrl falls back to the constant manage link", async () => {
    const h = harness({
      status: () => ({
        ok: true,
        data: { usedBytes: 1, limitBytes: 10, state: "ok", manageUrl: "javascript:alert(1)" },
      }),
    });
    const el = mountStorage(h.client);
    await flush();
    expect(parts(el).manage.href).toBe(STORAGE_MANAGE_URL);
  });

  test("a thrown status read shows the generic note and offers retry", async () => {
    const h = harness({
      status: () => {
        throw new Error("boom");
      },
    });
    const el = mountStorage(h.client);
    await flush();

    expect(parts(el).note.textContent).toBe(text("storage.error.generic"));
    expect(parts(el).action.textContent).toBe(text("storage.retry"));
  });
});
