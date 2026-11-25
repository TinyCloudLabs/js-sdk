/*
 * TC-4294: the permission prompt's chunk (dist/modals.*) carries none of sdk-core. Its derived line (TC-4222) takes
 * sdk-core's permission expansion from the root bundle and two constants as copies, so the chunk stays near its
 * pre-TC-4222 size of 45 KB instead of 939 KB. The size and chunk-loader checks run against the BUILT dist (build
 * web-sdk first).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

import type { PermissionEntry } from "@tinycloud/sdk-core";
import { EXPIRY, SERVICE_SHORT_TO_LONG } from "@tinycloud/sdk-core";

import { derivePermissionLine, grantLifetimeMs } from "../src/notifications/permissionLine";

const dist = resolve(import.meta.dir, "../dist");
/** Bytes per built prompt chunk: 45 KB before TC-4222, 0.9 MB with all of sdk-core. */
const MODALS_CEILING = 64 * 1024;

function built(file: string): string {
  const path = join(dist, file);
  if (!existsSync(path)) throw new Error(`${path} is missing: build web-sdk before running this test.`);
  return path;
}

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const secretKey: PermissionEntry = {
  service: "tinycloud.encryption",
  path: `urn:tinycloud:encryption:${OWNER}:default/secrets/scoped/tinychat-bot-history/bot-history`,
  actions: ["decrypt"],
};

describe("the built prompt chunk", () => {
  for (const file of ["modals.mjs", "modals.cjs"]) {
    test(`${file} is at most ${MODALS_CEILING} bytes`, () => {
      expect(statSync(built(file)).size).toBeLessThanOrEqual(MODALS_CEILING);
    });
  }

  describe("states a secret key's 1-hour lifetime, expanded by the root bundle", () => {
    type Loose = Record<PropertyKey, unknown>;
    const g = globalThis as unknown as Loose;
    const names = ["window", "document", "location", "localStorage", "customElements", "HTMLElement", "Element", "Event", "KeyboardEvent"];
    const saved = new Map<string, unknown>();

    beforeAll(() => {
      for (const name of names) saved.set(name, g[name]);
    });

    afterAll(() => {
      for (const name of names) {
        if (saved.get(name) === undefined) delete g[name];
        else g[name] = saved.get(name);
      }
    });

    /** Loads a built chunk into a fresh page and renders the prompt for one secret key. */
    async function derivedLines(load: () => Promise<unknown>): Promise<(string | null)[]> {
      const page = new JSDOM("", { url: "https://tinychat.example/" }).window as unknown as Loose;
      for (const name of names) g[name] = name === "window" ? page : page[name];
      await load();
      const Modal = (g.customElements as CustomElementRegistry).get("tinycloud-permission-request-modal") as unknown as
        new (options: Loose) => HTMLElement;
      const root = new Modal({ appName: "TinyChat", additional: [secretKey] }).shadowRoot!;
      return [...root.querySelectorAll('[data-role="permission-line"]')].map((line) => line.textContent);
    }

    const LINE = "Decrypt with the key secrets/scoped/tinychat-bot-history/bot-history (only this key), for up to 1 hour.";

    // Loaded at test time, not imported: the chunk defines its elements on evaluation, so the page must exist first.
    test("as ESM", async () => {
      expect(await derivedLines(() => import(pathToFileURL(built("modals.mjs")).href))).toEqual([LINE]);
    });

    test("as CommonJS", async () => {
      const require = createRequire(import.meta.url);
      expect(await derivedLines(async () => require(built("modals.cjs")))).toEqual([LINE]);
    });
  });
});

// A webpack chunk loader in a built file means its import() calls name chunks by a computed path, which a downstream
// bundler (CRA in apps/openkey-example) turns into a context over dist/ and fails on the .d.ts files there (TC-4222).
// The markers are those of the loader webpack emitted when the prompt carried sdk-core: the minified `.e` that waits on
// every `.f` handler, the ESM `import("./"+x.u(id))`, CommonJS's ChunkLoadError, and the unminified name.
const CHUNK_LOADER = /\.e=\w+=>Promise\.all\(Object\.keys\(\w+\.f\)|import\("\.\/"\+\w+\.u\(|ChunkLoadError|__webpack_require__\.e\s*=/;

describe("the built files load no webpack chunks", () => {
  test("no built file carries a chunk loader", () => {
    const files = readdirSync(dist).filter((file) => /\.(mjs|cjs)$/.test(file));
    expect(files).toContain(basename(built("modals.mjs")));
    expect(files.filter((file) => CHUNK_LOADER.test(readFileSync(join(dist, file), "utf8")))).toEqual([]);
  });

  test("there are no numbered chunk files", () => {
    expect(readdirSync(dist).filter((file) => /^\d+\.(m?js|cjs)$/.test(file))).toEqual([]);
  });
});

describe("the prompt's copies of sdk-core constants", () => {
  test("an unasked lifetime is sdk-core's session lifetime", () => {
    const kv: PermissionEntry = { service: "tinycloud.kv", path: "notes/", actions: ["get"] };
    expect(grantLifetimeMs([kv], undefined)).toBe(EXPIRY.SESSION_MS);
  });

  // The copy is private to permissionLine.ts, so it is compared through what it decides: an action written as
  // `<long service>/<action>` loses that prefix only when the short name maps to exactly that long name.
  test("every short service name sdk-core knows maps to sdk-core's long name", () => {
    for (const [short, long] of Object.entries(SERVICE_SHORT_TO_LONG)) {
      const path = long === "tinycloud.encryption" ? `urn:tinycloud:encryption:${OWNER}:default/notes/a` : "notes/a";
      const entry: PermissionEntry = { service: long, path, actions: [`${long}/probe`] };
      const line = derivePermissionLine({ ...entry, service: short }, 60_000);
      expect({ short, line }).toEqual({ short, line: derivePermissionLine(entry, 60_000) });
      expect(line).toStartWith("Use “probe” on ");
    }
  });
});
