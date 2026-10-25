import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { PANEL_SECTIONS } from "../../src/ui/sections";
import { accountSection } from "../../src/ui/sections/account";
import type { SectionContext, SectionId } from "../../src/ui/slots";
import { panelText as text } from "../../src/ui/strings-panel";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent"];
const ACCOUNT = {
  did: "did:key:z6MkTest",
  host: "https://tinycloud.example",
  applications: 1,
  spaces: 1,
  grantedDelegations: 0,
  receivedDelegations: 0,
  appName: "Notes",
  appHost: "notes.example",
};

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
  signedIn?: () => boolean;
  account?: Record<string, unknown>;
  signOut?: () => Promise<void>;
  requests?: boolean;
  layout?: "drawer" | "page";
  latest?: (key: string) => unknown;
  generation?: () => number;
  /** Replaces `account()`; lets a spec hold a read open. */
  readAccount?: () => Promise<unknown>;
}

function mountWith(opts: Opts) {
  const signOutCalls = { n: 0 };
  const opened: SectionId[] = [];
  const toasts: Array<{ kind: string; textCode: string }> = [];
  const dataListeners: Array<() => void> = [];
  const resetListeners: Array<() => void> = [];
  const client = {
    id: 1,
    signedIn: opts.signedIn ?? (() => true),
    onReset: (cb: () => void) => {
      resetListeners.push(cb);
      return () => undefined;
    },
    storage: { status: async () => ({}) },
    data: {
      subscribe: () => () => undefined,
      account: opts.readAccount ?? (async () => ({ state: "ready", data: { ...ACCOUNT, ...opts.account } })),
    },
    requests: opts.requests ? { snapshot: () => [] } : undefined,
    sync: {},
    signOut: opts.signOut
      ? async () => {
          signOutCalls.n += 1;
          await opts.signOut!();
        }
      : undefined,
  };
  const ctx = {
    client: () => client,
    onClientChange: () => () => undefined,
    developerMode: () => opts.requests === true,
    setStatus: () => undefined,
    topStatus: () => null,
    onStatusChange: () => () => undefined,
    toastsEnabled: () => true,
    toast: (t: { kind: string; textCode: string }) => {
      toasts.push(t);
      return "";
    },
    text,
    appLabel: () => undefined,
    canHideButton: () => false,
    hideButton: () => undefined,
    data: {
      source: client.data,
      latest: opts.latest ?? (() => undefined),
      age: () => undefined,
      generation: opts.generation ?? (() => 0),
      refresh: async () => undefined,
      subscribe: (cb: () => void) => {
        dataListeners.push(cb);
        return () => undefined;
      },
    },
    layout: () => opts.layout ?? "drawer",
    sections: () => PANEL_SECTIONS.filter((section) => section.isAvailable(ctx)),
    openSection: (id: SectionId) => opened.push(id),
    closePanel: () => undefined,
  } as unknown as SectionContext;
  const el = page.document.createElement("div");
  page.document.body.append(el);
  const dispose = accountSection.mount(el as unknown as HTMLElement, ctx);
  cleanups.push(dispose);
  return { el, signOutCalls, opened, toasts, dataListeners, resetListeners };
}

const button = (root: ParentNode, label: string): HTMLButtonElement => {
  const hit = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!hit) throw new Error(`no button "${label}"`);
  return hit as HTMLButtonElement;
};

describe("Overview section", () => {
  describe("identity title", () => {
    const LONG_DID = "did:pkh:eip155:1:0x00000000000000000000000000000000000c41d0";
    const title = (el: HTMLElement) => el.querySelector(".account-ident .name") as HTMLElement;
    const didLine = (el: HTMLElement) => el.querySelector(".account-did") as HTMLElement;

    test("no ENS name: the short DID is the one title, the full DID is not on screen and one copy button remains", async () => {
      const { el } = mountWith({ account: { did: LONG_DID } });
      await flush();
      expect(title(el).textContent).toBe(`${LONG_DID.slice(0, 20)}…${LONG_DID.slice(-4)}`);
      expect(title(el).title).toBe(LONG_DID);
      expect(didLine(el).hidden).toBe(true);
      expect(el.querySelectorAll(".account-copy")).toHaveLength(1);
      // The short form shows once, and the long form never shows as text.
      const identityText = [...el.querySelectorAll(".account-ident *")]
        .filter((node) => !(node as HTMLElement).hidden && node.children.length === 0)
        .map((node) => node.textContent)
        .join("|");
      expect(identityText).not.toContain(LONG_DID);
    });

    test("with an ENS name: the name is the title and the short DID sits under it", async () => {
      const { el } = mountWith({ account: { did: LONG_DID, displayName: "maya.example.eth" } });
      await flush();
      expect(title(el).textContent).toBe("maya.example.eth");
      expect(didLine(el).hidden).toBe(false);
      expect(didLine(el).textContent).toBe(`${LONG_DID.slice(0, 20)}…${LONG_DID.slice(-4)}`);
      expect(el.querySelectorAll(".account-copy")).toHaveLength(1);
    });
  });

  test("signed out: shows the signed-out note and hides the account columns", async () => {
    const { el } = mountWith({ signedIn: () => false });
    await flush();
    const note = el.querySelector(".note") as HTMLElement;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(text("account.signed_out"));
    const cols = el.querySelector(".account-cols") as HTMLElement;
    expect(cols.hidden).toBe(true);
  });

  test("session row appears only when the account reports an expiry", async () => {
    const without = mountWith({});
    await flush();
    const rowsWithout = [...without.el.querySelectorAll(".account-kv > div")] as HTMLElement[];
    expect(rowsWithout.find((r) => r.textContent?.includes(text("account.session.label")))?.hidden).toBe(true);

    // 125.5 min out: the countdown rounds up to the minute, so 126 min = 2h 06m.
    const expires = new Date(Date.now() + 125.5 * 60_000);
    const withExpiry = mountWith({ account: { sessionExpiresAt: expires } });
    await flush();
    const row = [...withExpiry.el.querySelectorAll(".account-kv > div")].find((r) =>
      r.textContent?.includes(text("account.session.label")),
    ) as HTMLElement;
    expect(row.hidden).toBe(false);
    expect(row.querySelector("dd")?.textContent).toBe("Expires in 2h 06m");
  });

  test("sign out is hidden when the client has no signOut", async () => {
    const { el } = mountWith({});
    await flush();
    expect(button(el, text("account.signout.button")).hidden).toBe(true);
  });

  test("confirm opens with the safe action focused; cancel never signs out", async () => {
    const { el, signOutCalls } = mountWith({ signOut: async () => undefined });
    await flush();
    button(el, text("account.signout.button")).click();
    const dialog = el.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(page.document.activeElement).toBe(button(dialog, text("account.signout.cancel")));
    button(dialog, text("account.signout.cancel")).click();
    expect(signOutCalls.n).toBe(0);
    expect(el.querySelector('[role="alertdialog"]')).toBeNull();
  });

  test("confirming signs out once and shows the signed-out state", async () => {
    let session = true;
    const { el, signOutCalls } = mountWith({
      signedIn: () => session,
      signOut: async () => {
        session = false;
      },
    });
    await flush();
    button(el, text("account.signout.button")).click();
    const dialog = el.querySelector('[role="alertdialog"]') as HTMLElement;
    button(dialog, text("account.signout.confirm")).click();
    await flush();
    expect(signOutCalls.n).toBe(1);
    const cols = el.querySelector(".account-cols") as HTMLElement;
    expect(cols.hidden).toBe(true);
    expect((el.querySelector(".note") as HTMLElement).hidden).toBe(false);
  });

  test("a failed sign-out keeps the session and shows the failure note", async () => {
    const { el, signOutCalls } = mountWith({
      signOut: async () => {
        throw new Error("network");
      },
    });
    await flush();
    button(el, text("account.signout.button")).click();
    const dialog = el.querySelector('[role="alertdialog"]') as HTMLElement;
    button(dialog, text("account.signout.confirm")).click();
    await flush();
    expect(signOutCalls.n).toBe(1);
    const note = [...el.querySelectorAll(".note")].find((n) => n.textContent === text("account.signout.failed"));
    expect((note as HTMLElement).hidden).toBe(false);
    expect((el.querySelector(".account-cols") as HTMLElement).hidden).toBe(false);
  });

  test("an At-a-glance row opens its section", async () => {
    const { el, opened } = mountWith({});
    await flush();
    const row = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(text("nav.local-copy")),
    ) as HTMLButtonElement;
    row.click();
    expect(opened).toEqual(["local-copy"]);
  });

  test("the intro line is shown in the sidebar and hidden on the full page", async () => {
    const hint = (root: ParentNode) => root.querySelector(".account-hint") as HTMLElement;
    const drawer = mountWith({ layout: "drawer" });
    await flush();
    expect(hint(drawer.el).hidden).toBe(false);
    expect(hint(drawer.el).textContent).toBe(text("account.hint"));

    const fullPage = mountWith({ layout: "page" });
    await flush();
    expect(hint(fullPage.el).hidden).toBe(true);
  });

  test("the intro line stays hidden when signed out, even in the sidebar", async () => {
    const { el } = mountWith({ signedIn: () => false, layout: "drawer" });
    await flush();
    expect((el.querySelector(".account-hint") as HTMLElement).hidden).toBe(true);
  });

  test("glance rows take their label, icon and status from the sections", async () => {
    const latest = (key: string) =>
      key === "nodes" ? { state: "ready", data: [{ status: "slow" }, { status: "ok" }] } : undefined;
    const { el } = mountWith({ latest });
    await flush();
    const rows = [...el.querySelectorAll(".glance-row")] as HTMLElement[];
    expect(rows.map((row) => row.querySelector("b")?.textContent)).toEqual([
      text("nav.local-tinycloud"),
      text("nav.local-copy"),
      text("nav.delegations"),
      text("nav.nodes"),
      text("nav.storage"),
    ]);
    const nodes = rows.find((row) => row.textContent?.includes(text("nav.nodes"))) as HTMLElement;
    expect(nodes.querySelector(".st")?.textContent).toBe("1 slow");
    expect(nodes.querySelector(".st")?.className).toBe("st st-warn");
    expect(rows[0].querySelector(".st")).toBeNull();
  });

  test("an account change drops the old account's facts and ignores its late read", async () => {
    let calls = 0;
    let releaseSecond: (value: unknown) => void = () => undefined;
    const readAccount = () => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ state: "ready", data: { ...ACCOUNT, did: "did:key:old", displayName: "Old Name" } });
      return new Promise((resolve) => (releaseSecond = resolve));
    };
    const { el, resetListeners } = mountWith({ readAccount });
    await flush();
    const name = () => (el.querySelector(".account-ident .name") as HTMLElement).textContent;
    expect(name()).toBe("Old Name");

    for (const listener of resetListeners) listener();
    await flush();
    // The new account's read is still out: the old name must not be on screen meanwhile.
    expect((el.querySelector(".account-ident") as HTMLElement).hidden).toBe(true);

    releaseSecond({ state: "ready", data: { ...ACCOUNT, did: "did:key:new", displayName: "New Name" } });
    await flush();
    expect(name()).toBe("New Name");
  });

  test("copying the DID across an account change shows no toast", async () => {
    let generation = 0;
    const realNavigator = globalThis.navigator;
    let releaseCopy: () => void = () => undefined;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: () => new Promise<void>((resolve) => (releaseCopy = resolve)) } },
    });
    try {
      const { el, toasts } = mountWith({ generation: () => generation });
      await flush();
      (el.querySelector(".account-copy") as HTMLButtonElement).click();
      generation += 1;
      releaseCopy();
      await flush();
      expect(toasts).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: realNavigator });
    }
  });

  test("copying the DID in the same account confirms it", async () => {
    const realNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => undefined } } });
    try {
      const { el, toasts } = mountWith({});
      await flush();
      (el.querySelector(".account-copy") as HTMLButtonElement).click();
      await flush();
      expect(toasts).toEqual([{ kind: "success", textCode: "account.copied" }]);
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: realNavigator });
    }
  });

  test("a cache change repaints the row statuses in place", async () => {
    let state = "ok";
    const latest = (key: string) => (key === "storage" ? { state: "ready", data: { state } } : undefined);
    const { el, dataListeners } = mountWith({ latest });
    await flush();
    const row = () =>
      [...el.querySelectorAll(".glance-row")].find((r) => r.textContent?.includes(text("nav.storage"))) as HTMLElement;
    const before = row();
    expect(before.querySelector(".st")?.textContent).toBe("Normal");
    state = "full";
    for (const listener of dataListeners) listener();
    expect(row()).toBe(before);
    expect(before.querySelector(".st")?.textContent).toBe("Full");
  });

  test("Activity row is listed only in developer mode", async () => {
    const hasActivity = (root: ParentNode) =>
      [...root.querySelectorAll("button")].some((b) => b.textContent?.includes(text("nav.activity")));
    const plain = mountWith({});
    await flush();
    expect(hasActivity(plain.el)).toBe(false);

    const dev = mountWith({ requests: true });
    await flush();
    expect(hasActivity(dev.el)).toBe(true);
  });
});
