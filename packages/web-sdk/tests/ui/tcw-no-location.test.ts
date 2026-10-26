import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { JSDOM } from "jsdom";

import type { TinyCloudWeb as TinyCloudWebType } from "../../src/modules/tcw";
import { REGISTRY_KEY } from "../../src/ui/host";

// TC-2072: no test here may touch a real home.
const SANDBOX = mkdtempSync("/var/tmp/tc2072.");
const REAL_ENV = new Map<string, string | undefined>();
for (const name of ["HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
  REAL_ENV.set(name, process.env[name]);
  process.env[name] = SANDBOX;
}
if (!process.env.HOME?.startsWith("/var/tmp/tc2072.")) throw new Error("HOME is not the tc2072 sandbox");

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "location", "localStorage", "customElements", "HTMLElement", "Element", "Event", "KeyboardEvent"];
const saved = new Map<string, unknown>();
let TinyCloudWeb: typeof TinyCloudWebType;

beforeAll(async () => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  const page = new JSDOM("", { url: "https://app.example/page" }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  g.localStorage = page.localStorage;
  g.customElements = page.customElements;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
  g.KeyboardEvent = page.KeyboardEvent;
  // A window and document exist but the global scope has no `location`.
  delete g.location;
  // The query suffix gives a module record apart from files that mock "../src/modules/tcw".
  TinyCloudWeb = (await import("../../src/modules/tcw.ts?no-location")).TinyCloudWeb;
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
  delete g[REGISTRY_KEY];
  for (const [name, value] of REAL_ENV) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("TinyCloudWeb without a location", () => {
  test("constructs without throwing and keeps its core API", () => {
    expect(typeof globalThis.location).toBe("undefined");
    delete g[REGISTRY_KEY];

    const tc = new TinyCloudWeb({ persistSession: false });

    expect(typeof tc.signIn).toBe("function");
    expect(typeof tc.signOut).toBe("function");
    expect(typeof tc.ui.open).toBe("function");
    expect(tc.ui.isOpen).toBe(false);
    expect(g[REGISTRY_KEY]).toBeUndefined();
  });
});
