/*
 * The Delegations tab's "allow" button against the real panel client: it asks the SDK for the tab's one read-only entry,
 * reloads the tab on approval, and has no working button when the page cannot show the SDK's permission prompt.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { PermissionEntry } from "@tinycloud/sdk-core";

import { createPanelClient, type ClientSource } from "../../src/ui/client";
import { resolveUiConfig } from "../../src/ui/config";
import type { DelegationPage, DelegationRow, PanelDataSource, ViewResult } from "../../src/ui/data";
import { TAB_PERMISSION, TAB_PERMISSION_EXPIRY_MS } from "../../src/ui/data/authority";
import { createSectionData } from "../../src/ui/section-data";
import { storageSection } from "../../src/ui/sections/storage";
import { createSectionDialogs } from "../../src/ui/section-dialogs";
import { delegationsSection } from "../../src/ui/sections/delegations";
import type { SectionContext } from "../../src/ui/slots";
import { panelText } from "../../src/ui/strings-panel";
import type { UiPlatform } from "../../src/ui/config";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent", "KeyboardEvent", "Node"];
const saved = new Map<string, unknown>();
let page: Window;
const cleanups: Array<() => void> = [];

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: "https://app.example/page" }).window as unknown as Window;
  Object.assign(page, { matchMedia: () => ({ matches: true }) });
  for (const name of GLOBAL_NAMES) g[name] = (page as unknown as Loose)[name];
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
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

const NEEDS: ViewResult<DelegationPage> = { state: "needs-permission", ability: "delegation/list" };
const NOW = Date.now();

const ROW: DelegationRow = {
  source: "stub",
  cid: "a",
  direction: "granted",
  status: "active",
  group: "to-others",
  label: { text: "Helper a", source: "stub" },
  delegatorDid: "did:key:z6MkOwnerOwnerOwnerOwnerOwner",
  delegateDid: "did:key:z6MkDelegateaDelegatea",
  resources: [{ resource: "tinycloud.kv/notes/", actions: ["tinycloud.kv/get"] }],
  parents: [],
  issuedAt: new Date(NOW - 120 * 60_000),
  notBefore: null,
  expiresAt: new Date(NOW + 5 * 24 * 60 * 60_000),
  expiringSoon: false,
};

const ENTRY: PermissionEntry = { service: "tinycloud.delegation", space: "applications", path: "", actions: ["list"] };

interface Options {
  /** The page can show the SDK's permission prompt. Default true. */
  capable?: boolean;
  /** The source has no `requestPermissions` at all. */
  noRequest?: boolean;
  platform?: UiPlatform;
  request?: (entries: PermissionEntry[], options: { expiryMs: number }) => Promise<{ approved: boolean }>;
}

async function mount(options: Options = {}) {
  const requests: Array<{ entries: PermissionEntry[]; options: { expiryMs: number } }> = [];
  let granted = false;
  let capable = options.capable !== false;
  const clientSource: ClientSource = {
    signedIn: () => true,
    storage: { status: async () => ({ ok: false }) } as unknown as ClientSource["storage"],
    canRequestPermissions: () => capable,
    ...(options.noRequest === true
      ? {}
      : {
          requestPermissions: async (entries, opts) => {
            requests.push({ entries, options: opts });
            const answer = await (options.request ?? (async () => ({ approved: true })))(entries, opts);
            if (answer.approved) granted = true;
            return answer;
          },
        }),
  };
  const handle = createPanelClient(1, clientSource, undefined, options.platform);
  const source = {
    subscribe: () => () => undefined,
    delegations: async (): Promise<ViewResult<DelegationPage>> =>
      granted ? { state: "ready", data: { rows: [ROW] } } : NEEDS,
  } as unknown as PanelDataSource;

  const el = page.document.createElement("section");
  page.document.body.append(el);
  const data = createSectionData(() => source);
  await data.refresh("delegations");
  const dialogs = createSectionDialogs(() => el);
  const toasts: string[] = [];
  const ctx = {
    client: () => handle.client,
    text: panelText,
    appLabel: () => "Fieldnotes",
    requestRender: () => data.notify(),
    toastsEnabled: () => true,
    toast: (request: { textCode: string }) => {
      toasts.push(request.textCode);
      return "t";
    },
    receipt: () => true,
    data,
    confirm: (request: Parameters<typeof dialogs.confirm>[0]) => dialogs.confirm(request),
    openDrawer: (request: Parameters<typeof dialogs.openDrawer>[0]) => dialogs.openDrawer(request),
  } as unknown as SectionContext;
  cleanups.push(delegationsSection.mount(el, ctx));
  cleanups.push(() => dialogs.closeAll());
  await flush();
  return { el, handle, requests, toasts, setCapable: (value: boolean) => (capable = value) };
}

const allow = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Allow delegation list" || b.textContent === "Waiting for your answer…",
  );
const cardCount = (el: HTMLElement) => el.querySelectorAll("article.dl-card").length;

describe("the Delegations tab's permission button", () => {
  test("the tab's entry is delegation/list on the app's own space, read-only", () => {
    expect(TAB_PERMISSION["delegation/list"]).toEqual(ENTRY);
  });

  test("a page that can ask: the button asks for exactly the tab's entry, once, with the lifetime", async () => {
    const h = await mount();
    const button = allow(h.el);
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);
    button?.click();
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.entries).toEqual([ENTRY]);
    expect(h.requests[0]?.options).toEqual({ expiryMs: TAB_PERMISSION_EXPIRY_MS });
    expect(TAB_PERMISSION_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("approve: the tab reloads in place and shows the data, with no button", async () => {
    const h = await mount();
    allow(h.el)?.click();
    await flush();
    expect(cardCount(h.el)).toBe(1);
    expect(allow(h.el)).toBeUndefined();
    expect(h.toasts).toEqual([]);
  });

  test("decline: the tab stays as it was, no toast, and the button can be used again", async () => {
    const h = await mount({ request: async () => ({ approved: false }) });
    allow(h.el)?.click();
    await flush();
    expect(cardCount(h.el)).toBe(0);
    expect(h.el.textContent).toContain("can't list delegations yet");
    expect(h.el.textContent).toContain("nothing changed");
    expect(h.el.textContent).not.toContain("didn't go through");
    expect(h.toasts).toEqual([]);
    expect(allow(h.el)?.disabled).toBe(false);
    expect(h.requests).toHaveLength(1);
  });

  test("an error shows a short error line, not the declined line, and no toast", async () => {
    const h = await mount({
      request: async () => {
        throw new Error("no manifest");
      },
    });
    allow(h.el)?.click();
    await flush();
    const lines = [...h.el.querySelectorAll("[role=status]")].map((line) => line.textContent);
    expect(lines).toContain("The request didn't go through. Try again.");
    expect(h.el.textContent).not.toContain("nothing changed");
    expect(cardCount(h.el)).toBe(0);
    expect(h.toasts).toEqual([]);
    expect(allow(h.el)?.disabled).toBe(false);
  });

  test("busy while the prompt is open: a second click sends no second request", async () => {
    const gate = Promise.withResolvers<{ approved: boolean }>();
    const h = await mount({ request: () => gate.promise });
    const button = allow(h.el);
    button?.click();
    await flush();
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe("Waiting for your answer…");
    button?.click();
    await flush();
    expect(h.requests).toHaveLength(1);
    gate.resolve({ approved: true });
    await flush();
    expect(cardCount(h.el)).toBe(1);
  });

  test("a second panel client call while one is open gets the open request's answer", async () => {
    const gate = Promise.withResolvers<{ approved: boolean }>();
    const h = await mount({ request: () => gate.promise });
    const ask = h.handle.client.requestAuthority;
    const first = ask?.("delegation/list");
    const second = ask?.("delegation/list");
    await flush();
    expect(h.requests).toHaveLength(1);
    gate.resolve({ approved: false });
    expect(await first).toEqual({ approved: false, code: "declined" });
    expect(await second).toEqual({ approved: false, code: "declined" });
    // Once settled, the next click is a new request.
    void ask?.("delegation/list");
    await flush();
    expect(h.requests).toHaveLength(2);
  });

  test("a page that cannot ask (no signer or manifest, e.g. after a reload): no button, sign-in guidance", async () => {
    const h = await mount({ capable: false });
    expect(allow(h.el)).toBeUndefined();
    expect(h.el.querySelectorAll("button")).toHaveLength(0);
    expect(h.el.textContent).toContain("can't list delegations yet");
    expect(h.el.textContent).toContain("Sign in again to allow it.");
    expect(h.requests).toHaveLength(0);
  });

  test("a host without a request capability: no button, sign-in guidance", async () => {
    const h = await mount({ noRequest: true });
    expect(allow(h.el)).toBeUndefined();
    expect(h.el.textContent).toContain("Sign in again to allow it.");
  });

  test("the ability turns false after sign-out: the client stops offering it", async () => {
    const h = await mount();
    expect(h.handle.client.requestAuthority).toBeDefined();
    h.setCapable(false);
    expect(h.handle.client.requestAuthority).toBeUndefined();
  });

  test("native: a disabled button and an explanation; clicking asks for nothing", async () => {
    const h = await mount({ platform: "native" });
    const button = allow(h.el);
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(true);
    expect(h.el.textContent).toContain("This app can't ask for this permission from here.");
    expect(h.el.textContent).not.toContain("Sign in again");
    button?.click();
    await flush();
    expect(h.requests).toHaveLength(0);
    expect(h.handle.client.requestAuthority).toBeUndefined();
  });

  test("the tab says what the list covers: the whole account, not only this app", async () => {
    const h = await mount();
    expect(h.el.textContent).toContain(
      "This shows every app and link that can reach your data across your whole account, and the names of what each can reach. It doesn't show keys or contents.",
    );
  });

  test("a kind with no entry is not offered and asks for nothing", async () => {
    const h = await mount();
    expect(h.handle.client.canRequest?.("space/info")).toBe(false);
    expect(h.handle.client.canRequest?.("delegation/list")).toBe(true);
    expect(await h.handle.client.requestAuthority?.("space/info")).toEqual({ approved: false, code: "unsupported" });
    expect(h.requests).toHaveLength(0);
  });
});

describe("ui.platform", () => {
  test("defaults to web; native only when asked for", () => {
    expect(resolveUiConfig(undefined).platform).toBe("web");
    expect(resolveUiConfig({}).platform).toBe("web");
    expect(resolveUiConfig({ platform: "native" }).platform).toBe("native");
    expect(resolveUiConfig({ platform: "desktop" as unknown as "web" }).platform).toBe("web");
  });
});

describe("the Storage tab with a client that can ask", () => {
  test("shows what it showed when the client could not ask: the body, a neutral note, no button", async () => {
    const requests: unknown[] = [];
    const source: ClientSource = {
      signedIn: () => true,
      storage: { status: async () => ({ ok: false }) } as unknown as ClientSource["storage"],
      canRequestPermissions: () => true,
      requestPermissions: async (entries) => {
        requests.push(entries);
        return { approved: true };
      },
    };
    const { client } = createPanelClient(1, source);
    expect(client.requestAuthority).toBeDefined();
    const ctx = {
      client: () => client,
      onClientChange: () => () => undefined,
      appLabel: () => "Example app",
      requestRender: () => undefined,
      text: panelText,
      data: {
        source: {},
        latest: () => ({ state: "needs-permission", ability: "space/info" }),
        age: () => 5_000,
        refresh: async () => undefined,
        subscribe: () => () => undefined,
      },
    } as unknown as SectionContext;
    const el = page.document.createElement("div");
    page.document.body.append(el);
    cleanups.push(storageSection.mount(el, ctx));
    await flush();
    expect(el.querySelector<HTMLButtonElement>(".storage-ask button")?.hidden).toBe(true);
    expect(el.querySelector(".storage-ask .note")?.textContent).toBe("This session has no way to ask for it here.");
    expect(el.querySelector(".storage-ask p")?.textContent).not.toContain("OpenKey");
    expect(requests).toHaveLength(0);
  });
});
