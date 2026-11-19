import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { Manifest, PermissionEntry } from "@tinycloud/sdk-core";

import type { TinyCloudWeb as TinyCloudWebType } from "../../src/modules/tcw";
import type { RequestPermissionsOptions } from "../../src/modules/requestPermissionsCore";
import { REGISTRY_KEY } from "../../src/ui/host";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const ORIGIN = "https://one.example";
const PATHNAME = "/chat/apps/xyz.tinycloud.account";
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
  app_id: "com.test.shell",
  name: "TinyCloud One",
  permissions: [],
};

const additional: PermissionEntry[] = [
  {
    service: "tinycloud.kv",
    space: "account",
    path: "applications/",
    actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
  },
] as unknown as PermissionEntry[];

const SUPPRESSION_KEY = `tinycloud:permission-prompt-suppression:${encodeURIComponent(
  `${ORIGIN}${PATHNAME}`,
)}:${encodeURIComponent(manifest.app_id)}`;

let page: Window;
let TinyCloudWeb: typeof TinyCloudWebType;
let Modal: new (options: Loose) => HTMLElement & { getCompletionPromise(): Promise<Loose> };
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
  // Query suffixes: these modules extend HTMLElement at evaluation time, and other test files mock them.
  TinyCloudWeb = (await import("../../src/modules/tcw.ts?tcw-on-behalf")).TinyCloudWeb;
  Modal = (await import("../../src/notifications/PermissionRequestModal.ts?tcw-on-behalf"))
    .TinyCloudPermissionRequestModal as unknown as typeof Modal;
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

function makeTcw(showModal: (opts: Loose) => Promise<{ approved: boolean; suppressPromptFor30Days?: boolean }>) {
  const tcw = new TinyCloudWeb({ persistSession: false, manifest }) as unknown as Loose;
  tcw._node = {};
  tcw.session = () => undefined;
  tcw._testHooks = {
    showModal,
    hasRuntimePermissions: () => false,
    grantPermissions: async () => {},
  };
  return tcw as unknown as {
    requestPermissions: (p: PermissionEntry[], o?: RequestPermissionsOptions) => Promise<{ approved: boolean }>;
  };
}

const forAccount: RequestPermissionsOptions = { onBehalfOf: "Account", allowPromptSuppression: false };

describe("requestPermissions on another app's behalf", () => {
  test("shows the prompt despite an earlier 30-day opt-out, naming the app and offering no opt-out", async () => {
    page.localStorage.setItem(SUPPRESSION_KEY, JSON.stringify({ expiresAt: Date.now() + 86_400_000 }));
    const shown: Loose[] = [];
    const tcw = makeTcw(async (opts) => {
      shown.push(opts);
      return { approved: true };
    });

    const result = await tcw.requestPermissions(additional, forAccount);

    expect(result.approved).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ appName: "TinyCloud One", onBehalfOf: "Account", allowSuppression: false });
  });

  test("never stores an opt-out, even if one comes back approved", async () => {
    const tcw = makeTcw(async () => ({ approved: true, suppressPromptFor30Days: true }));

    await tcw.requestPermissions(additional, forAccount);

    expect(page.localStorage.getItem(SUPPRESSION_KEY)).toBeNull();
  });
});

describe("permission prompt on another app's behalf", () => {
  test("names the app in the title and description and hides the 30-day option", async () => {
    const modal = new Modal({ appName: "TinyCloud One", additional, onBehalfOf: "Account", allowSuppression: false });
    const root = modal.shadowRoot!;

    expect(root.querySelector("#tc-permission-title")?.textContent).toBe("Account in TinyCloud One is asking for more access");
    expect(root.querySelector("#tc-permission-description")?.textContent?.trim()).toBe(
      "Review what Account will be allowed to do before you approve.",
    );
    expect(root.querySelector('[data-role="suppress-prompt"]')).toBeNull();
    expect(root.innerHTML).not.toContain("Do not show me again for 30 days");

    // handleApprove is private; how it reads the absent checkbox is the code under test.
    const approvable = modal as unknown as { handleApprove(): void };
    approvable.handleApprove();
    expect(await modal.getCompletionPromise()).toEqual({ approved: true, suppressPromptFor30Days: false });
  });

  test("escapes the named app", () => {
    const modal = new Modal({ appName: "TinyCloud One", additional, onBehalfOf: "<img src=x onerror=alert(1)>" });
    const root = modal.shadowRoot!;

    expect(root.querySelector("img[onerror]")).toBeNull();
    expect(root.querySelector("#tc-permission-title")?.textContent).toBe(
      "<img src=x onerror=alert(1)> in TinyCloud One is asking for more access",
    );
  });
});
