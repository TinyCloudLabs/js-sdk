import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { PanelView, ViewResult } from "../../src/ui/data";
import { PANEL_SECTIONS } from "../../src/ui/sections";
import { accountSection } from "../../src/ui/sections/account";
import type { SectionContext, SectionId } from "../../src/ui/slots";
import { panelText as text } from "../../src/ui/strings-panel";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent"];
const DID = "did:key:z6MkAccountExample0000000000000000";
const READY = { did: DID, host: "https://node.example", appName: "Notes", grantedDelegations: 0, receivedDelegations: 0 };

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

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

interface Opts {
  reads: Array<ViewResult<unknown>>;
  knownDid?: () => string | undefined;
  appLabel?: string;
}

function mountWith(opts: Opts) {
  const listeners: Array<(view: PanelView) => void> = [];
  let reads = 0;
  const client = {
    id: 1,
    signedIn: () => true,
    onReset: () => () => undefined,
    storage: { status: async () => ({}) },
    data: {
      subscribe: (cb: (view: PanelView) => void) => {
        listeners.push(cb);
        return () => {
          listeners.splice(listeners.indexOf(cb), 1);
        };
      },
      knownDid: opts.knownDid,
      account: async () => opts.reads[Math.min(reads++, opts.reads.length - 1)],
    },
    sync: {},
    signOut: async () => undefined,
  };
  const ctx = {
    client: () => client,
    onClientChange: () => () => undefined,
    developerMode: () => false,
    setStatus: () => undefined,
    topStatus: () => null,
    onStatusChange: () => () => undefined,
    toastsEnabled: () => true,
    toast: () => "",
    text,
    appLabel: () => opts.appLabel,
    canHideButton: () => false,
    hideButton: () => undefined,
    data: {
      source: client.data,
      latest: () => undefined,
      age: () => undefined,
      generation: () => 0,
      refresh: async () => undefined,
      subscribe: () => () => undefined,
    },
    layout: () => "drawer",
    sections: () => PANEL_SECTIONS.filter((section) => section.isAvailable(ctx)),
    openSection: (_id: SectionId) => undefined,
    closePanel: () => undefined,
  } as unknown as SectionContext;
  const el = page.document.createElement("div");
  page.document.body.append(el);
  cleanups.push(accountSection.mount(el as unknown as HTMLElement, ctx));
  return { el, listeners, reads: () => reads };
}

const name = (el: HTMLElement) => el.querySelector(".account-ident .name") as HTMLElement;
const ident = (el: HTMLElement) => el.querySelector(".account-ident") as HTMLElement;
const facts = (el: HTMLElement) => el.querySelector(".account-kv") as HTMLElement;
// The status line sits right under the identity; its text is empty while the details are shown.
const note = (el: HTMLElement) => el.querySelector(".account-ident + .note") as HTMLElement;
const SHORT = `${DID.slice(0, 20)}…${DID.slice(-4)}`;

describe("Overview when the account read fails", () => {
  test("the DID the source already knows and the app name stay on screen; only the details are unavailable", async () => {
    const { el } = mountWith({
      reads: [{ state: "error", code: "NETWORK_ERROR" }],
      knownDid: () => DID,
      appLabel: "Notes Pro",
    });
    await flush();
    expect(ident(el).hidden).toBe(false);
    expect(name(el).textContent).toBe(SHORT);
    expect(name(el).title).toBe(DID);
    expect(facts(el).hidden).toBe(false);
    expect(facts(el).textContent).toContain("Notes Pro");
    const rows = [...facts(el).querySelectorAll(":scope > div")] as HTMLElement[];
    expect(rows.find((r) => r.textContent?.includes(text("account.session.label")))?.hidden).toBe(true);
    expect(note(el).hidden).toBe(false);
    expect(note(el).textContent).toBe(text("account.unavailable"));
  });

  test("Copy puts the known DID on the clipboard", async () => {
    const written: string[] = [];
    const realNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (value: string) => void written.push(value) } },
    });
    try {
      const { el } = mountWith({ reads: [{ state: "error", code: "NETWORK_ERROR" }], knownDid: () => DID });
      await flush();
      (el.querySelector(".account-copy") as HTMLButtonElement).click();
      await flush();
      expect(written).toEqual([DID]);
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: realNavigator });
    }
  });

  test("with nothing known locally the identity stays hidden, as before", async () => {
    const { el } = mountWith({ reads: [{ state: "error", code: "NETWORK_ERROR" }] });
    await flush();
    expect(ident(el).hidden).toBe(true);
    expect(facts(el).hidden).toBe(true);
    expect(note(el).hidden).toBe(false);
    expect(note(el).textContent).toBe(text("account.unavailable"));
  });

  test("while the first read is out nothing is shown from the source", async () => {
    const { el } = mountWith({ reads: [{ state: "loading" }], knownDid: () => DID, appLabel: "Notes" });
    await flush();
    expect(ident(el).hidden).toBe(true);
    expect(facts(el).hidden).toBe(true);
  });

  test("when the source announces a change, Overview reads again and shows the account without leaving", async () => {
    const { el, listeners, reads } = mountWith({
      reads: [{ state: "error", code: "NETWORK_ERROR" }, { state: "ready", data: READY }],
      knownDid: () => DID,
    });
    await flush();
    expect(reads()).toBe(1);
    expect(note(el).hidden).toBe(false);
    expect(note(el).textContent).toBe(text("account.unavailable"));

    // Another view's change is not ours.
    for (const cb of listeners) cb("delegations");
    await flush();
    expect(reads()).toBe(1);

    for (const cb of listeners) cb("overview");
    await flush();
    expect(reads()).toBe(2);
    expect(note(el).hidden).toBe(true);
    expect(facts(el).textContent).toContain("Notes");
  });

  test("a ready Overview does not read again on a change", async () => {
    const { listeners, reads } = mountWith({ reads: [{ state: "ready", data: READY }] });
    await flush();
    for (const cb of listeners) cb("overview");
    await flush();
    expect(reads()).toBe(1);
  });

  test("disposing stops listening to the source", async () => {
    const { listeners } = mountWith({ reads: [{ state: "ready", data: READY }] });
    await flush();
    expect(listeners).toHaveLength(1);
    for (const dispose of cleanups.splice(0)) dispose();
    expect(listeners).toHaveLength(0);
  });
});
