import { describe, expect, test } from "bun:test";
import { ServiceContext } from "./context";
import { wrapError } from "./errors";
import { verifyResourceDestination, NodeNotRespondingError } from "./resourceRouting";
import { KVService } from "./kv/KVService";
import { DataVaultService } from "./vault/DataVaultService";
import { SecretsService } from "./secrets/SecretsService";
import { EncryptionService } from "./encryption/EncryptionService";

const space = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets";
const box = { url: "http://127.0.0.1:19901", nodeDid: "did:key:box" };
const other = { url: "http://127.0.0.1:19902", nodeDid: "did:key:other" };
const token = (action: string) => ["header", btoa(JSON.stringify({ iss: "did:key:session", att: { [`${space}/kv/demo`]: { [action]: [{}] } } })), "signature"].join(".");
const ok = () => new Response("ciphertext", { status: 200 });

function context(options: { targets?: typeof box[]; failure?: string } = {}) {
  const requests: Array<{ url: string; authorization: string }> = [];
  const resolutions: Array<{ resource: string; access: string }> = [];
  const ctx = new ServiceContext({
    hosts: ["https://stale.invalid"],
    invoke: () => ({}),
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get("authorization") ?? "" });
      if (url.startsWith(options.failure ?? "never")) throw new TypeError("connection refused");
      return ok();
    },
    resourceRouting: {
      resolveResource: async (resource: string, access: string) => {
        resolutions.push({ resource, access });
        return options.targets ?? [box];
      },
      bindAudience: async (_authorization: string, nodeDid: string) => `signed-for-${nodeDid}`,
    },
  });
  return { ctx, requests, resolutions };
}
describe("signed resource routing", () => {
  test("reads ciphertext only from a listed full-space destination with its audience", async () => {
    const h = context();
    const response = await h.ctx.fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: token("tinycloud.kv/get") } });
    expect(await response.text()).toBe("ciphertext");
    expect(h.requests).toEqual([{ url: `${box.url}/invoke`, authorization: "signed-for-did:key:box" }]);
    expect(h.resolutions).toEqual([{ resource: space, access: "read" }]);
  });

  test("writes every writable destination and reports partial failure", async () => {
    const h = context({ targets: [box, other], failure: other.url });
    const result = await h.ctx.fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: token("tinycloud.kv/put") }, body: "ciphertext" }).catch((error) => error);
    expect(result).toMatchObject({ code: "PARTIAL_NODE_WRITE", succeeded: [box.url], failed: [{ url: other.url }] });
    expect(h.requests.map((request) => request.url)).toEqual([`${box.url}/invoke`, `${other.url}/invoke`]);
    expect(h.resolutions).toEqual([{ resource: space, access: "write" }]);
  });

  test("a stopped listed node stays NODE_NOT_RESPONDING through service wrapping", async () => {
    const h = context({ failure: box.url });
    const error = await h.ctx.fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: token("tinycloud.kv/get") } }).catch((error) => error);
    expect(wrapError("kv", error)).toMatchObject({ code: "NODE_NOT_RESPONDING", message: "The place where your data is at is not responsive right now. Please try again." });
    expect(h.requests.map((request) => request.url)).toEqual([`${box.url}/invoke`]);
  });

  test("an absent route refuses before any request", async () => {
    const h = context({ targets: [] });
    await expect(h.ctx.fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: token("tinycloud.kv/put") } })).rejects.toMatchObject({ code: "RESOURCE_NOT_ROUTED" });
    expect(h.requests).toEqual([]);
  });

  test("a failed data-node read remains unavailable through the public secrets API", async () => {
    const unusedCrypto = (): never => { throw new Error("Ciphertext was not read; crypto must not run"); };
    const ctx = new ServiceContext({
      hosts: [box.url],
      invoke: () => ({ Authorization: token("tinycloud.kv/get") }),
      fetch: async () => { throw new NodeNotRespondingError([box.url]); },
    });
    ctx.setSession({ spaceId: space, delegationCid: "test", delegationHeader: { Authorization: "test" }, verificationMethod: "did:key:session", jwk: {} });
    const kv = new KVService();
    kv.initialize(ctx);
    const encryption = new EncryptionService({
      crypto: { sha256: unusedCrypto, randomBytes: unusedCrypto, x25519FromSeed: unusedCrypto, x25519Dh: unusedCrypto, authEncrypt: unusedCrypto, authDecrypt: unusedCrypto, sealToNetworkKey: unusedCrypto, openWithReceiverKey: unusedCrypto, verifyNodeSignature: unusedCrypto },
      signer: { signDecryptInvocation: async () => unusedCrypto() },
      transport: { postDecrypt: async () => unusedCrypto() },
    });
    const vault = new DataVaultService({
      spaceId: space,
      crypto: { encrypt: unusedCrypto, decrypt: unusedCrypto, deriveKey: unusedCrypto, x25519FromSeed: unusedCrypto, x25519Dh: unusedCrypto, randomBytes: unusedCrypto, sha256: unusedCrypto },
      encryption: { networkId: "urn:tinycloud:encryption:did:key:test:default", service: encryption },
      tc: { kv, publicKV: kv, ensurePublicSpace: async () => unusedCrypto(), readPublicSpace: async () => unusedCrypto(), makePublicSpaceId: unusedCrypto, did: "did:key:test", address: "", chainId: 1, hosts: [box.url] },
    });
    vault.initialize(ctx);
    expect(await new SecretsService(vault).get("DEMO", { source: "network" })).toMatchObject({
      ok: false, error: { code: "NODE_NOT_RESPONDING", message: "The place where your data is at is not responsive right now. Please try again." },
    });
  });

  test("live identity surfaces must agree with the signed destination", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (request) => Response.json(new URL(request.url).pathname === "/info"
        ? { nodeId: box.nodeDid }
        : { nodeDid: other.nodeDid, shareInvitationPublicKey: "A".repeat(43) }),
    });
    try {
      await expect(verifyResourceDestination({ url: server.url.origin, nodeDid: box.nodeDid }, globalThis.fetch.bind(globalThis))).rejects.toMatchObject({ code: "NODE_IDENTITY_MISMATCH" });
    } finally { await server.stop(true); }
  });
});
