/*
 * TC-4222: the permission prompt says exactly what the request grants, in a line derived from the request itself, and
 * shows an app's optional caption beneath it as plain text.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { Manifest, PermissionEntry } from "@tinycloud/sdk-core";
import { SECRET_KEY_GRANT_DEFAULT_MS, SECRET_KEY_GRANT_MAX_MS } from "@tinycloud/node-sdk";
import { EXPIRY } from "@tinycloud/sdk-core";

import type { TinyCloudWeb as TinyCloudWebType } from "../../src/modules/tcw";
import { requestPermissionsCore, type RequestPermissionsOptions } from "../../src/modules/requestPermissionsCore";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "location", "localStorage", "customElements", "HTMLElement", "Element", "Event", "KeyboardEvent"];

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const KEY_PATH = "secrets/scoped/tinychat-bot-history/bot-history";
const KEY = `${NETWORK}/${KEY_PATH}`;
const DAY_MS = 24 * 60 * 60 * 1000;

const botHistory: PermissionEntry = { service: "tinycloud.encryption", path: KEY, actions: ["decrypt", "key.create"] };
const BOT_HISTORY_LINE =
  "Create and decrypt with the key secrets/scoped/tinychat-bot-history/bot-history (only this key), for up to 7 days.";
const NETWORK_WIDE_WORDING = [
  "Encryption network",
  "encryption network",
  "for this network",
  "network-scoped",
  "Network-wide",
  "whole network",
  "Use Encryption",
  "Decrypt data keys",
];

const manifest: Manifest = { app_id: "com.tinychat.app", name: "TinyChat", permissions: [] };

let TinyCloudWeb: typeof TinyCloudWebType;
let Modal: new (options: Loose) => HTMLElement;
const saved = new Map<string, unknown>();

beforeAll(async () => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  const page = new JSDOM("", { url: "https://tinychat.example/" }).window;
  g.window = page;
  g.document = page.document;
  g.location = page.location;
  g.localStorage = page.localStorage;
  g.customElements = page.customElements;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
  g.KeyboardEvent = page.KeyboardEvent;
  // Query suffixes: these modules extend HTMLElement at evaluation time, and other test files mock them.
  TinyCloudWeb = (await import("../../src/modules/tcw.ts?permission-derived-line")).TinyCloudWeb;
  Modal = (await import("../../src/notifications/PermissionRequestModal.ts?permission-derived-line"))
    .TinyCloudPermissionRequestModal as unknown as typeof Modal;
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

function render(options: Loose): ShadowRoot {
  return new Modal({ appName: "TinyChat", ...options }).shadowRoot!;
}

function lines(root: ShadowRoot): string[] {
  return [...root.querySelectorAll('[data-role="permission-line"]')].map((line) => line.textContent ?? "");
}

function caption(root: ShadowRoot): Element | null {
  return root.querySelector('[data-role="app-caption"]');
}

/** Text a person can read: the dialog without its stylesheet. */
function visibleText(root: ShadowRoot): string {
  const clone = root.querySelector(".modal-backdrop")!.cloneNode(true) as Element;
  return clone.textContent ?? "";
}

describe("the derived line for TinyChat's bot-history key", () => {
  test("names the key, both actions and the 7-day expiry", () => {
    const root = render({ additional: [botHistory], expiryMs: 7 * DAY_MS });

    expect(lines(root)).toEqual([BOT_HISTORY_LINE]);
    // The full resource stays available.
    expect(visibleText(root)).toContain(KEY);
  });

  test("has no network-wide wording anywhere in the dialog", () => {
    const text = visibleText(render({ additional: [botHistory], expiryMs: 7 * DAY_MS }));

    for (const wording of NETWORK_WIDE_WORDING) expect(text).not.toContain(wording);
  });

  test("an unasked lifetime is the secret-key default, and a longer one is capped as the node caps it", () => {
    expect(lines(render({ additional: [botHistory] }))[0]).toEndWith("(only this key), for up to 1 hour.");
    expect(lines(render({ additional: [botHistory], expiryMs: 30 * DAY_MS }))[0]).toEndWith("for up to 7 days.");
    expect(lines(render({ additional: [botHistory], expiryMs: 59 * 60_000 }))[0]).toEndWith("for up to 59 minutes.");
  });

  test("the lifetimes it states are the node's", () => {
    expect(SECRET_KEY_GRANT_DEFAULT_MS).toBe(60 * 60_000);
    expect(SECRET_KEY_GRANT_MAX_MS).toBe(7 * DAY_MS);
    expect(EXPIRY.SESSION_MS).toBe(7 * DAY_MS);
  });
});

describe("the app's caption", () => {
  test("renders beneath the derived line as the app's label and does not replace it", () => {
    const root = render({ additional: [botHistory], expiryMs: 7 * DAY_MS, caption: "TrustBot's chat history" });

    expect(lines(root)).toEqual([BOT_HISTORY_LINE]);
    const label = caption(root)!;
    expect(label.textContent).toBe("Label from TinyChat: TrustBot's chat history");
    const line = root.querySelector('[data-role="permission-line"]')!;
    expect(line.compareDocumentPosition(label) & 4 /* DOCUMENT_POSITION_FOLLOWING */).toBe(4);
  });

  test("an HTML-ish caption is shown as text, never parsed", () => {
    const html = `<img src=x onerror="alert(1)"><b>bold</b>`;
    const root = render({ additional: [botHistory], expiryMs: 7 * DAY_MS, caption: html });

    expect(root.querySelector("img[onerror]")).toBeNull();
    expect(caption(root)!.querySelector("b")).toBeNull();
    expect(caption(root)!.textContent).toBe(`Label from TinyChat: ${html}`);
    expect(lines(root)).toEqual([BOT_HISTORY_LINE]);
  });

  test("is trimmed, folded to one line and capped at 120 characters", () => {
    expect(caption(render({ additional: [botHistory], caption: "  TrustBot's\n\n chat   history  " }))!.textContent)
      .toBe("Label from TinyChat: TrustBot's chat history");
    const long = caption(render({ additional: [botHistory], caption: "x".repeat(200) }))!.textContent!;
    expect(long).toBe(`Label from TinyChat: ${"x".repeat(119)}…`);
    expect(caption(render({ additional: [botHistory], caption: "   " }))).toBeNull();
    expect(caption(render({ additional: [botHistory] }))).toBeNull();
  });
});

describe("derived lines for other requests", () => {
  test("a network-wide entry says it is network-wide", () => {
    const root = render({ additional: [{ service: "tinycloud.encryption", path: NETWORK, actions: ["decrypt"] }] });

    expect(lines(root)).toEqual([
      "Decrypt data encrypted to the whole encryption network default, not just one key, for up to 7 days.",
    ]);
  });

  test("a storage entry names the path and the space, and an unknown action is shown verbatim", () => {
    const root = render({
      additional: [
        { service: "tinycloud.kv", space: "default", path: "items/", actions: ["tinycloud.kv/get", "tinycloud.kv/frobnicate"] },
        { service: "tinycloud.sql", space: "default", path: "/", actions: ["read"] },
      ],
      expiryMs: 90 * 60_000,
    });

    expect(lines(root)).toEqual([
      "Read and use “frobnicate” on everything under items/ in the default space, for up to 1 hour and 30 minutes.",
      "Read everything in the default space, for up to 1 hour and 30 minutes.",
    ]);
  });
});

describe("requestPermissions passes the caption and lifetime to the prompt", () => {
  test("requestPermissionsCore hands both to the modal", async () => {
    const shown: Loose[] = [];
    await requestPermissionsCore(
      [botHistory],
      { manifest, showModal: async (opts) => { shown.push(opts); return { approved: false }; }, grantPermissions: async () => {} },
      { expiryMs: 7 * DAY_MS, caption: "TrustBot's chat history" },
    );

    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ additional: [botHistory], expiryMs: 7 * DAY_MS, caption: "TrustBot's chat history" });
  });

  test("tcw.requestPermissions forwards them", async () => {
    const shown: Loose[] = [];
    const tcw = new TinyCloudWeb({ persistSession: false, manifest }) as unknown as Loose;
    tcw._node = {};
    tcw.session = () => undefined;
    tcw._testHooks = {
      showModal: async (opts: Loose) => { shown.push(opts); return { approved: false }; },
      hasRuntimePermissions: () => false,
      grantPermissions: async () => {},
    };
    const request = tcw as unknown as {
      requestPermissions: (p: PermissionEntry[], o?: RequestPermissionsOptions) => Promise<{ approved: boolean }>;
    };

    await request.requestPermissions([botHistory], { expiryMs: 7 * DAY_MS, caption: "TrustBot's chat history" });

    expect(shown[0]).toMatchObject({ expiryMs: 7 * DAY_MS, caption: "TrustBot's chat history" });
  });
});
