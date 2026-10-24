import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

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
}

function mountWith(opts: Opts) {
  const signOutCalls = { n: 0 };
  const opened: SectionId[] = [];
  const toasts: Array<{ kind: string; textCode: string }> = [];
  const client = {
    id: 1,
    signedIn: opts.signedIn ?? (() => true),
    onReset: () => () => undefined,
    storage: { status: async () => ({}) },
    data: {
      subscribe: () => () => undefined,
      account: async () => ({ state: "ready", data: { ...ACCOUNT, ...opts.account } }),
    },
    requests: opts.requests ? {} : undefined,
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
    developerMode: () => false,
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
    openSection: (id: SectionId) => opened.push(id),
    closePanel: () => undefined,
  } as unknown as SectionContext;
  const el = page.document.createElement("div");
  page.document.body.append(el);
  const dispose = accountSection.mount(el as unknown as HTMLElement, ctx);
  cleanups.push(dispose);
  return { el, signOutCalls, opened, toasts };
}

const button = (root: ParentNode, label: string): HTMLButtonElement => {
  const hit = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!hit) throw new Error(`no button "${label}"`);
  return hit as HTMLButtonElement;
};

describe("Overview section", () => {
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
