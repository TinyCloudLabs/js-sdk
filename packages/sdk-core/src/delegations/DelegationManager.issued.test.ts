import { describe, expect, mock, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import type { ServiceSession } from "@tinycloud/sdk-services";
import { DelegationManager } from "./DelegationManager";
import type { SessionInvocationSigner } from "./types";
import { signCompactUcanAuthorization } from "../policy/unified";

const HOST = "https://node.example";
const NODE_DID = "did:key:z6MkNodeAudienceFixtureOnly";

/** A real Ed25519 session key and the proofless signer the node-sdk builds from it. */
function sessionKey() {
  const secret = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(secret);
  const did = `did:key:${base58btc.encode(new Uint8Array([0xed, 0x01, ...publicKey]))}`;
  const signer: SessionInvocationSigner = {
    did: () => did,
    sign: async (attenuation) => {
      const now = Math.floor(Date.now() / 1000);
      return (await signCompactUcanAuthorization({
        issuerDid: did,
        audienceDid: NODE_DID,
        attenuation,
        facts: [{}],
        proofs: [],
        notBefore: now,
        expiresAt: now + 60,
        nonce: `urn:uuid:${crypto.randomUUID()}`,
        sign: async (bytes) => ed25519.sign(bytes, secret),
      })).authorization;
    },
  };
  return { did, signer, publicKey };
}

function payloadOf(authorization: string): {
  att: Record<string, Record<string, unknown[]>>;
  iss: string;
  prf: string[];
} {
  return JSON.parse(Buffer.from(authorization.split(".")[1]!, "base64url").toString());
}

function verifies(authorization: string, publicKey: Uint8Array): boolean {
  const [header, payload, signature] = authorization.split(".");
  return ed25519.verify(Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${header}.${payload}`), publicKey);
}

const item = (cid: string, status = "active") => ({
  cid,
  direction: "granted",
  delegatorDid: "did:key:z6MkIssuer",
  delegateDid: "did:key:z6MkRecipient",
  resources: [{ resource: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default/kv/a", actions: ["tinycloud.kv/get"], caveats: [] }],
  parents: [],
  issuedAt: "2026-10-26T10:00:00Z",
  notBefore: null,
  expiresAt: null,
  status,
});

const page = (items: unknown[], nextCursor?: string) =>
  new Response(JSON.stringify({ schemaVersion: 2, items, ...(nextCursor === undefined ? {} : { nextCursor }) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const info = (features: string[]) => new Response(JSON.stringify({ nodeId: NODE_DID, features }), { status: 200 });

type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };

function managerWith(
  signer: SessionInvocationSigner | undefined,
  respond: (call: Call) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const fetch = mock(async (url: string, init: Call["init"] = {}) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  });
  const invokeAny = mock(() => ({ Authorization: "must-not-be-used" }));
  const manager = new DelegationManager({
    hosts: [HOST],
    session: { spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default" } as ServiceSession,
    invoke: mock(() => ({ Authorization: "must-not-be-used" })),
    invokeAny,
    fetch: fetch as never,
    sessionInvocationSigner: signer,
  });
  return { manager, calls, invokeAny };
}

describe("DelegationManager.query direction issued", () => {
  test("signs one proofless list invocation on <session DID>/delegation and posts the contract body", async () => {
    const key = sessionKey();
    const { manager, calls, invokeAny } = managerWith(key.signer, ({ url }) =>
      url.endsWith("/info") ? info(["delegation-issued-query-v1"]) : page([item("bafy-a")]));

    const result = await manager.query({ direction: "issued", status: "active", space: "default", limit: 25, cursor: "c1" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.items.map((entry) => entry.cid)).toEqual(["bafy-a"]);
    const query = calls.find((call) => call.url === `${HOST}/delegation/query`)!;
    expect(query.init.method).toBe("POST");
    expect(JSON.parse(query.init.body!)).toEqual({ direction: "issued", status: "active", space: "default", limit: 25, cursor: "c1" });
    const authorization = query.init.headers!.Authorization!;
    const payload = payloadOf(authorization);
    expect(payload.att).toEqual({ [`${key.did}/delegation`]: { "tinycloud.delegation/list": [{}] } });
    expect(payload.prf).toEqual([]);
    expect(payload.iss.split("#")[0]).toBe(key.did);
    expect(verifies(authorization, key.publicKey)).toBe(true);
    expect(invokeAny).not.toHaveBeenCalled();
  });

  test("a body with only direction omits the optional filters", async () => {
    const { manager, calls } = managerWith(sessionKey().signer, ({ url }) =>
      url.endsWith("/info") ? info(["delegation-issued-query-v1"]) : page([]));

    await manager.query({ direction: "issued" });

    expect(JSON.parse(calls.find((call) => call.url.endsWith("/delegation/query"))!.init.body!)).toEqual({ direction: "issued" });
  });

  test("a node without delegation-issued-query-v1 gets a typed unsupported error and no query", async () => {
    const { manager, calls } = managerWith(sessionKey().signer, () => info(["encryption-named-keys-v1"]));

    const result = await manager.query({ direction: "issued" });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "UNSUPPORTED_OPERATION",
        message: "This node doesn't support listing issued delegations yet",
      }),
    });
    expect(calls.map((call) => call.url)).toEqual([`${HOST}/info`]);
  });

  test("a node without the features array at all counts as unsupported", async () => {
    const { manager } = managerWith(sessionKey().signer, () => new Response(JSON.stringify({ nodeId: NODE_DID }), { status: 200 }));

    expect((await manager.query({ direction: "issued" })).ok).toBe(false);
  });

  test("reads /info again after an unsupported answer, so a node upgrade is picked up", async () => {
    let features: string[] = [];
    const { manager } = managerWith(sessionKey().signer, ({ url }) =>
      url.endsWith("/info") ? info(features) : page([]));

    expect((await manager.query({ direction: "issued" })).ok).toBe(false);
    features = ["delegation-issued-query-v1"];
    expect((await manager.query({ direction: "issued" })).ok).toBe(true);
  });

  test("without a session signer it refuses before any request", async () => {
    const { manager, calls } = managerWith(undefined, () => info(["delegation-issued-query-v1"]));

    const result = await manager.query({ direction: "issued" });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a plain-text 403 becomes PERMISSION_DENIED carrying the node's message", async () => {
    const { manager } = managerWith(sessionKey().signer, ({ url }) =>
      url.endsWith("/info") ? info(["delegation-issued-query-v1"]) : new Response("Delegation query proof is not authorized", { status: 403 }));

    const result = await manager.query({ direction: "issued" });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "PERMISSION_DENIED",
        message: "Delegation query proof is not authorized",
        meta: expect.objectContaining({ status: 403 }),
      }),
    });
  });

  test("a plain-text 401 is the same refusal, with the node's message and status 401", async () => {
    const { manager } = managerWith(sessionKey().signer, ({ url }) =>
      url.endsWith("/info") ? info(["delegation-issued-query-v1"]) : new Response("Unauthorized", { status: 401 }));

    const result = await manager.query({ direction: "issued" });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "PERMISSION_DENIED", message: "Unauthorized", meta: expect.objectContaining({ status: 401 }) }),
    });
  });

  test("503 is a retryable too-deep error", async () => {
    const { manager } = managerWith(sessionKey().signer, ({ url }) =>
      url.endsWith("/info") ? info(["delegation-issued-query-v1"]) : new Response("chain too deep", { status: 503 }));

    const result = await manager.query({ direction: "issued" });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "CHAIN_TOO_DEEP",
        message: expect.stringContaining("try again later"),
        meta: expect.objectContaining({ status: 503, retryable: true }),
      }),
    });
  });

  test("a 503 'Delegation query unavailable' fails the whole page: no items are returned", async () => {
    const { manager } = managerWith(sessionKey().signer, ({ url }) =>
      url.endsWith("/info")
        ? info(["delegation-issued-query-v1"])
        : new Response(JSON.stringify({ schemaVersion: 2, items: [item("bafy-partial")] }), { status: 503 }));

    const result = await manager.query({ direction: "issued" });

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("data");
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "CHAIN_TOO_DEEP", meta: expect.objectContaining({ retryable: true }) }) });
  });

  test("a 400 'invalid delegation query cursor' is one typed invalid-cursor error", async () => {
    const { manager } = managerWith(sessionKey().signer, ({ url }) =>
      url.endsWith("/info") ? info(["delegation-issued-query-v1"]) : new Response("invalid delegation query cursor", { status: 400 }));

    const result = await manager.query({ direction: "issued", cursor: "foreign" });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "INVALID_CURSOR", meta: expect.objectContaining({ status: 400 }) }),
    });
  });

  test("any other 400 stays an ordinary node error", async () => {
    const { manager } = managerWith(sessionKey().signer, ({ url }) =>
      url.endsWith("/info") ? info(["delegation-issued-query-v1"]) : new Response("bad request", { status: 400 }));

    const result = await manager.query({ direction: "issued" });

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "NETWORK_ERROR" }) });
  });

  test("the invocation carries exactly one capability: one bare <DID>/delegation resource with the single list ability", async () => {
    const key = sessionKey();
    const { manager, calls } = managerWith(key.signer, ({ url }) =>
      url.endsWith("/info") ? info(["delegation-issued-query-v1"]) : page([]));

    await manager.query({ direction: "issued", space: "default", status: "active" });

    const { att } = payloadOf(calls.find((call) => call.url.endsWith("/delegation/query"))!.init.headers!.Authorization!);
    const resources = Object.keys(att);
    expect(resources).toEqual([`${key.did}/delegation`]);
    expect(resources[0]).not.toMatch(/[?#]/);
    expect(Object.keys(att[resources[0]!]!)).toEqual(["tinycloud.delegation/list"]);
    expect(att[resources[0]!]!["tinycloud.delegation/list"]).toEqual([{}]);
  });

  test("the other directions keep the account-space invocation and never read /info", async () => {
    const calls: Call[] = [];
    const invokeAny = mock(() => ({ Authorization: "account-list" }));
    const manager = new DelegationManager({
      hosts: [HOST],
      accountSpaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:account",
      session: { spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default" } as ServiceSession,
      invoke: mock(() => ({ Authorization: "unused" })),
      invokeAny,
      fetch: mock(async (url: string, init: Call["init"] = {}) => {
        calls.push({ url, init });
        return page([]);
      }) as never,
      sessionInvocationSigner: sessionKey().signer,
    });

    expect((await manager.query({ direction: "granted" })).ok).toBe(true);
    expect(invokeAny).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.url)).toEqual([`${HOST}/delegation/query`]);
  });
});

describe("DelegationManager.queryAllIssued", () => {
  test("follows nextCursor through a short page until it is absent", async () => {
    const queries: Array<Record<string, unknown>> = [];
    const { manager } = managerWith(sessionKey().signer, ({ url, init }) => {
      if (url.endsWith("/info")) return info(["delegation-issued-query-v1"]);
      const body = JSON.parse(init.body!) as Record<string, unknown>;
      queries.push(body);
      // Order is by CID and a filtered page may hold fewer rows than `limit`: page 2 has one row and a cursor.
      if (body.cursor === undefined) return page([item("bafy-a"), item("bafy-b")], "c1");
      if (body.cursor === "c1") return page([item("bafy-c")], "c2");
      return page([item("bafy-d")]);
    });

    const result = await manager.queryAllIssued({ pageSize: 2 });

    expect(result.ok && result.data.map((entry) => entry.cid)).toEqual(["bafy-a", "bafy-b", "bafy-c", "bafy-d"]);
    expect(queries).toEqual([
      { direction: "issued", limit: 2 },
      { direction: "issued", limit: 2, cursor: "c1" },
      { direction: "issued", limit: 2, cursor: "c2" },
    ]);
  });

  test("an empty page that still has a cursor does not end the list", async () => {
    const { manager } = managerWith(sessionKey().signer, ({ url, init }) => {
      if (url.endsWith("/info")) return info(["delegation-issued-query-v1"]);
      const { cursor } = JSON.parse(init.body!) as { cursor?: string };
      return cursor === undefined ? page([], "c1") : page([item("bafy-late")]);
    });

    const result = await manager.queryAllIssued({ status: "active" });

    expect(result.ok && result.data.map((entry) => entry.cid)).toEqual(["bafy-late"]);
  });

  test("maxItems stops at that many and asks for no more than still needed", async () => {
    const limits: number[] = [];
    const rows = [item("bafy-a"), item("bafy-b"), item("bafy-c"), item("bafy-d")];
    const { manager } = managerWith(sessionKey().signer, ({ url, init }) => {
      if (url.endsWith("/info")) return info(["delegation-issued-query-v1"]);
      const body: { limit: number; cursor?: string } = JSON.parse(init.body!);
      limits.push(body.limit);
      const from = body.cursor === undefined ? 0 : Number(body.cursor);
      return page(rows.slice(from, from + body.limit), String(from + body.limit));
    });

    const result = await manager.queryAllIssued({ maxItems: 3, pageSize: 2 });

    expect(result.ok && result.data.map((entry) => entry.cid)).toEqual(["bafy-a", "bafy-b", "bafy-c"]);
    expect(limits).toEqual([2, 1]);
  });

  test("untilCid stops after the page that holds it", async () => {
    let queried = 0;
    const { manager } = managerWith(sessionKey().signer, ({ url }) => {
      if (url.endsWith("/info")) return info(["delegation-issued-query-v1"]);
      queried += 1;
      return page([item("bafy-a"), item("bafy-target")], "more");
    });

    const result = await manager.queryAllIssued({ untilCid: "bafy-target" });

    expect(result.ok).toBe(true);
    expect(queried).toBe(1);
  });

  test("a cursor that repeats is an invalid response, not an endless loop", async () => {
    const { manager } = managerWith(sessionKey().signer, ({ url }) =>
      url.endsWith("/info") ? info(["delegation-issued-query-v1"]) : page([item("bafy-a")], "same"));

    const result = await manager.queryAllIssued();

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "INVALID_TOKEN" }) });
  });

  test("an invalid-cursor answer ends the listing: the rejected cursor is never sent again", async () => {
    const cursorsSent: Array<string | undefined> = [];
    const { manager } = managerWith(sessionKey().signer, ({ url, init }) => {
      if (url.endsWith("/info")) return info(["delegation-issued-query-v1"]);
      const body: { cursor?: string } = JSON.parse(init.body!);
      cursorsSent.push(body.cursor);
      return body.cursor === undefined
        ? page([item("bafy-a")], "c1")
        : new Response("invalid delegation query cursor", { status: 400 });
    });

    const result = await manager.queryAllIssued();

    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "INVALID_CURSOR" }) });
    expect(cursorsSent).toEqual([undefined, "c1"]);
  });
});

describe("DelegationManager.revokeIssued", () => {
  const receipt = (cid: string) => new Response(JSON.stringify({ revoked: true, cid }), { status: 200 });

  test("posts a UCAN signed by the session's own did:key: urn:cid + delegation/revoke, no proof", async () => {
    const key = sessionKey();
    const { manager, calls, invokeAny } = managerWith(key.signer, () => receipt("bafy-child"));

    const result = await manager.revokeIssued("bafy-child");

    expect(result).toEqual({ ok: true, data: { revoked: true, cid: "bafy-child" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${HOST}/revoke`);
    expect(calls[0]!.init.method).toBe("POST");
    const authorization = calls[0]!.init.headers!.Authorization!;
    const payload = payloadOf(authorization);
    expect(payload.att).toEqual({ "urn:cid:bafy-child": { "tinycloud.delegation/revoke": [{}] } });
    expect(payload.prf).toEqual([]);
    expect(payload.iss.split("#")[0]).toBe(key.did);
    expect(verifies(authorization, key.publicKey)).toBe(true);
    expect(invokeAny).not.toHaveBeenCalled();
  });

  test("revoking a delegation that is already revoked is a success (the node answers 200 again)", async () => {
    const { manager, calls } = managerWith(sessionKey().signer, () => receipt("bafy-child"));

    expect((await manager.revokeIssued("bafy-child")).ok).toBe(true);
    expect((await manager.revokeIssued("bafy-child")).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("a plain-text 403 carries the node's message", async () => {
    const { manager } = managerWith(sessionKey().signer, () => new Response("Unauthorized Revoker", { status: 403 }));

    const result = await manager.revokeIssued("bafy-child");

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "PERMISSION_DENIED",
        message: "Unauthorized Revoker",
        meta: expect.objectContaining({ status: 403, cid: "bafy-child" }),
      }),
    });
  });

  test("a plain-text 401 is the same refusal, with the node's message and status 401", async () => {
    const { manager } = managerWith(sessionKey().signer, () => new Response("Unauthorized Revoker", { status: 401 }));

    const result = await manager.revokeIssued("bafy-child");

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "PERMISSION_DENIED",
        message: "Unauthorized Revoker",
        meta: expect.objectContaining({ status: 401, cid: "bafy-child" }),
      }),
    });
  });

  test("503 is a retryable too-deep error", async () => {
    const { manager } = managerWith(sessionKey().signer, () => new Response("", { status: 503 }));

    const result = await manager.revokeIssued("bafy-child");

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "CHAIN_TOO_DEEP", meta: expect.objectContaining({ status: 503, retryable: true }) }),
    });
  });

  test("a receipt for another CID is not a success", async () => {
    const { manager } = managerWith(sessionKey().signer, () => receipt("bafy-other"));

    expect((await manager.revokeIssued("bafy-child")).ok).toBe(false);
  });

  test("without a session signer it refuses before any request", async () => {
    const { manager, calls } = managerWith(undefined, () => receipt("bafy-child"));

    expect((await manager.revokeIssued("bafy-child")).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
