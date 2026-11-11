import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const built = await Bun.build({
  entrypoints: [resolve(root, "packages/node-sdk/src/encryption-keys.ts")],
  target: "bun", write: false,
  plugins: [{
    name: "named-key-public-get-source-only",
    setup(build) {
      build.onResolve({ filter: /^@tinycloud\/sdk-services\/encryption\/named-keys$/ }, () => ({
        path: resolve(root, "packages/sdk-services/src/encryption/namedKeys.ts"),
      }));
      build.onResolve({ filter: /^@tinycloud\/bootstrap$/ }, () => ({ path: "bootstrap", namespace: "public-get-stub" }));
      build.onResolve({ filter: /^\.\/keyWrap$/ }, () => ({ path: "keyWrap", namespace: "public-get-stub" }));
      build.onLoad({ filter: /.*/, namespace: "public-get-stub" }, ({ path }) => ({
        contents: path === "bootstrap"
          ? 'export function pkhDid() { throw new Error("unexpected checksum"); }'
          : `export const KEY_WRAP_V2_ALG = "x25519-hkdf-aes256gcm/v2";
             export function sealKeyV2() { throw new Error("unexpected crypto"); }
             export const openKeyV2 = sealKeyV2, readKeyWrapV2 = sealKeyV2;
             export const assertKeyWrapAlgorithm = sealKeyV2, assertKeyWrapContext = sealKeyV2;`,
        loader: "js",
      }));
    },
  }],
});
if (!built.success) throw new AggregateError(built.logs, "source bundle failed");
const { createNamedKeyClient } = await import(URL.createObjectURL(built.outputs[0]));
const networkId = "urn:tinycloud:encryption:did:key:alice:explicit";
const descriptor = {
  networkId, keyPath: "documents", alg: "test", keyVersion: 1, publicEncryptionKey: "AQ==",
};

function unsignedNode() {
  return {
    hosts: ["https://node.invalid"],
    _serviceGraph: { assertActive() {} },
    _serviceContext: { session: null },
    session: undefined,
    getDefaultEncryptionNetworkId() { throw new Error("public GET must not resolve a default"); },
    get encryption(): any { throw new Error("public GET must not initialize encryption"); },
    createEncryptionCrypto: () => ({}),
    signRawNetworkAuthorization() { throw new Error("public GET must not sign"); },
  };
}

for (const configuredDefault of [false, true]) {
  test(`unsigned explicit-network public GET avoids default and encryption getters (client default=${configuredDefault})`, async () => {
    const seen: string[] = [];
    const client = createNamedKeyClient(unsignedNode() as any, {
      ...(configuredDefault ? { networkId } : {}),
      fetch: (async (url: string, init: RequestInit) => {
        seen.push(url);
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return Response.json(url.endsWith("/info")
          ? { nodeId: "did:key:node", features: ["encryption-named-keys-v1"] }
          : descriptor);
      }) as typeof fetch,
    });
    expect(await client.getPublicKey("documents", configuredDefault ? undefined : { networkId })).toEqual(descriptor);
    expect(seen).toEqual([
      "https://node.invalid/info", `https://node.invalid/encryption/networks/${networkId}/keys/documents`,
    ]);
  });
}

test("keys proxy preserves unsigned explicit-network public GET", async () => {
  const source = await Bun.file(resolve(root, "packages/node-sdk/src/TinyCloudNode.ts")).text();
  const getter = source.slice(source.indexOf("  get keys(): NamedKeyClient {"), source.indexOf("  /** Manifest key paths"));
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`class Harness { ${getter} }; return Harness;`);
  const Harness = new Function(js)();
  const node = Object.defineProperties(new Harness(), Object.getOwnPropertyDescriptors(unsignedNode()));
  const client = createNamedKeyClient(node, {
    fetch: (async (url: string, init: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json(url.endsWith("/info")
        ? { nodeId: "did:key:node", features: ["encryption-named-keys-v1"] }
        : descriptor);
    }) as typeof fetch,
  });
  node._namedKeyClient = Promise.resolve(client);
  expect(await node.keys.getPublicKey("documents", { networkId })).toEqual(descriptor);
});

test("root batch uses captured service session proofs without consulting a default network", async () => {
  const node: any = unsignedNode();
  node._serviceContext.session = { delegationCid: "active-service-session" };
  node.session = { delegationCid: "older-auth-session" };
  let serviceReads = 0;
  const proofs: string[][] = [];
  Object.defineProperty(node, "encryption", { get() {
    serviceReads++;
    return { decryptEnvelope: async (_envelope: unknown, options: { proofs: string[] }) => {
      proofs.push(options.proofs);
      return { ok: true, data: new Uint8Array([1]) };
    } };
  } });
  const client = createNamedKeyClient(node);
  const results = await client.decryptMany([{ v: 1 }, { v: 1 }]);
  expect(results.map((result: any) => result.ok)).toEqual([true, true]);
  expect(serviceReads).toBe(1);
  expect(proofs).toEqual([["active-service-session"], ["active-service-session"]]);
});
