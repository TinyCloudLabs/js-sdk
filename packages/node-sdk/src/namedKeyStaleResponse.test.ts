import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const built = await Bun.build({
  entrypoints: [resolve(root, "packages/sdk-services/src/encryption/namedKeys.ts")],
  target: "bun", write: false,
  plugins: [{
    name: "named-key-response-source-only",
    setup(build) {
      build.onResolve({ filter: /^@tinycloud\/bootstrap$/ }, () => ({ path: "bootstrap", namespace: "response-stub" }));
      build.onResolve({ filter: /^\.\/keyWrap$/ }, () => ({ path: "keyWrap", namespace: "response-stub" }));
      build.onLoad({ filter: /.*/, namespace: "response-stub" }, ({ path }) => ({
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
const { NamedKeyClient } = await import(URL.createObjectURL(built.outputs[0]));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("stale graph discards the returned fetch response before rejecting", async () => {
  const entered = deferred<void>();
  const response = deferred<Response>();
  let authority = "a";
  let cancelled = 0;
  const signatures: string[] = [];
  const sends: string[] = [];
  const client = new NamedKeyClient({
    host: "https://node.invalid",
    crypto: {},
    defaultNetworkId: () => "urn:tinycloud:encryption:did:key:alice:default",
    assertActive() { if (authority !== "a") throw new Error("retired graph"); },
    signInvocation: async () => {
      signatures.push(authority);
      return { authorization: authority, invocationCid: "cid" };
    },
    fetch: async (url: string) => {
      if (url.endsWith("/info")) {
        return Response.json({ nodeId: "did:key:node", features: ["encryption-named-keys-v1"] });
      }
      sends.push(authority);
      entered.resolve();
      return response.promise;
    },
  });
  const pending = client.describeKey("documents");
  await entered.promise;
  authority = "b";
  response.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await expect(pending).rejects.toThrow("retired graph");
  expect(cancelled).toBe(1);
  expect(signatures).toEqual(["a"]);
  expect(sends).toEqual(["a"]);
});
