import { expect, test } from "bun:test";
import { resolve } from "node:path";

// Bundle only the two named-key sources. Crypto and address-checksum code is
// outside these authority tests; fail loudly if a tested path reaches either.
const root = resolve(import.meta.dir, "../../..");
const built = await Bun.build({
  entrypoints: [resolve(root, "packages/node-sdk/src/encryption-keys.ts")],
  target: "bun",
  write: false,
  plugins: [{
    name: "named-key-source-only",
    setup(build) {
      build.onResolve({ filter: /^@tinycloud\/sdk-services\/encryption\/named-keys$/ }, () => ({
        path: resolve(root, "packages/sdk-services/src/encryption/namedKeys.ts"),
      }));
      build.onResolve({ filter: /^@tinycloud\/bootstrap$/ }, () => ({ path: "bootstrap", namespace: "authority-stub" }));
      build.onResolve({ filter: /^\.\/keyWrap$/ }, () => ({ path: "keyWrap", namespace: "authority-stub" }));
      build.onLoad({ filter: /.*/, namespace: "authority-stub" }, ({ path }) => ({
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
const { createNamedKeyClient, NamedKeyClient } = await import(URL.createObjectURL(built.outputs[0]));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const network = (name: string) => `urn:tinycloud:encryption:did:key:alice:${name}`;
const descriptor = (networkId = network("a")) => ({
  networkId, keyPath: "documents", alg: "test", keyVersion: 1,
  publicEncryptionKey: "AQ==", state: "active", kind: "deterministic",
});
const info = () => Response.json({ nodeId: "did:key:node", features: ["encryption-named-keys-v1"] });

function fixture(fetch: typeof globalThis.fetch) {
  const signatures: string[] = [];
  const decryptions: string[] = [];
  let current = "a";
  function graph() {
    const owner = current;
    return { assertActive() { if (owner !== current) throw new Error("retired graph"); } };
  }
  const node: any = {
    hosts: ["https://node.invalid"], _serviceGraph: graph(),
    _serviceContext: { session: { delegationCid: "a" } },
    get session() { return this._serviceContext.session; },
    getDefaultEncryptionNetworkId: () => network(current),
    createEncryptionCrypto: () => ({ sha256: () => new Uint8Array(32) }),
    signRawNetworkAuthorization: async (_input: unknown, binding: any) => {
      binding?.graph.assertActive();
      const session = binding?.session ?? node._serviceContext.session;
      signatures.push(session.delegationCid);
      return { authorization: session.delegationCid, invocationCid: "cid" };
    },
    encryption: { decryptEnvelope: async () => {
      decryptions.push(current);
      return { ok: true, data: new Uint8Array([1]) };
    } },
  };
  return {
    node, signatures, decryptions,
    client: createNamedKeyClient(node, { fetch }),
    switch() {
      current = "b";
      node._serviceGraph = graph();
      node._serviceContext = { session: { delegationCid: "b" } };
      node.encryption = { decryptEnvelope: async () => {
        decryptions.push("b"); return { ok: true, data: new Uint8Array([2]) };
      } };
    },
  };
}

test("lazy keys proxy rejects A after the cached client loads under B", async () => {
  const source = await Bun.file(resolve(root, "packages/node-sdk/src/TinyCloudNode.ts")).text();
  const getter = source.slice(source.indexOf("  get keys(): NamedKeyClient {"), source.indexOf("  /** Manifest key paths"));
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`class Harness { ${getter} }; return Harness;`);
  const Harness = new Function(js)();
  const pending = deferred<any>();
  const called: string[] = [];
  const f = fixture((async () => info()) as typeof fetch);
  const node = Object.assign(new Harness(), f.node, { _namedKeyClient: pending.promise });
  const old = node.keys.describeKey("documents");
  f.switch();
  Object.assign(node, f.node);
  pending.resolve({ describeKey() { called.push("b"); return descriptor(network("b")); } });
  await expect(old).rejects.toThrow("retired graph");
  expect(called).toEqual([]);
  await node.keys.describeKey("documents");
  expect(called).toEqual(["b"]);
});

test("requireNode pause cannot sign or send with replacement B; new B calls work", async () => {
  const gate = deferred<Response>();
  const entered = deferred<void>();
  const sent: string[] = [];
  const f = fixture((async (url: string, init: RequestInit) => {
    if (url.endsWith("/info")) { entered.resolve(); return gate.promise; }
    sent.push(String(new Headers(init?.headers).get("authorization")));
    return Response.json(descriptor(network("b")));
  }) as typeof fetch);
  const old = f.client.describeKey("documents");
  await entered.promise;
  f.switch(); gate.resolve(info());
  await expect(old).rejects.toThrow("retired graph");
  expect(f.signatures).toEqual([]); expect(sent).toEqual([]);
  await f.client.describeKey("documents");
  expect(f.signatures).toEqual(["b"]); expect(sent).toEqual(["b"]);
});

test("switch while signer yields blocks the authenticated fetch", async () => {
  const gate = deferred<any>();
  const entered = deferred<void>();
  const sent: string[] = [];
  const f = fixture((async (url: string) => {
    if (url.endsWith("/info")) return info();
    sent.push(url); return Response.json(descriptor());
  }) as typeof fetch);
  f.node.signRawNetworkAuthorization = () => { entered.resolve(); return gate.promise; };
  const old = f.client.blockKey("documents");
  await entered.promise; f.switch();
  gate.resolve({ authorization: "a", invocationCid: "cid" });
  await expect(old).rejects.toThrow("retired graph");
  expect(sent).toEqual([]);
});

test("ensureKey freezes default network and options through create and conflict reread", async () => {
  let current = network("a");
  let reads = 0;
  const resources: string[] = [];
  const options: any = {};
  const client = new NamedKeyClient({
    host: "https://node.invalid", crypto: { sha256: () => new Uint8Array(32) },
    defaultNetworkId: () => current,
    signInvocation: async (input: any) => {
      resources.push(input.resource);
      return { authorization: "a", invocationCid: "cid" };
    },
    fetch: async (url: string, init: RequestInit) => {
      if (url.endsWith("/info")) return info();
      current = network("b"); options.networkId = current;
      if (init.method === "POST") return new Response("key_exists: raced", { status: 409 });
      if (++reads === 1) return new Response("key_not_found: absent", { status: 404 });
      return Response.json(descriptor());
    },
  });
  expect((await client.ensureKey("documents", options)).networkId).toBe(network("a"));
  expect(resources).toEqual(Array(3).fill(`${network("a")}/documents`));
});

test("decryptMany never rebinds remaining root envelopes to B", async () => {
  const gate = deferred<any>();
  const entered = deferred<void>();
  const f = fixture((async () => info()) as typeof fetch);
  f.node.encryption.decryptEnvelope = () => {
    f.decryptions.push("a"); entered.resolve(); return gate.promise;
  };
  const old = f.client.decryptMany([{ v: 1 }, { v: 1 }]);
  await entered.promise; f.switch();
  gate.resolve({ ok: true, data: new Uint8Array([1]) });
  const results = await old;
  expect(results.map((r: any) => r.ok)).toEqual([false, false]);
  expect(f.decryptions).toEqual(["a"]);
  await f.client.decrypt({ v: 1 });
  expect(f.decryptions).toEqual(["a", "b"]);
});

test("public GET remains unsigned", async () => {
  const f = fixture((async (url: string, init: RequestInit) => {
    if (url.endsWith("/info")) return info();
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    return Response.json(descriptor());
  }) as typeof fetch);
  await f.client.getPublicKey("documents");
  expect(f.signatures).toEqual([]);
});


test("ensureKey started in A cannot create under B after a missing descriptor", async () => {
  const body = deferred<string>();
  const entered = deferred<void>();
  const sent: string[] = [];
  const f = fixture((async (url: string) => {
    if (url.endsWith("/info")) return info();
    sent.push(url);
    return { ok: false, status: 404, text: () => { entered.resolve(); return body.promise; } };
  }) as typeof fetch);
  const old = f.client.ensureKey("documents");
  await entered.promise; f.switch(); body.resolve("key_not_found: absent");
  await expect(old).rejects.toThrow("retired graph");
  expect(f.signatures).toEqual(["a"]);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain(network("a"));
});
