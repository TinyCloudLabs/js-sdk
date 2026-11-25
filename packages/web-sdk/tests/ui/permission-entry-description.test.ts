/*
 * TC-4323: an entry's description, set by the app, is the first line of that entry in the permission prompt, shown as
 * text and cut to 140 characters, with a cut one shown whole in the technical details. An entry without one renders
 * with nothing in its place.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { PermissionEntry } from "@tinycloud/sdk-core";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "location", "localStorage", "customElements", "HTMLElement", "Element", "Event", "KeyboardEvent"];

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const KEY = `${NETWORK}/secrets/scoped/tinychat-bot-history/bot-history`;
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DESCRIPTION = "Set up encryption and read chat history with your bots in your TinyCloud (up to 7 days).";

const botHistory: PermissionEntry = { service: "tinycloud.encryption", path: KEY, actions: ["decrypt", "key.create"] };
const networkWide: PermissionEntry = { service: "tinycloud.encryption", path: NETWORK, actions: ["decrypt"] };
const kv: PermissionEntry = { service: "tinycloud.kv", path: "notes/", actions: ["get", "put"] };

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
  // Query suffix: the module extends HTMLElement at evaluation time, and other test files mock it.
  Modal = (await import("../../src/notifications/PermissionRequestModal.ts?permission-entry-description"))
    .TinyCloudPermissionRequestModal as unknown as typeof Modal;
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

function entries(additional: PermissionEntry[]): Element[] {
  const root = new Modal({ appName: "TinyChat", additional, expiryMs: 7 * DAY_MS }).shadowRoot!;
  return [...root.querySelectorAll(".permission-entry")];
}

function entry(permission: PermissionEntry): Element {
  return entries([permission])[0]!;
}

describe("an entry with a description", () => {
  test("shows it as the entry's first line", () => {
    for (const permission of [botHistory, networkWide, kv]) {
      const shown = entry({ ...permission, description: HISTORY_DESCRIPTION });
      const lead = shown.firstElementChild!;

      expect(lead.getAttribute("data-role")).toBe("entry-description");
      expect(lead.textContent).toBe(HISTORY_DESCRIPTION);
      // The built-in text and the technical rows follow it.
      expect(shown.querySelector(".technical-details")).not.toBeNull();
    }
    const network = entry({ ...networkWide, description: HISTORY_DESCRIPTION });
    expect(network.children[1]!.classList.contains("permission-summary-list")).toBe(true);
    expect(network.textContent).toContain("Decrypt data keys for this network");
  });

  test("shows markup and quotes as text, never parsed", () => {
    const html = `<b>x</b> "double" 'single' & <img src=x onerror="alert(1)">`;
    const shown = entry({ ...kv, description: html });
    const lead = shown.querySelector('[data-role="entry-description"]')!;

    expect(lead.textContent).toBe(html);
    expect(shown.querySelector("b")).toBeNull();
    expect(shown.querySelector("img")).toBeNull();
  });

  test("shows hidden characters escaped, as every other request string, and line breaks as spaces", () => {
    const shown = (text: string) =>
      entry({ ...kv, description: text }).querySelector('[data-role="entry-description"]')!.textContent;

    expect(shown("Notes\u202Etxt.exe")).toBe("Notes\\u{202E}txt.exe");
    expect(shown("  Read\n\n your\tnotes  ")).toBe("Read your notes");
  });

  test("shows invisible operators and tag characters escaped, whole, and leaves other astral characters alone", () => {
    const shown = (text: string) =>
      entry({ ...kv, description: text }).querySelector('[data-role="entry-description"]')!.textContent!;

    expect(shown("a\u2060b\u2064c")).toBe("a\\u{2060}b\\u{2064}c");
    expect(shown("Notes\u{E0041}\u{E007F}")).toBe("Notes\\u{E0041}\\u{E007F}");
    expect(shown("Chat 😀 \u{E0001}")).toBe("Chat 😀 \\u{E0001}");
    expect(shown("Chat 😀 \u{E0001}").isWellFormed()).toBe(true);
  });

  test("a tag character in the resource is shown escaped in the technical details", () => {
    const shown = entry({ ...kv, path: "notes\u{E0041}/" });

    expect(shown.querySelector(".permission-dictionary")!.textContent).toContain("notes\\u{E0041}/");
  });

  test("each entry shows its own description", () => {
    const shown = entries([{ ...kv, description: "Your notes" }, kv, { ...botHistory, description: HISTORY_DESCRIPTION }]);

    expect(shown.map((item) => item.querySelector('[data-role="entry-description"]')?.textContent ?? null))
      .toEqual(["Your notes", null, HISTORY_DESCRIPTION]);
  });
});

describe("a long description", () => {
  const full = (shown: Element) => shown.querySelector('[data-role="entry-description-full"]');
  const line = (shown: Element) => shown.querySelector('[data-role="entry-description"]')!.textContent!;

  test("is cut to 140 characters ending with an ellipsis, and shown whole in the technical details", () => {
    const words = "Read the encrypted notes you saved so the assistant can quote them back to you. ".repeat(3);
    const shown = entry({ ...kv, description: `${words}\n\tEnd.` });
    const folded = `${words.trim()} End.`;

    expect(Array.from(line(shown))).toHaveLength(140);
    expect(line(shown)).toBe(`${folded.slice(0, 139)}…`);
    expect(full(shown)!.textContent).toBe(folded);
    expect(full(shown)!.closest(".technical-details")).not.toBeNull();
  });

  test("of exactly 140 characters is not cut and has no second copy", () => {
    const shown = entry({ ...kv, description: "x".repeat(140) });

    expect(line(shown)).toBe("x".repeat(140));
    expect(full(shown)).toBeNull();
  });

  test("is cut between characters, never inside a surrogate pair", () => {
    const shown = entry({ ...kv, description: `${"a".repeat(138)}😀${"b".repeat(10)}` });

    expect(line(shown)).toBe(`${"a".repeat(138)}😀…`);
    expect(line(shown).isWellFormed()).toBe(true);
  });

  test("shows its hidden characters escaped in both the cut line and the whole text", () => {
    const shown = entry({ ...kv, description: `\u202E${"y".repeat(200)}` });

    expect(line(shown)).toBe(`\\u{202E}${"y".repeat(138)}…`);
    expect(full(shown)!.textContent).toBe(`\\u{202E}${"y".repeat(200)}`);
  });
});

describe("an entry without a description", () => {
  test("renders the same markup as one whose description is missing, empty or blank", () => {
    for (const permission of [botHistory, networkWide, kv]) {
      const plain = entry(permission).outerHTML;

      expect(plain).not.toContain("entry-description");
      for (const description of [undefined, "", "   \n\t "]) {
        expect(entry({ ...permission, description }).outerHTML).toBe(plain);
      }
    }
  });

  test("starts with the built-in text, with no empty line above it", () => {
    expect(entry(networkWide).firstElementChild!.classList.contains("permission-summary-list")).toBe(true);
    expect(entry(botHistory).firstElementChild!.classList.contains("technical-details")).toBe(true);
  });
});
