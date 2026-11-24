/*
 * TC-4222: the permission prompt says exactly what the request grants, in a line derived from the request itself, and
 * shows an app's optional caption beneath it as plain text.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { Manifest, PermissionEntry } from "@tinycloud/sdk-core";
import { SECRET_KEY_GRANT_DEFAULT_MS, SECRET_KEY_GRANT_MAX_MS } from "@tinycloud/node-sdk";
import { EXPIRY, expandPermissionEntries } from "@tinycloud/sdk-core";

// node-sdk's own lifetime rule is not exported from an entry web-sdk imports; pin against its source.
import { isSecretKeyEntry, resolveExpiryMs, secretKeyGrantExpiryMs } from "../../../node-sdk/src/delegateToHelpers";

import type { TinyCloudWeb as TinyCloudWebType } from "../../src/modules/tcw";
import { requestPermissionsCore, type RequestPermissionsOptions } from "../../src/modules/requestPermissionsCore";
import { grantLifetimeMs } from "../../src/notifications/permissionLine";

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

describe("hidden characters in the request", () => {
  const RLO = "\u202E";
  const spoofed: PermissionEntry = {
    service: "tinycloud.encryption",
    path: `${NETWORK}/secrets/scoped/tinychat-bot-history/${RLO}yrotsih-tob`,
    actions: ["decrypt"],
  };

  test("an RLO in a key path is shown as a visible escape, in the line and in the technical details", () => {
    const root = render({ additional: [spoofed], expiryMs: 7 * DAY_MS });

    expect(lines(root)).toEqual([
      "Decrypt with the key secrets/scoped/tinychat-bot-history/\\u{202E}yrotsih-tob (only this key), for up to 7 days.",
    ]);
    const resource = [...root.querySelectorAll(".dictionary-row")]
      .find((row) => row.querySelector("dt")?.textContent === "Resource")!
      .querySelector("dd")!.textContent;
    expect(resource).toBe(`${NETWORK}/secrets/scoped/tinychat-bot-history/\\u{202E}yrotsih-tob`);
    expect(root.innerHTML).not.toContain(RLO);
  });

  test("controls, zero-width and isolate characters in a space, path and unknown action are escaped, never dropped", () => {
    const root = render({
      additional: [{ service: "tinycloud.kv", space: "de\u2066fault", path: "items\u200B/", actions: ["get", "sy\u0007nc"] }],
    });

    expect(lines(root)).toEqual([
      "Read and use “sy\\u{0007}nc” on everything under items\\u{200B}/ in the de\\u{2066}fault space, for up to 7 days.",
    ]);
    expect(root.innerHTML).not.toMatch(/[\u0007\u200B\u2066]/);
  });

  test("an RLO in the app name or the on-behalf-of name is shown escaped in the title, description and caption label", () => {
    const root = render({ appName: `Tiny${RLO}tahC`, additional: [botHistory], caption: "TrustBot's chat history" });
    expect(root.querySelector("#tc-permission-title")?.textContent).toBe("Tiny\\u{202E}tahC is requesting additional permissions");
    expect(caption(root)!.textContent).toBe("Label from Tiny\\u{202E}tahC: TrustBot's chat history");
    expect(root.innerHTML).not.toContain(RLO);

    const onBehalf = render({ appName: `Tiny${RLO}tahC`, onBehalfOf: `Trust${RLO}toB`, additional: [botHistory] });
    expect(onBehalf.querySelector("#tc-permission-title")?.textContent)
      .toBe("Trust\\u{202E}toB in Tiny\\u{202E}tahC is asking for more access");
    expect(onBehalf.querySelector("#tc-permission-description")?.textContent?.trim())
      .toBe("Review what Trust\\u{202E}toB will be allowed to do before you approve.");
    expect(onBehalf.innerHTML).not.toContain(RLO);
  });
});

describe("the stated lifetime is the node's, and the longer one on any doubt", () => {
  // node-sdk runtime-grants.ts:141-143: the node expands the request, then picks the secret-key rule when any
  // expanded entry is a secret's key. A request it cannot expand is refused; the prompt then states the longer rule.
  function nodeLifetime(entries: PermissionEntry[], expiry: number | undefined): number {
    let expanded: PermissionEntry[];
    try {
      expanded = expandPermissionEntries(entries);
    } catch {
      return resolveExpiryMs(expiry);
    }
    return expanded.some(isSecretKeyEntry) ? secretKeyGrantExpiryMs(expiry) : resolveExpiryMs(expiry);
  }
  const encryption = (path: string, actions = ["decrypt"]): PermissionEntry => ({ service: "tinycloud.encryption", path, actions });
  const cases: Array<[string, PermissionEntry[]]> = [
    ["the bot-history key", [botHistory]],
    ["the bot-history key with a lower-case owner", [encryption(KEY.replace(OWNER, OWNER.toLowerCase()), ["decrypt", "key.create"])]],
    // node-sdk TinyCloudNode.runtimePermissions.test.ts:1552-1566
    ["a secret's key", [encryption(`${NETWORK}/secrets/api_key`)]],
    ["a secret's key beside a kv read", [
      { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/API_KEY", actions: ["tinycloud.kv/get"] },
      encryption(`${NETWORK}/secrets/api_key`),
    ]],
    ["a did:key owner's secret key", [encryption("urn:tinycloud:encryption:did:key:z6MkPrincipal:default/secrets/anthropic_api_key")]],
    ["a whole network", [encryption(NETWORK)]],
    ["the share prefix", [encryption(`${NETWORK}/share/`)]],
    ["`secrets` without a trailing slash", [encryption(`${NETWORK}/secrets`)]],
    ["a `secrets/` prefix", [encryption(`${NETWORK}/secrets/`)]],
    ["an upper-case secret name", [encryption(`${NETWORK}/secrets/API_KEY`)]],
    ["the short service name", [{ service: "encryption", path: KEY, actions: ["decrypt"] }]],
    ["a secret on another network", [encryption(`urn:tinycloud:encryption:${OWNER}:other/secrets/api_key`)]],
    ["a secrets-space kv entry only", [{ service: "tinycloud.kv", space: "secrets", path: "vault/secrets/API_KEY", actions: ["get"] }]],
  ];

  for (const [name, entries] of cases) {
    test(`${name}: same as the node`, () => {
      for (const expiry of [undefined, 59 * 60_000, 30 * DAY_MS]) {
        expect(grantLifetimeMs(entries, expiry)).toBe(nodeLifetime(entries, expiry));
      }
    });
  }

  test("a shape the node does not treat as a secret's key gets 7 days, never the 1-hour default", () => {
    for (const path of [`${NETWORK}/secrets`, `${NETWORK}/secrets/`, `${NETWORK}/secrets/API_KEY`]) {
      expect(lines(render({ additional: [encryption(path)] }))[0]).toEndWith("for up to 7 days.");
    }
    expect(lines(render({ additional: [{ service: "encryption", path: KEY, actions: ["decrypt"] }] }))[0])
      .toEndWith("for up to 7 days.");
  });
});
