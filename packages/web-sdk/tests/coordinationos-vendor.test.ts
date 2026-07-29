import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createCoordinationOsVendorManifest } from "../scripts/build-coordinationos-vendor";

test("creates deterministic CoordinationOS vendor metadata for fixed bytes", () => {
  const manifest = createCoordinationOsVendorManifest(
    new TextEncoder().encode("coordinationos-vendor-fixture"),
    { name: "@tinycloud/web-sdk", version: "2.10.0-beta.0" },
  );

  expect(`${JSON.stringify(manifest, null, 2)}\n`).toBe(`{
  "schemaVersion": 1,
  "package": "@tinycloud/web-sdk",
  "version": "2.10.0-beta.0",
  "format": "esm",
  "entry": "tinycloud-web-sdk-2.10.0-beta.0.mjs",
  "sha384": "sha384-zTsa9taxYVJimor3dNdKXbUbVXyzk5gN5aFhdcYYE0abTiwwWLqp7M8ZN34IUiAk",
  "exports": [
    "TinyCloudWeb",
    "createOpenKeyCallbackSigningStrategy",
    "establishOpenKeySession"
  ]
}
`);
});

test("rejects package metadata outside the pinned contract version", () => {
  expect(() =>
    createCoordinationOsVendorManifest(new Uint8Array(), {
      name: "@tinycloud/web-sdk",
      version: "2.10.1",
    }),
  ).toThrow("does not match the contract");
});

test("the generated manifest and ESM namespace expose exactly the contract", async () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const vendorRoot = resolve(packageRoot, "dist/vendor");
  const manifest = JSON.parse(
    await readFile(
      resolve(
        vendorRoot,
        "tinycloud-web-sdk-2.10.0-beta.0.vendor.json",
      ),
      "utf8",
    ),
  );

  const { TextEncoder: TE, TextDecoder: TD } = require("util");
  globalThis.TextEncoder = TE;
  globalThis.TextDecoder = TD;
  (globalThis as any).HTMLElement = class {
    shadowRoot: any;
    attachShadow() {
      this.shadowRoot = { innerHTML: "", querySelector: () => null };
      return this.shadowRoot;
    }
    remove() {}
  };
  (globalThis as any).customElements = {
    define: () => undefined,
    get: () => undefined,
  };
  (globalThis as any).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    location: { hostname: "test.local" },
  };
  (globalThis as any).document = {
    createElement: () => ({
      setAttribute: () => undefined,
      appendChild: () => undefined,
      remove: () => undefined,
      style: {},
    }),
    body: { appendChild: () => undefined, style: {} },
  };

  mock.module("@tinycloud/web-sdk-wasm", () => ({
    initialized: Promise.resolve(),
    tinycloud: {
      computeCid: () => "bafk-test",
      ensureEip55: (address: string) => address,
      makeSpaceId: (address: string, chainId: number, prefix: string) =>
        `tinycloud:pkh:eip155:${chainId}:${address}:${prefix}`,
      createDelegation: () => ({}),
      parseRecapFromSiwe: () => [],
      generateHostSIWEMessage: () => "",
      siweToDelegationHeaders: () => ({}),
      protocolVersion: () => 1,
      vault_encrypt: () => new Uint8Array(),
      vault_decrypt: () => new Uint8Array(),
      vault_derive_key: () => new Uint8Array(),
      vault_x25519_from_seed: () => new Uint8Array(),
      vault_x25519_dh: () => new Uint8Array(),
      vault_random_bytes: (length: number) => new Uint8Array(length),
      vault_sha256: () => new Uint8Array(),
    },
    tcwSession: {
      TCWSessionManager: class {
        createSessionKey(id: string) { return id; }
        replaceSessionKey(_jwk: object, keyId: string) { return keyId; }
        listSessionKeys() { return ["default"]; }
        renameSessionKeyId() {}
        getDID(keyId: string) { return `did:key:${keyId}`; }
        jwk() {
          return JSON.stringify({
            kty: "OKP",
            crv: "Ed25519",
            x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          });
        }
      },
    },
  }));

  const namespace = await import(
    `${resolve(vendorRoot, manifest.entry)}?contract-runtime`
  );
  const expected = [
    "TinyCloudWeb",
    "createOpenKeyCallbackSigningStrategy",
    "establishOpenKeySession",
  ];

  expect(manifest.format).toBe("esm");
  expect(manifest.version).toBe("2.10.0-beta.0");
  expect(manifest.exports).toEqual(expected);
  expect(Object.keys(namespace).sort()).toEqual([...expected].sort());
});
