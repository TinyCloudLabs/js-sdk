import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { PanelDataSource } from "../../src/ui/data";
import { activitySection } from "../../src/ui/sections/activity";
import { localTinycloudSection } from "../../src/ui/sections/local-tinycloud";
import type { HostContext, PanelClient, PanelSection } from "../../src/ui/slots";
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

// The fake sources resolve on microtasks only, so draining the queue is enough.
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const ready = <T>(data: T) => ({ state: "ready" as const, data });

const LOCAL_OFF = { connection: "off" };

function fakeData(overrides: Loose): PanelDataSource {
  return {
    subscribe: () => () => undefined,
    localNode: async () => ready(LOCAL_OFF),
    setLocalNodeEnabled: async () => ({ ok: true }),
    delegations: async () => ready({ rows: [], nextCursor: undefined }),
    revoke: async (cid: string) => ({ ok: true, cid }),
    nodes: async () => ready([]),
    ...overrides,
  } as unknown as PanelDataSource;
}

function clientWith(data: PanelDataSource | undefined, signedIn = true): PanelClient {
  return {
    id: 1,
    signedIn: () => signedIn,
    onReset: () => () => undefined,
    data,
  } as unknown as PanelClient;
}

function ctxFor(client: PanelClient, developerMode = false): HostContext {
  return {
    client: () => client,
    onClientChange: () => () => undefined,
    developerMode: () => developerMode,
    setStatus: () => undefined,
    topStatus: () => null,
    onStatusChange: () => () => undefined,
    toastsEnabled: () => true,
    toast: () => "",
    openPanel: () => undefined,
    closePanel: () => undefined,
    appLabel: () => undefined,
    requestRender: () => undefined,
    data: { latest: () => undefined, subscribe: () => () => undefined },
    text,
    appLabel: () => undefined,
  } as unknown as HostContext;
}

function mount(section: PanelSection, client: PanelClient, developerMode = false): HTMLElement {
  const el = page.document.createElement("div");
  page.document.body.append(el);
  cleanups.push(section.mount(el, ctxFor(client, developerMode)));
  return el;
}

describe("local tinycloud section", () => {
  test("without a data source it shows the placeholder, not the switch", () => {
    const el = mount(localTinycloudSection, clientWith(undefined));
    expect(el.querySelector('[role="switch"]')).toBeNull();
  });

  test("a rejected read shows the error with retry, and retry reads again", async () => {
    let calls = 0;
    const el = mount(
      localTinycloudSection,
      clientWith(
        fakeData({
          localNode: async () => {
            calls += 1;
            if (calls === 1) throw new Error("boom");
            return ready(LOCAL_OFF);
          },
        }),
      ),
    );
    await flush();
    const status = el.querySelector<HTMLParagraphElement>('[role="status"]');
    const retry = el.querySelector<HTMLButtonElement>("button.action");
    expect(status?.hidden).toBe(false);
    expect(retry?.hidden).toBe(false);

    retry?.click();
    await flush();
    expect(calls).toBe(2);
    expect(status?.hidden).toBe(true);
  });

  test("a permission gap shows the status line without retry", async () => {
    const el = mount(
      localTinycloudSection,
      clientWith(
        fakeData({ localNode: async () => ({ state: "needs-permission", ability: "space/info" }) }),
      ),
    );
    await flush();
    const status = el.querySelector<HTMLParagraphElement>('[role="status"]');
    const retry = el.querySelector<HTMLButtonElement>("button.action");
    expect(status?.hidden).toBe(false);
    expect(retry?.hidden).toBe(true);
  });
});

describe("activity section", () => {
  test("is unavailable unless developer mode is on", () => {
    const client = clientWith(fakeData({}));
    expect(activitySection.isAvailable(ctxFor(client, false))).toBe(false);
    expect(activitySection.isAvailable(ctxFor(client, true))).toBe(true);
  });
});
