// OpenKey's authorize-sign builds `selectedActionKeys` / `permissions` from the
// WASM `parseRecapFromSiwe` emitter. For raw `urn:tinycloud:encryption:...`
// resources that emitter reports `space = "encryption"` and `path = <full URN>`.
// These tests drive `signInWithOpenKeyResult` with exactly that shape for a
// session that carries the default encryption network AND a `--keys` prefix row.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

const PRIVATE_KEY = "1".padStart(64, "0");

// Route /info and /delegate through a stub so sign-in activation does not reach a live node.
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function build() {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const ownerDid = `did:pkh:eip155:${chainId}:${address}`;
  const prefixUrn = `urn:tinycloud:encryption:${ownerDid}:default/qa/`;
  const auth = new NodeUserAuthorization({
    signer,
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    additionalRawAbilities: {
      [prefixUrn]: ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"],
    },
  });
  const preparation = await auth.prepareSessionForSigning();
  const signature = await signer.signMessage(preparation.prepared.siwe);
  const entries = wasm.parseRecapFromSiwe(preparation.prepared.siwe) as Array<{
    service: string;
    space: string;
    path: string;
    actions: string[];
  }>;
  const permissions = entries.map(({ service, space, path, actions }) => ({ service, space, path, actions }));
  const selectedActionKeys = entries.flatMap((e) =>
    e.actions
      .filter((a) => a !== "tinycloud.capabilities/read")
      .map((a) => `${a.slice(0, a.indexOf("/"))}\0${e.space}\0${e.path}\0${a}`),
  );
  const run = (overrides: { selectedActionKeys?: string[]; permissions?: typeof permissions } = {}) =>
    auth.signInWithOpenKeyResult(
      {
        protocolVersion: 1,
        address,
        signature,
        signedMessage: preparation.prepared.siwe,
        selectedActionKeys,
        permissions,
        ...overrides,
      },
      {
        siwe: preparation.prepared.siwe,
        jwk: preparation.prepared.jwk,
        spaceId: preparation.prepared.spaceId,
        verificationMethod: preparation.prepared.verificationMethod,
      },
      preparation.keyId,
      preparation.prepared.jwk,
    );
  return { run, entries, selectedActionKeys, permissions, ownerDid, prefixUrn, address };
}

test("accepts WASM-shaped encryption action IDs for the default network and a --keys prefix", async () => {
  const { run, selectedActionKeys, ownerDid, prefixUrn, address } = await build();
  // Both encryption resources are present in the OpenKey-shaped selection.
  expect(selectedActionKeys).toContain(
    `tinycloud.encryption\0encryption\0urn:tinycloud:encryption:${ownerDid}:default\0tinycloud.encryption/decrypt`,
  );
  expect(selectedActionKeys).toContain(
    `tinycloud.encryption\0encryption\0${prefixUrn}\0tinycloud.encryption/key.create`,
  );
  const session = await run();
  expect(session.address).toBe(address);
});

test("still rejects an encryption action ID for a resource that is not in the signed ReCap", async () => {
  const { run, selectedActionKeys, ownerDid } = await build();
  const extra = `tinycloud.encryption\0encryption\0urn:tinycloud:encryption:${ownerDid}:default/other/\0tinycloud.encryption/decrypt`;
  await expect(run({ selectedActionKeys: [...selectedActionKeys, extra] })).rejects.toThrow(
    /not covered by any granted capability/,
  );
});

test("still rejects a missing encryption action ID", async () => {
  const { run, selectedActionKeys, prefixUrn } = await build();
  const withoutPrefixDecrypt = selectedActionKeys.filter(
    (k) => !k.includes(prefixUrn) || !k.endsWith("tinycloud.encryption/decrypt"),
  );
  await expect(run({ selectedActionKeys: withoutPrefixDecrypt })).rejects.toThrow(
    /selectedActionKeys is missing entries/,
  );
});

test("rejects a WASM-shaped encryption permission for a resource that is not in the signed ReCap", async () => {
  const { run, permissions, ownerDid } = await build();
  const bogus = {
    service: "tinycloud.encryption",
    space: "encryption",
    path: `urn:tinycloud:encryption:${ownerDid}:default/other/`,
    actions: ["tinycloud.encryption/decrypt"],
  };
  await expect(run({ permissions: [...permissions, bogus] })).rejects.toThrow(
    /not confirmed in signedMessage capabilities/,
  );
});
