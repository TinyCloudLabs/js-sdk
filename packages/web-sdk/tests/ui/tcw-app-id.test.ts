import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { TinyCloudWeb as TinyCloudWebType } from "../../src/modules/tcw";
import { REGISTRY_KEY } from "../../src/ui/host";
import { FALLBACK_APP_ID, hideStorageKey } from "../../src/ui/persistence";
import { panelMounted } from "./panel-ready";

type Config = NonNullable<ConstructorParameters<typeof TinyCloudWebType>[0]>;
type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const ORIGIN = "https://app.example";
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
const CANDIDATES = ["app-manifest", "app-capability", FALLBACK_APP_ID];

let page: Window;
let TinyCloudWeb: typeof TinyCloudWebType;
const saved = new Map<string, unknown>();

beforeAll(async () => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: `${ORIGIN}/page` }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  g.location = page.location;
  g.localStorage = page.localStorage;
  g.customElements = page.customElements;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
  g.KeyboardEvent = page.KeyboardEvent;
  // Dynamic import is required: a static import is hoisted above the jsdom
  // globals, and tcw's module graph (SpaceCreationModal) extends HTMLElement
  // and calls customElements.define at evaluation time. The query suffix gives
  // a distinct module record, because other test files call mock.module on
  // "../src/modules/tcw" and those mocks persist for the whole bun test process.
  TinyCloudWeb = (await import("../../src/modules/tcw.ts?real-tcw")).TinyCloudWeb;
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

beforeEach(() => {
  delete g[REGISTRY_KEY];
  page.document.body.innerHTML = "";
  page.localStorage.clear();
  // Every candidate hide key starts set. open() clears only the key for the
  // app id the UI resolved, so the cleared key names that app id.
  for (const appId of CANDIDATES) page.localStorage.setItem(keyFor(appId), "1");
});

function keyFor(appId: string): string {
  return hideStorageKey({ origin: ORIGIN, appId });
}

function clearedBy(config: Config): string[] {
  const tc = new TinyCloudWeb({ persistSession: false, ...config });
  tc.ui.open();
  return CANDIDATES.filter((appId) => page.localStorage.getItem(keyFor(appId)) === null);
}

describe("TinyCloudWeb UI app id", () => {
  test("uses config.manifest app_id when only the manifest is set", () => {
    const manifest = { app_id: "app-manifest" } as unknown as NonNullable<Config["manifest"]>;
    expect(clearedBy({ manifest })).toEqual(["app-manifest"]);
  });

  test("uses the capabilityRequest manifest app_id when only capabilityRequest is set", () => {
    const capabilityRequest = {
      manifests: [{ app_id: "app-capability" }],
      resources: [],
    } as unknown as NonNullable<Config["capabilityRequest"]>;
    expect(clearedBy({ capabilityRequest })).toEqual(["app-capability"]);
  });

  test("falls back to _page when neither source carries an app_id", () => {
    expect(clearedBy({})).toEqual([FALLBACK_APP_ID]);
  });
});

describe("TinyCloudWeb UI app name", () => {
  const headerContext = () =>
    document.querySelector<HTMLElement>("[data-tinycloud-ui]")?.shadowRoot?.querySelector(".ctx")?.textContent;

  async function opened(config: Config): Promise<void> {
    const tc = new TinyCloudWeb({ persistSession: false, ...config });
    tc.ui.open();
    await panelMounted();
  }

  test("the header names the app by the manifest display name", async () => {
    const manifest = { app_id: "app-manifest", name: "Notes" } as unknown as NonNullable<Config["manifest"]>;
    await opened({ manifest });
    expect(headerContext()).toBe("in Notes");
  });

  test("the first manifest of a list names the app", async () => {
    const manifest = [
      { app_id: "app-manifest", name: "Notes" },
      { app_id: "other", name: "Other" },
    ] as unknown as NonNullable<Config["manifest"]>;
    await opened({ manifest });
    expect(headerContext()).toBe("in Notes");
  });

  test("the capabilityRequest manifest names the app when only it is set", async () => {
    const capabilityRequest = {
      manifests: [{ app_id: "app-capability", name: "Capability App" }],
      resources: [],
    } as unknown as NonNullable<Config["capabilityRequest"]>;
    await opened({ capabilityRequest });
    expect(headerContext()).toBe("in Capability App");
  });
});
