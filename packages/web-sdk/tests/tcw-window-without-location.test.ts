import "./support/browserGlobalsShim";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";

import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

// TC-2127: no test here may touch a real home.
const SANDBOX = mkdtempSync("/var/tmp/tc2127.");
const REAL_ENV = new Map<string, string | undefined>();
for (const name of ["HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
  REAL_ENV.set(name, process.env[name]);
  process.env[name] = SANDBOX;
}
if (!process.env.HOME?.startsWith("/var/tmp/tc2127.")) throw new Error("HOME is not the tc2127 sandbox");

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const hadWindow = "window" in g;
const savedWindow = g.window;
let TinyCloudWeb: typeof TinyCloudWebType;

beforeAll(async () => {
  // The query suffix gives a module record apart from files that mock "../src/modules/tcw".
  TinyCloudWeb = (await import("../src/modules/tcw.ts?window-without-location")).TinyCloudWeb;
});

afterEach(() => {
  if (hadWindow) g.window = savedWindow;
  else delete g.window;
});

afterAll(() => {
  for (const [name, value] of REAL_ENV) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("TinyCloudWeb when window has no location", () => {
  test("initializes and falls back to the non-browser SIWE domain", async () => {
    g.window = {};
    expect(typeof (g.window as { location?: unknown }).location).toBe("undefined");

    const tc = await Promise.race([
      TinyCloudWeb.create({ persistSession: false }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("init timed out")), 20_000)),
    ]);

    const node = (tc as unknown as { _node: { siweDomain: string; config: { uri?: string } } })._node;
    expect(node.siweDomain).toBe("app.tinycloud.xyz");
    expect(node.config.uri).toBeUndefined();
  }, 30_000);
});
