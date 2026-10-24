import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { NodeRow, PanelDataSource, ViewResult } from "../../src/ui/data";
import { nodesSection } from "../../src/ui/sections/nodes";
import type { HostContext, PanelClient } from "../../src/ui/slots";
import { panelText } from "../../src/ui/strings-panel";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent", "navigator"];
const ORIGIN = "https://app.example";

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
  Reflect.deleteProperty(g, "navigator");
});

// Fake sources resolve on microtasks only, so draining the queue is enough.
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const ready = <T>(data: T): ViewResult<T> => ({ state: "ready", data });

function fakeData(nodes: () => Promise<ViewResult<NodeRow[]>>, subscribe = (): (() => void) => () => undefined) {
  return { subscribe, nodes } as unknown as PanelDataSource;
}

function clientWith(data: PanelDataSource | undefined): PanelClient {
  return { id: 1, signedIn: () => true, onReset: () => () => undefined, data } as unknown as PanelClient;
}

// The real host resolves ctx.text through panelText (panel.ts), so the test does too.
function ctxFor(client: PanelClient): HostContext {
  return {
    client: () => client,
    onClientChange: () => () => undefined,
    developerMode: () => false,
    setStatus: () => undefined,
    topStatus: () => null,
    onStatusChange: () => () => undefined,
    toastsEnabled: () => true,
    toast: () => "",
    openPanel: () => undefined,
    closePanel: () => undefined,
    text: panelText,
  } as unknown as HostContext;
}

function mount(client: PanelClient): HTMLElement {
  const el = page.document.createElement("div");
  page.document.body.append(el);
  cleanups.push(nodesSection.mount(el, ctxFor(client)));
  return el;
}

const HOSTED: NodeRow = {
  source: "real",
  origin: "https://node.test",
  kind: "hosted",
  active: true,
  status: "ok",
  nodeDid: "did:key:z6MkTest",
  version: "0.14.2",
  latencyMs: 84,
  lastSeenAt: new Date(Date.now() - 3000),
  spaces: ["Personal", "Work"],
} as unknown as NodeRow;

const SLOW: NodeRow = {
  source: "real",
  origin: "https://lab.example.org",
  kind: "hosted",
  active: false,
  status: "slow",
  spaces: [],
} as unknown as NodeRow;

const cards = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".nd-card")];

describe("nodes section body", () => {
  test("renders the section heading as the first child, for focus on open", async () => {
    const el = mount(clientWith(fakeData(async () => ready([HOSTED]))));
    await flush();
    expect(el.firstElementChild?.tagName).toBe("STYLE");
    expect(el.querySelector("h3.sec-title")?.textContent).toBe(panelText("nodes.title"));
  });

  test("one card per node, labelled by host, with its status tone", async () => {
    const el = mount(clientWith(fakeData(async () => ready([HOSTED, SLOW]))));
    await flush();
    const rendered = cards(el);
    expect(rendered.map((card) => card.getAttribute("aria-label"))).toEqual(["node.test", "lab.example.org"]);
    expect(rendered[0].querySelector(".st")?.classList.contains("st-ok")).toBe(true);
    expect(rendered[1].querySelector(".st")?.classList.contains("st-warn")).toBe(true);
  });

  test("the host is the only .row .label, so the row label is the bare host", async () => {
    const el = mount(clientWith(fakeData(async () => ready([HOSTED]))));
    await flush();
    const labels = [...el.querySelectorAll(".row .label")].map((node) => node.textContent);
    expect(labels).toEqual(["node.test"]);
  });

  test("a node without a DID shows no node-ID row and no copy button", async () => {
    const el = mount(clientWith(fakeData(async () => ready([SLOW]))));
    await flush();
    expect(el.querySelector(".nd-did")).toBeNull();
    expect(el.querySelector("button.icon-btn")).toBeNull();
  });

  test("absent fields are omitted, never shown as zero or blank text", async () => {
    const el = mount(clientWith(fakeData(async () => ready([SLOW]))));
    await flush();
    const card = cards(el)[0];
    expect(card.querySelector(".nd-kv")).toBeNull();
    expect(card.querySelector(".nd-chips")).toBeNull();
    expect(card.textContent).not.toMatch(/\b0 ms\b|\bundefined\b|\bnull\b/);
  });

  test("spaces that are not a list are treated as absent", async () => {
    const legacy = { ...HOSTED, spaces: 1 } as unknown as NodeRow;
    const el = mount(clientWith(fakeData(async () => ready([legacy]))));
    await flush();
    expect(el.querySelector(".nd-chips")).toBeNull();
    expect(el.textContent).not.toContain(panelText("nodes.spaces"));
  });

  test("spaces render as chips in order", async () => {
    const el = mount(clientWith(fakeData(async () => ready([HOSTED]))));
    await flush();
    const chips = [...el.querySelectorAll(".nd-chip")].map((chip) => chip.textContent);
    expect(chips).toEqual(["Personal", "Work"]);
  });

  test("latency shows with a relative last-seen age when both are real", async () => {
    const el = mount(clientWith(fakeData(async () => ready([HOSTED]))));
    await flush();
    expect(cards(el)[0].textContent).toMatch(/84 ms · seen \d+ s ago/);
  });

  test("latency without a last-seen stamp shows the milliseconds only", async () => {
    const row = { ...HOSTED, lastSeenAt: undefined } as unknown as NodeRow;
    const el = mount(clientWith(fakeData(async () => ready([row]))));
    await flush();
    const text = cards(el)[0].textContent ?? "";
    expect(text).toContain("84 ms");
    expect(text).not.toContain("seen");
  });

  test("the copy button copies the DID and is not a primary action", async () => {
    const copied: string[] = [];
    Object.defineProperty(g, "navigator", {
      value: { clipboard: { writeText: async (value: string) => void copied.push(value) } },
      configurable: true,
    });
    const el = mount(clientWith(fakeData(async () => ready([HOSTED]))));
    await flush();
    const copy = el.querySelector<HTMLButtonElement>("button.icon-btn");
    expect(copy).not.toBeNull();
    expect(copy?.classList.contains("action")).toBe(false);
    expect(copy?.getAttribute("aria-label")).toBe(panelText("nodes.copy", { host: "node.test" }));
    copy?.click();
    await flush();
    expect(copied).toEqual(["did:key:z6MkTest"]);
  });

  test("a rejected clipboard write does not throw out of the click handler", async () => {
    Object.defineProperty(g, "navigator", {
      value: { clipboard: { writeText: async () => Promise.reject(new Error("denied")) } },
      configurable: true,
    });
    const el = mount(clientWith(fakeData(async () => ready([HOSTED]))));
    await flush();
    const copy = el.querySelector<HTMLButtonElement>("button.icon-btn");
    expect(() => copy?.click()).not.toThrow();
    await flush();
  });

  test("an empty list shows the empty line and no cards", async () => {
    const el = mount(clientWith(fakeData(async () => ready([]))));
    await flush();
    expect(cards(el)).toHaveLength(0);
    const empty = [...el.querySelectorAll<HTMLElement>("p.note")].find((p) => p.textContent === panelText("nodes.empty"));
    expect(empty?.hidden).toBe(false);
  });

  test("loading shows the busy status and hides the body", () => {
    const pending = Promise.withResolvers<ViewResult<NodeRow[]>>();
    const el = mount(clientWith(fakeData(() => pending.promise)));
    const status = el.querySelector<HTMLElement>('[role="status"]');
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toBe(panelText("view.loading"));
    expect(el.querySelector<HTMLElement>(".nd-cards")?.parentElement?.hidden).toBe(true);
  });

  test("needs-permission shows the neutral permission word, not an error", async () => {
    const el = mount(
      clientWith(fakeData(async () => ({ state: "needs-permission", ability: "nodes" }) as unknown as ViewResult<NodeRow[]>)),
    );
    await flush();
    const status = el.querySelector<HTMLElement>('[role="status"]');
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toBe(panelText("view.permission"));
    expect(el.querySelector<HTMLButtonElement>("button.action")?.hidden).toBe(true);
  });

  test("error shows the error and the retry, and retry renders the data", async () => {
    let calls = 0;
    const el = mount(
      clientWith(
        fakeData(async () => {
          calls++;
          return calls === 1 ? { state: "error", code: "unknown" } : ready([HOSTED]);
        }),
      ),
    );
    await flush();
    const retry = el.querySelector<HTMLButtonElement>("button.action");
    expect(retry?.hidden).toBe(false);
    retry?.click();
    await flush();
    expect(calls).toBe(2);
    expect(cards(el)).toHaveLength(1);
    expect(retry?.hidden).toBe(true);
  });

  test("a view notification reloads the nodes", async () => {
    let reads = 0;
    let notify: ((view: string) => void) | undefined;
    const el = mount(
      clientWith(
        fakeData(
          async () => {
            reads++;
            return ready(reads === 1 ? [SLOW] : [HOSTED, SLOW]);
          },
          (listener) => {
            notify = listener;
            return () => undefined;
          },
        ),
      ),
    );
    await flush();
    expect(cards(el)).toHaveLength(1);
    notify?.("activity");
    await flush();
    expect(reads).toBe(1);
    notify?.("nodes");
    await flush();
    expect(cards(el)).toHaveLength(2);
  });

  test("dispose unsubscribes and empties the element", async () => {
    let unsubscribed = false;
    const el = page.document.createElement("div");
    page.document.body.append(el);
    const dispose = nodesSection.mount(
      el,
      ctxFor(
        clientWith(
          fakeData(
            async () => ready([HOSTED]),
            () => () => {
              unsubscribed = true;
            },
          ),
        ),
      ),
    );
    await flush();
    dispose();
    expect(unsubscribed).toBe(true);
    expect(el.childElementCount).toBe(0);
  });

  test("a late read after dispose does not render", async () => {
    const late = Promise.withResolvers<ViewResult<NodeRow[]>>();
    const el = page.document.createElement("div");
    page.document.body.append(el);
    const dispose = nodesSection.mount(
      el,
      ctxFor(clientWith(fakeData(() => late.promise))),
    );
    dispose();
    late.resolve(ready([HOSTED]));
    await flush();
    expect(el.querySelector(".nd-card")).toBeNull();
  });
});

describe("nodes section unknown values", () => {
  const LATENCY = panelText("nodes.latency");
  const rowsOf = (card: HTMLElement) =>
    new Map([...card.querySelectorAll("dt")].map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""]));

  test.each([Number.NaN, null, undefined])("a latency of %p is omitted, never shown as NaN, null or 0 ms", async (latencyMs) => {
    const el = mount(clientWith(fakeData(async () => ready([{ ...HOSTED, latencyMs } as unknown as NodeRow]))));
    await flush();
    const card = cards(el)[0];
    expect(rowsOf(card).has(LATENCY)).toBe(false);
    expect(card.textContent).not.toMatch(/NaN|null|undefined/);
  });

  test.each([new Date("not a date"), null])("a last-seen stamp of %p drops the seen text, keeps the latency", async (lastSeenAt) => {
    const el = mount(clientWith(fakeData(async () => ready([{ ...HOSTED, lastSeenAt } as unknown as NodeRow]))));
    await flush();
    expect(rowsOf(cards(el)[0]).get(LATENCY)).toBe("84 ms");
  });

  test("a last-seen stamp in the future has no known age, so it is not shown as 0 s ago", async () => {
    const el = mount(clientWith(fakeData(async () => ready([{ ...HOSTED, lastSeenAt: new Date(Date.now() + 60_000) } as unknown as NodeRow]))));
    await flush();
    expect(rowsOf(cards(el)[0]).get(LATENCY)).toBe("84 ms");
    expect(cards(el)[0].textContent).not.toContain("0 s ago");
  });

  test.each([null, "", "   "])("a version of %p is omitted, never shown as vnull or an empty value", async (version) => {
    const el = mount(clientWith(fakeData(async () => ready([{ ...HOSTED, version } as unknown as NodeRow]))));
    await flush();
    expect(rowsOf(cards(el)[0]).has(panelText("nodes.version"))).toBe(false);
    expect(cards(el)[0].textContent).not.toContain("vnull");
  });

  test("blank or missing space names are dropped, and an empty list omits the row", async () => {
    const el = mount(clientWith(fakeData(async () => ready([{ ...HOSTED, spaces: ["", "  ", null, "Work"] } as unknown as NodeRow, { ...HOSTED, origin: "https://other.test", spaces: [""] } as unknown as NodeRow]))));
    await flush();
    const [first, second] = cards(el);
    expect([...first.querySelectorAll(".nd-chip")].map((chip) => chip.textContent)).toEqual(["Work"]);
    expect(rowsOf(second).has(panelText("nodes.spaces"))).toBe(false);
  });
});

describe("nodes section account changes", () => {
  // Mounts with a controllable current client and captures the change listeners the host would fire.
  function mountSwitchable(initial: PanelClient | undefined) {
    let current: PanelClient | undefined = initial;
    const changeListeners: Array<() => void> = [];
    const ctx = {
      ...ctxFor(initial ?? clientWith(undefined)),
      client: () => current,
      onClientChange: (cb: () => void) => {
        changeListeners.push(cb);
        return () => undefined;
      },
    } as unknown as HostContext;
    const el = page.document.createElement("div");
    page.document.body.append(el);
    cleanups.push(nodesSection.mount(el, ctx));
    return {
      el,
      switchTo(next: PanelClient | undefined) {
        current = next;
        for (const notify of changeListeners) notify();
      },
    };
  }

  test("a read started before an account switch never renders the previous account's nodes", async () => {
    const previous = Promise.withResolvers<ViewResult<NodeRow[]>>();
    const { el, switchTo } = mountSwitchable(clientWith(fakeData(() => previous.promise)));
    await flush();

    switchTo(clientWith(fakeData(async () => ready([SLOW]))));
    await flush();
    previous.resolve(ready([HOSTED]));
    await flush();

    expect(cards(el).map((card) => card.getAttribute("aria-label"))).toEqual(["lab.example.org"]);
  });

  test("a read started before sign-out never renders the previous account's nodes", async () => {
    const previous = Promise.withResolvers<ViewResult<NodeRow[]>>();
    const { el, switchTo } = mountSwitchable(clientWith(fakeData(() => previous.promise)));
    await flush();

    switchTo(undefined);
    await flush();
    previous.resolve(ready([HOSTED]));
    await flush();

    expect(cards(el).map((card) => card.getAttribute("aria-label"))).toEqual([]);
  });

  const statusLine = (el: HTMLElement) => el.querySelector('[role="status"]') as HTMLElement;
  const contentOf = (el: HTMLElement) => el.querySelector(".nd-wrap") as HTMLElement;

  test("without a client at mount it shows the unavailable line, then loads when a client appears", async () => {
    const { el, switchTo } = mountSwitchable(undefined);
    await flush();

    expect(statusLine(el).hidden).toBe(false);
    expect(statusLine(el).textContent).toBe(panelText("nodes.unavailable"));
    expect(contentOf(el).hidden).toBe(true);

    switchTo(clientWith(fakeData(async () => ready([SLOW]))));
    await flush();

    expect(cards(el).map((card) => card.getAttribute("aria-label"))).toEqual(["lab.example.org"]);
    expect(statusLine(el).hidden).toBe(true);
  });

  test("signing out clears the rows and shows the unavailable line, not loading", async () => {
    const { el, switchTo } = mountSwitchable(clientWith(fakeData(async () => ready([HOSTED]))));
    await flush();
    expect(cards(el)).toHaveLength(1);

    switchTo(undefined);
    await flush();

    expect(cards(el)).toHaveLength(0);
    expect(contentOf(el).hidden).toBe(true);
    expect(statusLine(el).hidden).toBe(false);
    expect(statusLine(el).textContent).toBe(panelText("nodes.unavailable"));
  });
});
