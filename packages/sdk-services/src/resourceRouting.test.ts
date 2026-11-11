import { describe, expect, test } from "bun:test";
import { ServiceContext } from "./context";
import { wrapError } from "./errors";
import { createResourceRoutingFetch, verifyResourceDestination, NodeNotRespondingError } from "./resourceRouting";
import { KVService } from "./kv/KVService";
import { DataVaultService } from "./vault/DataVaultService";
import { SecretsService } from "./secrets/SecretsService";
import { EncryptionService } from "./encryption/EncryptionService";

const space = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets";
const box = { url: "http://127.0.0.1:19901", nodeDid: "did:key:box" };
const other = { url: "http://127.0.0.1:19902", nodeDid: "did:key:other" };
const token = (action: string) => ["header", btoa(JSON.stringify({ iss: "did:key:session", att: { [`${space}/kv/demo`]: { [action]: [{}] } } })), "signature"].join(".");
const ok = () => new Response("ciphertext", { status: 200 });

function context(options: {
  targets?: typeof box[];
  failure?: string;
  notFound?: string;
  signingFailure?: string;
  afterWrite?: () => void;
} = {}) {
  const requests: Array<{ url: string; authorization: string }> = [];
  const signingError = options.signingFailure ? new Error("Fixture signing key unavailable") : undefined;
  const ctx = new ServiceContext({
    hosts: ["https://stale.invalid"],
    invoke: () => ({}),
    fetch: createResourceRoutingFetch(async (url, init) => {
      if (url.startsWith(options.failure ?? "never")) throw new TypeError("connection refused");
      const target = (options.targets ?? [box]).find((candidate) => url.startsWith(`${candidate.url}/`));
      if (url.endsWith("/info")) return Response.json({ nodeId: target?.nodeDid });
      if (url.endsWith("/.well-known/tinycloud/node-keys")) return Response.json({ nodeDid: target?.nodeDid, shareInvitationPublicKey: "A".repeat(43) });
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get("authorization") ?? "" });
      if (!target || headers.get("authorization") !== `signed-for-${target.nodeDid}`) {
        return new Response("audience refused", { status: 401 });
      }
      if (url.startsWith(options.notFound ?? "never")) return new Response("", { status: 404 });
      options.afterWrite?.();
      return ok();
    }, {
      resolveResource: async (resource: string, access: string) => {
        if (resource !== space || (access !== "read" && access !== "write")) return [];
        return options.targets ?? [box];
      },
      bindAudience: async (_authorization: string, nodeDid: string) => {
        if (nodeDid === options.signingFailure) throw signingError;
        return `signed-for-${nodeDid}`;
      },
    }),
  });
  return { ctx, requests, signingError };
}
describe("signed resource routing", () => {
  test("reads ciphertext only from a listed full-space destination with its audience", async () => {
    const h = context();
    const response = await h.ctx.fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: token("tinycloud.kv/get") } });
    expect(await response.text()).toBe("ciphertext");
  });

  test("writes every writable destination and reports partial failure", async () => {
    const h = context({ targets: [box, other], failure: other.url });
    const result = await h.ctx.fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: token("tinycloud.kv/put") }, body: "ciphertext" }).catch((error) => error);
    expect(result).toMatchObject({ code: "PARTIAL_NODE_WRITE", succeeded: [box.url], failed: [{ url: other.url }] });
  });

  test.each(["abort", "sign"] as const)("preserves accepted write effects after a later %s failure", async (kind) => {
    const controller = new AbortController();
    const reason = new DOMException("Fixture cancellation", "AbortError");
    const h = context({
      targets: [box, other],
      ...(kind === "abort" ? { afterWrite: () => controller.abort(reason) } : { signingFailure: other.nodeDid }),
    });
    const failure = await h.ctx.fetch("https://stale.invalid/invoke", {
      method: "POST", headers: { Authorization: token("tinycloud.kv/put") }, body: "ciphertext",
      signal: controller.signal,
    }).catch((error) => error);
    expect(failure).toMatchObject({
      code: "PARTIAL_NODE_WRITE", succeeded: [box.url],
      failed: [{ url: other.url, cause: kind === "abort" ? reason : h.signingError }],
    });
  });

  test.each(["abort", "sign"] as const)("retains ordinary %s semantics before any write is accepted", async (kind) => {
    const controller = new AbortController();
    const reason = new DOMException("Fixture cancellation", "AbortError");
    const h = context({ targets: [box, other], ...(kind === "sign" ? { signingFailure: box.nodeDid } : {}) });
    if (kind === "abort") controller.abort(reason);
    await expect(h.ctx.fetch("https://stale.invalid/invoke", {
      method: "POST", headers: { Authorization: token("tinycloud.kv/put") }, body: "ciphertext",
      signal: controller.signal,
    })).rejects.toBe(kind === "abort" ? reason : h.signingError);
  });

  test.each([false, true])("unavailability outranks replica not-found without a successful read (unavailable first: %s)", async (unavailableFirst) => {
    const h = context({ targets: unavailableFirst ? [other, box] : [box, other], notFound: box.url, failure: other.url });
    await expect(h.ctx.fetch("https://stale.invalid/invoke", {
      method: "POST", headers: { Authorization: token("tinycloud.kv/get") },
    })).rejects.toMatchObject({ code: "NODE_NOT_RESPONDING" });
  });

  test("a stopped listed node stays NODE_NOT_RESPONDING through service wrapping", async () => {
    const h = context({ failure: box.url });
    const error = await h.ctx.fetch("https://stale.invalid/invoke", { method: "POST", headers: { Authorization: token("tinycloud.kv/get") } }).catch((error) => error);
    expect(wrapError("kv", error)).toMatchObject({ code: "NODE_NOT_RESPONDING" });
    expect(h.requests).toEqual([]);
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
      ok: false, error: { code: "NODE_NOT_RESPONDING" },
    });
  });

  test.each(["get", "put", "delete", "list"] as const)(
    "preserves settings unavailability through the public secrets %s API",
    async (action) => {
      const failure = Object.assign(new Error("Private registry detail must remain typed"), {
        code: "registry_unavailable",
        meta: { reason: "no-saved-settings" },
      });
      const unusedCrypto = (): never => { throw new Error("Registry refusal must precede crypto and data transport"); };
      let routeChecks = 0;
      let dataRequests = 0;
      const refuseRoute = async () => { routeChecks++; throw failure; };
      const ctx = new ServiceContext({
        hosts: [box.url],
        invoke: () => ({ Authorization: token(`tinycloud.kv/${action === "delete" ? "del" : action}`) }),
        fetch: createResourceRoutingFetch(async () => {
          dataRequests++;
          throw new Error("Unavailable settings must not reach a data server");
        }, {
          resolveResource: refuseRoute,
          bindAudience: async (authorization) => authorization,
        }),
      });
      ctx.setSession({ spaceId: space, delegationCid: "test", delegationHeader: { Authorization: "test" }, verificationMethod: "did:key:session", jwk: {} });
      const kv = new KVService();
      kv.initialize(ctx);
      const encryption = new EncryptionService({
        crypto: { sha256: unusedCrypto, randomBytes: unusedCrypto, x25519FromSeed: unusedCrypto, x25519Dh: unusedCrypto, authEncrypt: unusedCrypto, authDecrypt: unusedCrypto, sealToNetworkKey: unusedCrypto, openWithReceiverKey: unusedCrypto, verifyNodeSignature: unusedCrypto },
        signer: { signDecryptInvocation: async () => unusedCrypto() },
        transport: { postDecrypt: async () => unusedCrypto() },
        node: { fetchByNetworkId: refuseRoute },
      });
      const vault = new DataVaultService({
        spaceId: space,
        crypto: { encrypt: unusedCrypto, decrypt: unusedCrypto, deriveKey: unusedCrypto, x25519FromSeed: unusedCrypto, x25519Dh: unusedCrypto, randomBytes: unusedCrypto, sha256: unusedCrypto },
        encryption: { networkId: "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000001:default", service: encryption },
        tc: { kv, publicKV: kv, ensurePublicSpace: async () => unusedCrypto(), readPublicSpace: async () => unusedCrypto(), makePublicSpaceId: unusedCrypto, did: "did:key:test", address: "", chainId: 1, hosts: [box.url] },
      });
      vault.initialize(ctx);
      const secrets = new SecretsService(vault);
      const result = action === "get" ? await secrets.get("DEMO", { source: "network" })
        : action === "put" ? await secrets.put("DEMO", "TEST-ONLY-NOT-A-REAL-SECRET")
        : action === "delete" ? await secrets.delete("DEMO")
        : await secrets.list({ source: "network" });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "registry_unavailable", meta: { reason: "no-saved-settings" } },
      });
      expect(routeChecks).toBe(1);
      expect(dataRequests).toBe(0);
    },
  );

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

  test("the public context rejects a wrong DID before sending authorization or ciphertext without an override", async () => {
    let invocations = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/invoke") { invocations++; return ok(); }
        return Response.json(path === "/info"
          ? { nodeId: other.nodeDid }
          : { nodeDid: other.nodeDid, shareInvitationPublicKey: "A".repeat(43) });
      },
    });
    try {
      const ctx = new ServiceContext({
        hosts: [server.url.origin],
        invoke: () => ({}),
        fetch: createResourceRoutingFetch(globalThis.fetch.bind(globalThis), {
          resolveResource: async () => [{ url: server.url.origin, nodeDid: box.nodeDid }],
          bindAudience: async (authorization) => authorization,
        }),
      });
      await expect(ctx.fetch(`${server.url.origin}/invoke`, {
        method: "POST", headers: { Authorization: token("tinycloud.kv/put") }, body: "dummy ciphertext",
      })).rejects.toMatchObject({ code: "NODE_IDENTITY_MISMATCH" });
      expect(invocations).toBe(0);
    } finally { await server.stop(true); }
  });
});
