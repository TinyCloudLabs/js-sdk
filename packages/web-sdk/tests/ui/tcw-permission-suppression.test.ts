import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { Manifest, PermissionEntry } from "@tinycloud/sdk-core";

import type { TinyCloudWeb as TinyCloudWebType } from "../../src/modules/tcw";
import { REGISTRY_KEY } from "../../src/ui/host";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const ORIGIN = "https://app.example";
const PATHNAME = "/page";
const GLOBAL_NAMES = [
  "window",
  "document",
  "location",
  "localStorage",
  "customElements",
  "HTMLElement",
  "Element",
  "Event",
  "KeyboardEvent",
];

const manifest: Manifest = {
  app_id: "com.test.app",
  name: "Test App",
  permissions: [],
};

const additional: PermissionEntry[] = [
  {
    service: "tinycloud.kv",
    space: "default",
    path: "items/",
    actions: ["tinycloud.kv/get"],
  },
] as unknown as PermissionEntry[];

// The storage key that suppression writes and reads for this page and app.
const SUPPRESSION_KEY = `tinycloud:permission-prompt-suppression:${encodeURIComponent(
  `${ORIGIN}${PATHNAME}`,
)}:${encodeURIComponent(manifest.app_id)}`;

let page: Window;
let TinyCloudWeb: typeof TinyCloudWebType;
const saved = new Map<string, unknown>();

beforeAll(async () => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: `${ORIGIN}${PATHNAME}` }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  g.location = page.location;
  g.localStorage = page.localStorage;
  g.customElements = page.customElements;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
  g.KeyboardEvent = page.KeyboardEvent;
  // Dynamic import with a query suffix: tcw's module graph extends HTMLElement
  // at evaluation time, and other test files mock "../src/modules/tcw".
  TinyCloudWeb = (await import("../../src/modules/tcw.ts?tcw-suppression")).TinyCloudWeb;
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

beforeEach(() => {
  delete g[REGISTRY_KEY];
  page.localStorage.clear();
});

interface Hooks {
  showModal: (opts: unknown) => Promise<{ approved: boolean; suppressPromptFor30Days?: boolean }>;
  grantPermissions: (approved: unknown) => Promise<void>;
}

// Builds a TinyCloudWeb with the stored manifest and stubs only what the
// escalation path reaches outside the suppression code under test.
function makeTcw(hooks: Hooks) {
  const tcw = new TinyCloudWeb({ persistSession: false, manifest }) as unknown as Loose;
  tcw._node = {};
  tcw.session = () => undefined;
  tcw._testHooks = {
    showModal: hooks.showModal,
    hasRuntimePermissions: () => false,
    grantPermissions: hooks.grantPermissions,
  };
  return tcw as unknown as TinyCloudWebType & { requestPermissions: (p: PermissionEntry[]) => Promise<{ approved: boolean }> };
}

describe("TinyCloudWeb.requestPermissions suppression", () => {
  test("approving with 'don't ask for 30 days' writes the record under the existing key", async () => {
    let modalCalls = 0;
    const tcw = makeTcw({
      showModal: async () => {
        modalCalls += 1;
        return { approved: true, suppressPromptFor30Days: true };
      },
      grantPermissions: async () => {},
    });

    const result = await tcw.requestPermissions(additional);

    expect(result.approved).toBe(true);
    expect(modalCalls).toBe(1);
    const raw = page.localStorage.getItem(SUPPRESSION_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).expiresAt).toBeGreaterThan(Date.now());
  });

  test("a later request skips the modal once suppression is recorded", async () => {
    let modalCalls = 0;
    const tcw = makeTcw({
      showModal: async () => {
        modalCalls += 1;
        return { approved: true, suppressPromptFor30Days: true };
      },
      grantPermissions: async () => {},
    });

    await tcw.requestPermissions(additional);
    const second = await tcw.requestPermissions(additional);

    expect(second.approved).toBe(true);
    expect(modalCalls).toBe(1);
  });

  test("approving without the checkbox writes no suppression record", async () => {
    const tcw = makeTcw({
      showModal: async () => ({ approved: true, suppressPromptFor30Days: false }),
      grantPermissions: async () => {},
    });

    await tcw.requestPermissions(additional);

    expect(page.localStorage.getItem(SUPPRESSION_KEY)).toBeNull();
  });

  test("declining with the checkbox ticked writes no suppression record", async () => {
    const tcw = makeTcw({
      showModal: async () => ({ approved: false, suppressPromptFor30Days: true }),
      grantPermissions: async () => {},
    });

    const result = await tcw.requestPermissions(additional);

    expect(result.approved).toBe(false);
    expect(page.localStorage.getItem(SUPPRESSION_KEY)).toBeNull();
  });
});
