import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { ActionResult, LocalNodeState, PanelDataSource } from "../../src/ui/data";
import { localTinycloudSection } from "../../src/ui/sections/local-tinycloud";
import type { HostContext, PanelClient } from "../../src/ui/slots";
import { panelText } from "../../src/ui/strings-panel";
import { viewError } from "../../src/ui/view-result";

type Loose = Record<PropertyKey, unknown>;
type Toast = Record<string, unknown>;

const g = globalThis as unknown as Loose;
const ORIGIN = "https://app.example";
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent"];
const HOST = "http://127.0.0.1:8787";
const DID_LONG = "did:key:z6MkEXAMPLEabcdefghijklmnopqrstuvwxyz0123456789";
const DID_SHORT = "did:key:zLocal";
const UNKNOWN = panelText("local-tinycloud.unknown");

/** Text of each value cell in the found card, without its Copy buttons. */
function valueTexts(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll(".ll-kv dd")).map((dd) => {
    const value = dd.cloneNode(true) as HTMLElement;
    value.querySelectorAll("button").forEach((button) => button.remove());
    return value.textContent?.trim() ?? "";
  });
}

let page: Window;
const saved = new Map<string, unknown>();
let navigatorDescriptor: PropertyDescriptor | undefined;
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
  navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
});

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  page.document.body.innerHTML = "";
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
});

// The fake sources resolve on microtasks only, so draining the queue is enough.
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

/** A visible button by aria-label or text. The state line's hidden retry is skipped. */
function visibleButton(root: HTMLElement, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find(
    (button) => !button.hidden && (button.getAttribute("aria-label") ?? button.textContent) === name,
  );
  if (!found) throw new Error(`missing button ${name}`);
  return found;
}

function clipboard(writeText: (value: string) => Promise<void>): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText } },
    configurable: true,
  });
}

const FOUND: LocalNodeState = {
  source: "stub",
  connection: "found",
  url: HOST,
  identity: { origin: HOST, nodeDid: DID_LONG },
  version: "v0.14.2",
};

/** A fake local-node source. `write` decides each enable/disable result. */
function fakeLocal(
  initial: LocalNodeState,
  write: (on: boolean) => Promise<ActionResult> = async () => ({ ok: true }),
) {
  const local = { node: initial };
  const writes: boolean[] = [];
  let listener: ((view: string) => void) | undefined;
  const data = {
    subscribe(next: (view: string) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    localNode: async () => ({ state: "ready", data: local.node }),
    setLocalNodeEnabled: async (on: boolean) => {
      writes.push(on);
      return write(on);
    },
  } as unknown as PanelDataSource;
  return { data, local, writes, notify: () => listener?.("local") };
}

function ctxFor(client: PanelClient, toasts: Toast[], appLabel?: string): HostContext {
  return {
    client: () => client,
    onClientChange: () => () => undefined,
    developerMode: () => false,
    setStatus: () => undefined,
    topStatus: () => null,
    onStatusChange: () => () => undefined,
    toastsEnabled: () => true,
    toast: (next: Toast) => {
      toasts.push(next);
      return "";
    },
    openPanel: () => undefined,
    closePanel: () => undefined,
    text: panelText,
    appLabel: () => appLabel,
  } as unknown as HostContext;
}

function mountWith(data: PanelDataSource, toasts: Toast[] = [], appLabel?: string): HTMLElement {
  const el = page.document.createElement("div");
  page.document.body.append(el);
  const client = {
    id: 1,
    signedIn: () => true,
    onReset: () => () => undefined,
    data,
  } as unknown as PanelClient;
  cleanups.push(localTinycloudSection.mount(el, ctxFor(client, toasts, appLabel) as never));
  return el;
}

describe("Local TinyCloud section", () => {
  test("off: the switch reads Off and the card says what turning it on does", async () => {
    const fake = fakeLocal({ source: "stub", connection: "off" });
    const el = mountWith(fake.data, [], "Notes");
    await flush();
    const toggle = query<HTMLButtonElement>(el, "button.switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.disabled).toBe(false);
    expect(query(el, ".ll-word").textContent).toBe(panelText("local-tinycloud.switch.off"));
    expect(query(el, ".ll-sub").textContent).toBe(panelText("local-tinycloud.sub.off"));
    const card = query(el, ".ll-card").textContent ?? "";
    expect(card).toContain("Notes talks to your hosted TinyCloud only");
    expect(card).not.toContain("{app}");
  });

  test("off without an app label falls back to the neutral app name", async () => {
    const fake = fakeLocal({ source: "stub", connection: "off" });
    const el = mountWith(fake.data);
    await flush();
    expect(query(el, ".ll-card").textContent).toContain(panelText("local-tinycloud.app_fallback"));
  });

  test("found: shows the node id shortened with the full value in title, plus version and host", async () => {
    const fake = fakeLocal({ ...FOUND });
    const el = mountWith(fake.data);
    await flush();
    expect(query(el, "button.switch").getAttribute("aria-checked")).toBe("true");
    const shown = query(el, ".ll-did");
    expect(shown.textContent).not.toBe(DID_LONG);
    expect(shown.textContent).toContain("…");
    expect(shown.textContent).toBe(`${DID_LONG.slice(0, 12)}…${DID_LONG.slice(-6)}`);
    expect(shown.title).toBe(DID_LONG);
    expect(query(el, ".ll-mono").textContent).toBe(HOST);
    expect(el.textContent).toContain("v0.14.2");
  });

  test("found: a node id of 24 characters or fewer is shown whole", async () => {
    const fake = fakeLocal({ ...FOUND, identity: { origin: HOST, nodeDid: DID_SHORT } });
    const el = mountWith(fake.data);
    await flush();
    expect(query(el, ".ll-did").textContent).toBe(DID_SHORT);
  });

  test("looking: the switch stays on, and Cancel turns the node back off", async () => {
    const fake = fakeLocal({ source: "stub", connection: "looking" });
    const el = mountWith(fake.data, [], "Notes");
    await flush();
    const toggle = query<HTMLButtonElement>(el, "button.switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.disabled).toBe(false);
    const card = query(el, ".ll-card").textContent ?? "";
    expect(card).toContain(panelText("local-tinycloud.looking.title"));
    expect(card).toContain("Notes");
    visibleButton(el, panelText("local-tinycloud.looking.cancel")).click();
    await flush();
    expect(fake.writes).toEqual([false]);
  });

  test("not found: lists the start steps with the command, and retry re-reads the state", async () => {
    const fake = fakeLocal({ source: "stub", connection: "not-found" });
    const el = mountWith(fake.data);
    await flush();
    expect(el.querySelectorAll(".ll-steps li")).toHaveLength(3);
    expect(query(el, ".ll-steps code").textContent).toBe("tinycloud start");
    expect(query(el, ".ll-codeline button").getAttribute("aria-label")).toBe(panelText("local-tinycloud.copy.command_label"));
    fake.local.node = { ...FOUND };
    visibleButton(el, panelText("local-tinycloud.not_found.retry")).click();
    await flush();
    expect(query(el, "button.switch").getAttribute("aria-checked")).toBe("true");
  });

  test("not found: the title and the unchanged line share one paragraph, and the steps heading is an eyebrow", async () => {
    const fake = fakeLocal({ source: "stub", connection: "not-found" });
    const el = mountWith(fake.data);
    await flush();
    expect(el.querySelectorAll(".ll-body").length).toBe(1);
    const title = panelText("local-tinycloud.not_found.title");
    expect(query(el, ".ll-body").textContent?.startsWith(`${title} `)).toBe(true);
    expect(query(el, ".ll-body strong").textContent).toBe(title);
    expect(query(el, ".ll-eyebrow").textContent).toBe(panelText("local-tinycloud.not_found.steps_title"));
  });

  test("unavailable: the switch is disabled, clicks write nothing, and the card explains why", async () => {
    const fake = fakeLocal({ source: "stub", connection: "unavailable" });
    const el = mountWith(fake.data);
    await flush();
    const toggle = query<HTMLButtonElement>(el, "button.switch");
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click();
    await flush();
    expect(fake.writes).toEqual([]);
    const card = query(el, ".ll-card").textContent ?? "";
    expect(card).toContain(panelText("local-tinycloud.unavailable.line"));
    expect(card).toContain(panelText("local-tinycloud.unavailable.explain"));
  });

  test("turning on: the switch is busy, repeat clicks are ignored, then the new state shows", async () => {
    let finish!: (result: ActionResult) => void;
    const fake = fakeLocal({ source: "stub", connection: "off" }, () => {
      return new Promise<ActionResult>((resolve) => {
        finish = resolve;
      });
    });
    const el = mountWith(fake.data);
    await flush();
    const toggle = query<HTMLButtonElement>(el, "button.switch");
    toggle.click();
    await flush();
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    toggle.click();
    await flush();
    expect(fake.writes).toEqual([true]);
    fake.local.node = { ...FOUND };
    finish({ ok: true });
    await flush();
    expect(toggle.getAttribute("aria-disabled")).toBe("false");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  test("a failed write shows the alert, and retry re-submits the same value", async () => {
    let attempt = 0;
    const fake = fakeLocal({ source: "stub", connection: "off" }, async () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, code: "unknown" };
      fake.local.node = { ...FOUND };
      return { ok: true };
    });
    const el = mountWith(fake.data);
    await flush();
    query<HTMLButtonElement>(el, "button.switch").click();
    await flush();
    const alert = query(el, '[role="alert"]');
    expect(alert.hidden).toBe(false);
    visibleButton(el, panelText("view.retry")).click();
    await flush();
    expect(fake.writes).toEqual([true, true]);
    expect(alert.hidden).toBe(true);
    expect(query(el, "button.switch").getAttribute("aria-checked")).toBe("true");
  });

  test("a thrown write is reported as a failed write", async () => {
    const fake = fakeLocal({ source: "stub", connection: "off" }, async () => {
      throw new Error("boom");
    });
    const el = mountWith(fake.data);
    await flush();
    query<HTMLButtonElement>(el, "button.switch").click();
    await flush();
    expect(query(el, '[role="alert"]').hidden).toBe(false);
  });

  test("copy writes the full node id to the clipboard and confirms with a toast", async () => {
    const copied: string[] = [];
    clipboard(async (value) => {
      copied.push(value);
    });
    const toasts: Toast[] = [];
    const fake = fakeLocal({ ...FOUND });
    const el = mountWith(fake.data, toasts);
    await flush();
    visibleButton(el, panelText("local-tinycloud.copy.node_id_label")).click();
    await flush();
    expect(copied).toEqual([DID_LONG]);
    expect(toasts).toEqual([{ kind: "success", textCode: "local-tinycloud.copied" }]);
  });

  test("a failed copy shows an error toast", async () => {
    clipboard(async () => {
      throw new Error("denied");
    });
    const toasts: Toast[] = [];
    const fake = fakeLocal({ ...FOUND });
    const el = mountWith(fake.data, toasts);
    await flush();
    visibleButton(el, panelText("local-tinycloud.copy.host_label")).click();
    await flush();
    expect(toasts).toEqual([{ kind: "error", textCode: "local-tinycloud.copy_failed" }]);
  });

  test("a local-node notification re-reads the state", async () => {
    const fake = fakeLocal({ source: "stub", connection: "off" });
    const el = mountWith(fake.data);
    await flush();
    fake.local.node = { ...FOUND };
    fake.notify();
    await flush();
    expect(query(el, "button.switch").getAttribute("aria-checked")).toBe("true");
  });

  test("found: a node id, version, or host the node did not report is shown as Unknown, never blank or zero", async () => {
    const fake = fakeLocal({ source: "stub", connection: "found" });
    const el = mountWith(fake.data);
    await flush();
    expect(valueTexts(el)).toEqual([UNKNOWN, UNKNOWN, UNKNOWN]);
    expect(el.querySelector(".ll-did")).toBeNull();
    expect(el.querySelector(".ll-mono")).toBeNull();
    expect(el.querySelectorAll(".ll-kv button")).toHaveLength(0);
  });

  test("found: blank version, host, and node id count as missing, not as values", async () => {
    const fake = fakeLocal({
      source: "stub",
      connection: "found",
      url: "",
      identity: { origin: HOST, nodeDid: "" },
      version: "",
    });
    const el = mountWith(fake.data);
    await flush();
    expect(valueTexts(el)).toEqual([UNKNOWN, UNKNOWN, UNKNOWN]);
    expect(el.querySelectorAll(".ll-kv button")).toHaveLength(0);
  });

  test("found: a missing host shows Unknown while the reported version still shows", async () => {
    const fake = fakeLocal({
      source: "stub",
      connection: "found",
      identity: { origin: HOST, nodeDid: DID_SHORT },
      version: "v0.14.2",
    });
    const el = mountWith(fake.data);
    await flush();
    expect(valueTexts(el)).toEqual([DID_SHORT, "v0.14.2", UNKNOWN]);
  });

  test("a failed read shows the retry affordance, never the Not found state", async () => {
    const data = {
      subscribe: () => () => undefined,
      localNode: async () => viewError("unknown"),
    } as unknown as PanelDataSource;
    const el = mountWith(data);
    await flush();
    expect(visibleButton(el, panelText("view.retry")).hidden).toBe(false);
    expect(el.textContent).not.toContain(panelText("local-tinycloud.glance.not_found"));
    expect(el.textContent).not.toContain(panelText("local-tinycloud.not_found.title"));
    expect(query(el, ".ll-card").textContent).toBe("");
  });
});

/** A promise the test resolves by hand, to hold a read or write in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

/** Mounts with a client the test can swap, the way an account switch does. */
function mountSwitchable(first: PanelDataSource, toasts: Toast[] = []) {
  const el = page.document.createElement("div");
  page.document.body.append(el);
  let current = first;
  let onChange: (() => void) | undefined;
  const base = ctxFor({ id: 1, signedIn: () => true, onReset: () => () => undefined, data: first } as unknown as PanelClient, toasts);
  const ctx = {
    ...base,
    client: () => ({ id: 1, data: current }) as unknown as PanelClient,
    onClientChange: (cb: () => void) => {
      onChange = cb;
      return () => undefined;
    },
  };
  cleanups.push(localTinycloudSection.mount(el, ctx as never));
  return {
    el,
    switchTo(next: PanelDataSource) {
      current = next;
      onChange?.();
    },
  };
}

const DID_OLD = "did:key:zOldAccount";

describe("Local TinyCloud section: account switch while a request is in flight", () => {
  test("a read for the old account that lands after the switch is dropped", async () => {
    const oldRead = deferred<unknown>();
    const old = {
      subscribe: () => () => undefined,
      localNode: () => oldRead.promise,
      setLocalNodeEnabled: async () => ({ ok: true }),
    } as unknown as PanelDataSource;
    const next = fakeLocal({
      source: "stub",
      connection: "found",
      url: HOST,
      identity: { origin: HOST, nodeDid: DID_SHORT },
      version: "v0.14.2",
    });
    const view = mountSwitchable(old);
    view.switchTo(next.data);
    await flush();
    expect(valueTexts(view.el)).toContain(DID_SHORT);
    oldRead.resolve({
      state: "ready",
      data: { source: "stub", connection: "found", url: HOST, identity: { origin: HOST, nodeDid: DID_OLD }, version: "v0.13.0" },
    });
    await flush();
    expect(valueTexts(view.el)).toContain(DID_SHORT);
    expect(valueTexts(view.el)).not.toContain(DID_OLD);
  });

  test("a write for the old account that fails after the switch shows no error", async () => {
    const oldWrite = deferred<ActionResult>();
    const old = fakeLocal({ source: "stub", connection: "off" }, () => oldWrite.promise);
    const next = fakeLocal({
      source: "stub",
      connection: "found",
      url: HOST,
      identity: { origin: HOST, nodeDid: DID_SHORT },
      version: "v0.14.2",
    });
    const view = mountSwitchable(old.data);
    await flush();
    query<HTMLButtonElement>(view.el, "button.switch").click();
    await flush();
    view.switchTo(next.data);
    await flush();
    oldWrite.resolve({ ok: false, code: "unknown" });
    await flush();
    expect(query(view.el, '[role="alert"]').hidden).toBe(true);
    expect(valueTexts(view.el)).toContain(DID_SHORT);
  });

  test("a copy that finishes after the switch shows no toast", async () => {
    const write = deferred<void>();
    clipboard(() => write.promise);
    const old = fakeLocal({
      source: "stub",
      connection: "found",
      url: HOST,
      identity: { origin: HOST, nodeDid: DID_OLD },
      version: "v0.13.0",
    });
    const next = fakeLocal({
      source: "stub",
      connection: "found",
      url: HOST,
      identity: { origin: HOST, nodeDid: DID_SHORT },
      version: "v0.14.2",
    });
    const toasts: Toast[] = [];
    const view = mountSwitchable(old.data, toasts);
    await flush();
    query<HTMLButtonElement>(view.el, ".ll-kv dd button").click();
    view.switchTo(next.data);
    await flush();
    write.resolve();
    await flush();
    expect(toasts).toEqual([]);
  });
});
