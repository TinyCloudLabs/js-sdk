import { describe, expect, test } from "bun:test";
import { createCipheriv, createECDH, createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  ackApprovalResult,
  ApprovalClientError,
  approvalSessionProof,
  checkApprovalResultBinding,
  collectApprovalResult,
  discoverApprovalResult,
  fetchApprovalResult,
  generateRelayKey,
  openRelayResult,
  type ApprovalRequesterState,
  type Ed25519PrivateJwk,
} from "../src/links/index.js";

// TC-2300: the requester side of an OpenKey approval request, shared by Courier (and any requester). The fake OpenKey
// below is the independent side of the wire contract: it verifies the session proof with node:crypto, recomputes the
// credential hash itself, and encrypts results with node:crypto's ECDH/HMAC/AES-GCM, so these tests fail if the client
// signs, hashes, derives or decrypts differently from what OpenKey does. No test touches the network: `fetch` is injected.

const seed = new Uint8Array(32).fill(7);
const signingKey: Ed25519PrivateJwk = {
  kty: "OKP", crv: "Ed25519", x: Buffer.from(ed25519.getPublicKey(seed)).toString("base64url"), d: Buffer.from(seed).toString("base64url"),
};
const API = "https://api.openkey.example";
const REQUEST_ID = "abcdefghijklmnopqrstuvwxyz";
const BODY_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const RESULT_REF = "synthetic-result-reference-123456";
const RESULT_EXPIRES = new Date(Date.now() + 600_000).toISOString();
const RECORD = { header: { marker: "header" }, signature: { marker: "signature" } } as unknown as ApprovalRequesterState["record"];
const state: ApprovalRequesterState = { requestId: REQUEST_ID, bodyCid: BODY_CID, record: RECORD, apiOrigin: API, signingKey };

type Action = "discover" | "fetch" | "ack";
interface Call { action: Action; url: string; body: Record<string, unknown>; proofValid: boolean; claims: Record<string, unknown> }

/** A fake OpenKey `fetch`. Every call is recorded with an independent check of the session proof. */
function fakeOpenKey(handler: (call: Call, index: number) => Response | Error | Promise<Response | Error>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const action: Action = url.endsWith("/result") ? "discover" : url.endsWith("/fetch") ? "fetch" : "ack";
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = init?.headers as Record<string, string>;
    const [header, payload, signature] = (headers["OpenKey-Session-Proof"] ?? "").split(".");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8") || "{}") as Record<string, unknown>;
    const ref = action === "discover" ? "" : url.split("/")[5]!;
    const credential = JSON.stringify([action, REQUEST_ID, BODY_CID, ref, action === "ack" ? body.ackId : ""]);
    const jkt = createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: signingKey.x })).digest("base64url");
    const parsedHeader = JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8") || "{}") as Record<string, unknown>;
    const proofValid = verify(null, Buffer.from(`${header}.${payload}`), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: signingKey.x }, format: "jwk" }),
      Buffer.from(signature ?? "", "base64url")) &&
      parsedHeader.alg === "EdDSA" && parsedHeader.typ === "openkey-session-proof+jwt" && parsedHeader.kid === jkt &&
      claims.client_id === "openkey-approval-result-v1" && claims.htm === "POST" && claims.htu === url &&
      claims.cred_hash === createHash("sha256").update(credential).digest("base64url") &&
      typeof claims.jti === "string" && Math.abs((claims.iat as number) - Date.now() / 1000) < 60;
    const call: Call = { action, url, body, proofValid, claims };
    calls.push(call);
    const outcome = await handler(call, calls.length - 1);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { fetch: impl as typeof globalThis.fetch, calls };
}

const json = (value: unknown, status = 200) => Response.json(value, { status });
const refusalOf = async (run: () => Promise<unknown>): Promise<ApprovalClientError> => {
  try { await run(); } catch (error) { return error as ApprovalClientError; }
  throw new Error("expected a refusal");
};

/** OpenKey's side of the relay: ECDH to the requester's public key, HMAC-derived key, AES-256-GCM with the request id as AAD. */
function sealRelay(publicJwk: { x: string; y: string }, requestId: string, plaintext: unknown) {
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x, "base64url"), Buffer.from(publicJwk.y, "base64url")]));
  const extracted = createHmac("sha256", Buffer.from(requestId)).update(shared).digest();
  const key = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(requestId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const point = ephemeral.getPublicKey();
  return {
    version: 1, algorithm: "ECDH-P256-A256GCM",
    ephemeralPublicJwk: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") },
    nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"),
  };
}

describe("approvalSessionProof", () => {
  test.each(["discover", "fetch", "ack"] as const)("a %s proof verifies under the requester key and binds the exact URL and credential", async (action) => {
    const { fetch, calls } = fakeOpenKey(() => json({}, 500));
    const found = { resultRef: RESULT_REF, expiresAt: RESULT_EXPIRES };
    if (action === "discover") await discoverApprovalResult(state, { fetch }).catch(() => undefined);
    else if (action === "fetch") await fetchApprovalResult(state, found, { fetch }).catch(() => undefined);
    else await ackApprovalResult(state, RESULT_REF, "ack-id-1", { fetch }).catch(() => undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.proofValid).toBe(true);
    expect(calls[0]!.url).toBe(action === "discover" ? `${API}/api/approval-requests/${REQUEST_ID}/result` : `${API}/api/approval-results/${RESULT_REF}/${action}`);
  });

  test("a proof for one ACK id does not verify for another, and every proof has its own jti", () => {
    const first = approvalSessionProof(state, "ack", RESULT_REF, "ack-one");
    const second = approvalSessionProof(state, "ack", RESULT_REF, "ack-one");
    const claims = (proof: string) => JSON.parse(Buffer.from(proof.split(".")[1]!, "base64url").toString("utf8")) as Record<string, string>;
    expect(claims(first).jti).not.toBe(claims(second).jti);
    expect(claims(first).cred_hash).toBe(createHash("sha256").update(JSON.stringify(["ack", REQUEST_ID, BODY_CID, RESULT_REF, "ack-one"])).digest("base64url"));
    expect(claims(approvalSessionProof(state, "ack", RESULT_REF, "ack-two")).cred_hash).not.toBe(claims(first).cred_hash);
    expect(claims(approvalSessionProof(state, "fetch", RESULT_REF)).cred_hash).not.toBe(claims(approvalSessionProof(state, "ack", RESULT_REF)).cred_hash);
  });
});

describe("discoverApprovalResult", () => {
  test("202 is pending and the request carries the signed creation record, not the result key", async () => {
    const { fetch, calls } = fakeOpenKey(() => new Response(null, { status: 202 }));
    expect(await discoverApprovalResult(state, { fetch })).toEqual({ status: "pending" });
    expect(calls[0]!.body).toEqual({ bodyCid: BODY_CID, header: RECORD.header, signature: RECORD.signature });
    expect(JSON.stringify(calls[0]!.body)).not.toContain(signingKey.d);
  });

  test("200 returns the reference and its retention expiry", async () => {
    const { fetch } = fakeOpenKey(() => json({ resultRef: RESULT_REF, expiresAt: RESULT_EXPIRES }));
    expect(await discoverApprovalResult(state, { fetch })).toEqual({ status: "ready", resultRef: RESULT_REF, expiresAt: RESULT_EXPIRES });
  });

  test.each([
    ["a reference with path characters", { resultRef: "../../x", expiresAt: RESULT_EXPIRES }],
    ["a too-short reference", { resultRef: "short", expiresAt: RESULT_EXPIRES }],
    ["no expiry", { resultRef: RESULT_REF }],
    ["an unparsable expiry", { resultRef: RESULT_REF, expiresAt: "soon" }],
  ])("%s is result_invalid", async (_label, reply) => {
    const { fetch } = fakeOpenKey(() => json(reply));
    expect((await refusalOf(() => discoverApprovalResult(state, { fetch }))).code).toBe("result_invalid");
  });

  test.each([
    ["expired_request", 410, "request_expired"],
    ["invalid_request", 400, "request_expired"],
    ["expired_result", 410, "result_expired"],
    ["acknowledged", 409, "acknowledged"],
    ["not_found", 404, "not_found"],
    ["ack_conflict", 409, "ack_conflict"],
    ["request_binding", 403, "request_binding"],
    ["invalid_proof", 401, "request_binding"],
    ["something_new", 500, "unavailable"],
  ])("OpenKey code %s (HTTP %i) is %s", async (code, status, expected) => {
    const { fetch } = fakeOpenKey(() => json({ code }, status));
    const error = await refusalOf(() => discoverApprovalResult(state, { fetch }));
    expect(error).toBeInstanceOf(ApprovalClientError);
    expect<string>(error.code).toBe(expected);
    expect(error.status).toBe(status);
  });

  test("a reply that is not JSON is unavailable with its status; a thrown fetch is network", async () => {
    const html = fakeOpenKey(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const bad = await refusalOf(() => discoverApprovalResult(state, { fetch: html.fetch }));
    expect([bad.code, bad.status]).toEqual(["unavailable", 502]);
    const down = fakeOpenKey(() => new TypeError("fetch failed"));
    expect((await refusalOf(() => discoverApprovalResult(state, { fetch: down.fetch }))).code).toBe("network");
  });
});

describe("invalid_request (HTTP 400) means an expired request only when discovering", () => {
  const found = { resultRef: RESULT_REF, expiresAt: RESULT_EXPIRES };
  test("fetch and ack answered 400 invalid_request are `unavailable` (retryable), never `request_expired`", async () => {
    const { fetch } = fakeOpenKey(() => json({ code: "invalid_request" }, 400));
    expect((await refusalOf(() => fetchApprovalResult(state, found, { fetch }))).code).toBe("unavailable");
    expect((await refusalOf(() => ackApprovalResult(state, RESULT_REF, "ack-id-1", { fetch }))).code).toBe("unavailable");
  });
  test("discover answered 400 invalid_request is still request_expired", async () => {
    const { fetch } = fakeOpenKey(() => json({ code: "invalid_request" }, 400));
    expect((await refusalOf(() => discoverApprovalResult(state, { fetch }))).code).toBe("request_expired");
  });
});

describe("fetchApprovalResult", () => {
  const found = { resultRef: RESULT_REF, expiresAt: RESULT_EXPIRES };
  const relay = { version: 1 };
  const reply = { requestId: REQUEST_ID, bodyCid: BODY_CID, resultRef: RESULT_REF, expiresAt: RESULT_EXPIRES, relay };

  test("returns the envelope and sends no result key or ACK id", async () => {
    const { fetch, calls } = fakeOpenKey(() => json(reply));
    expect(await fetchApprovalResult(state, found, { fetch })).toEqual(relay);
    expect(calls[0]!.body).toEqual({ requestId: REQUEST_ID, bodyCid: BODY_CID });
  });

  test.each([
    ["another request id", { requestId: "zzzzzzzzzzzzzzzzzzzzzzzzzz" }],
    ["another body CID", { bodyCid: "bafkreiother" }],
    ["another result reference", { resultRef: "another-result-reference-123456" }],
    ["another retention expiry", { expiresAt: new Date(Date.now() + 1000).toISOString() }],
    ["no relay envelope", { relay: undefined }],
  ])("a reply carrying %s is refused", async (_label, change) => {
    const { fetch } = fakeOpenKey(() => json({ ...reply, ...change }));
    expect((await refusalOf(() => fetchApprovalResult(state, found, { fetch }))).code).toBe("result_invalid");
  });

  test("a result past OpenKey's retention is result_expired", async () => {
    const { fetch } = fakeOpenKey(() => json({ code: "expired_result" }, 410));
    expect((await refusalOf(() => fetchApprovalResult(state, found, { fetch }))).code).toBe("result_expired");
  });
});

describe("ackApprovalResult", () => {
  test("sends the ACK id under a proof bound to it and reports acknowledged", async () => {
    const { fetch, calls } = fakeOpenKey((call) => json({ ackId: call.body.ackId, status: "acknowledged" }));
    expect(await ackApprovalResult(state, RESULT_REF, "ack-id-1", { fetch })).toBe("acknowledged");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ requestId: REQUEST_ID, bodyCid: BODY_CID, ackId: "ack-id-1" });
    expect(calls[0]!.proofValid).toBe(true);
  });

  test.each([["expired_result", 410], ["not_found", 404], ["acknowledged", 409]])("OpenKey saying %s is settled, not an error", async (code, status) => {
    const { fetch } = fakeOpenKey(() => json({ code }, status));
    expect(await ackApprovalResult(state, RESULT_REF, "ack-id-1", { fetch })).toBe("settled");
  });

  test("a different ACK id stored by OpenKey, an echo of another id, a 5xx and a dropped connection all throw so the caller retries", async () => {
    const conflict = fakeOpenKey(() => json({ code: "ack_conflict" }, 409));
    expect((await refusalOf(() => ackApprovalResult(state, RESULT_REF, "ack-id-1", { fetch: conflict.fetch }))).code).toBe("ack_conflict");
    const echo = fakeOpenKey(() => json({ ackId: "someone-else", status: "acknowledged" }));
    expect((await refusalOf(() => ackApprovalResult(state, RESULT_REF, "ack-id-1", { fetch: echo.fetch }))).code).toBe("unavailable");
    const flaky = fakeOpenKey(() => json({}, 503));
    expect((await refusalOf(() => ackApprovalResult(state, RESULT_REF, "ack-id-1", { fetch: flaky.fetch }))).code).toBe("unavailable");
    const down = fakeOpenKey(() => new TypeError("fetch failed"));
    expect((await refusalOf(() => ackApprovalResult(state, RESULT_REF, "ack-id-1", { fetch: down.fetch }))).code).toBe("network");
  });
});

describe("collectApprovalResult", () => {
  const relay = { version: 1, marker: "envelope" };
  const found = { resultRef: RESULT_REF, expiresAt: RESULT_EXPIRES };
  const answer = (call: Call, approvedAfter: number, index: number) => call.action === "discover"
    ? (index < approvedAfter ? new Response(null, { status: 202 }) : json(found))
    : json({ requestId: REQUEST_ID, bodyCid: BODY_CID, ...found, relay });

  test("polls every interval until approval, then fetches; every proof verifies", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = fakeOpenKey((call, index) => answer(call, 3, index));
    const collected = await collectApprovalResult(state, { fetch, sleep: async (ms) => { sleeps.push(ms); } });
    expect(collected).toEqual({ status: "result", ...found, relay });
    expect(calls.map((call) => call.action)).toEqual(["discover", "discover", "discover", "discover", "fetch"]);
    expect(sleeps).toEqual([2000, 2000, 2000]);
    expect(calls.every((call) => call.proofValid)).toBe(true);
  });

  test("onDiscovered runs before the fetch; if it throws (the caller could not save), nothing is fetched", async () => {
    const order: string[] = [];
    const ok = fakeOpenKey((call, index) => { order.push(call.action); return answer(call, 0, index); });
    await collectApprovalResult(state, { fetch: ok.fetch, onDiscovered: async () => { order.push("saved"); } });
    expect(order).toEqual(["discover", "saved", "fetch"]);
    const failing = fakeOpenKey((call, index) => answer(call, 0, index));
    await expect(collectApprovalResult(state, { fetch: failing.fetch, onDiscovered: () => { throw new Error("disk full"); } })).rejects.toThrow("disk full");
    expect(failing.calls.map((call) => call.action)).toEqual(["discover"]);
  });

  test("a known reference skips discovery entirely; a network error on fetch retries the fetch only, never a new discover", async () => {
    let failed = false;
    const { fetch, calls } = fakeOpenKey((call, index) => {
      if (call.action === "fetch" && !failed) { failed = true; return new TypeError("fetch failed"); }
      return answer(call, 0, index);
    });
    const collected = await collectApprovalResult(state, { fetch, known: found, sleep: async () => {} });
    expect(collected.status).toBe("result");
    expect(calls.map((call) => call.action)).toEqual(["fetch", "fetch"]);
  });

  test("network errors while polling are retried; a typed OpenKey refusal ends the wait at once", async () => {
    const { fetch, calls } = fakeOpenKey((call, index) => index < 2 ? new TypeError("fetch failed") : answer(call, 2, index));
    expect((await collectApprovalResult(state, { fetch, sleep: async () => {} })).status).toBe("result");
    expect(calls.filter((call) => call.action === "discover")).toHaveLength(3);
    const expired = fakeOpenKey(() => json({ code: "expired_request" }, 410));
    expect((await refusalOf(() => collectApprovalResult(state, { fetch: expired.fetch, sleep: async () => {} }))).code).toBe("request_expired");
    expect(expired.calls).toHaveLength(1);
  });

  test("the deadline ends the wait with `deadline`, sleeping no longer than the time left, and never fetches", async () => {
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const { fetch, calls } = fakeOpenKey(() => new Response(null, { status: 202 }));
    const outcome = await collectApprovalResult(state, {
      fetch, deadline: clock + 4500, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    });
    expect(outcome).toEqual({ status: "deadline" });
    expect(sleeps).toEqual([2000, 2000, 500]);
    expect(calls.map((call) => call.action)).toEqual(["discover", "discover", "discover", "discover"]);
  });

  test("an approval found after the deadline has passed is still collected, not dropped", async () => {
    const { fetch, calls } = fakeOpenKey((call, index) => answer(call, 0, index));
    const outcome = await collectApprovalResult(state, { fetch, deadline: 1, now: () => 5_000 });
    expect(outcome).toEqual({ status: "result", ...found, relay });
    expect(calls.map((call) => call.action)).toEqual(["discover", "fetch"]);
  });

  test("a poll that starts near the deadline cannot outlive it by a full request timeout", async () => {
    // Real time on purpose: the request timeout is `AbortSignal.timeout`, a platform timer that fake clocks here cannot drive.
    // A hung OpenKey only ends a request when its signal fires. The default request timeout is 10 s; a wait whose deadline is
    // 300 ms away must end about a second later, not ten.
    const hung = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
    });
    const started = Date.now();
    const outcome = await collectApprovalResult(state, { fetch: hung as typeof globalThis.fetch, deadline: started + 300, sleep: async () => {} });
    expect(outcome).toEqual({ status: "deadline" });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("relay key and encrypted result", () => {
  const plaintext = { resultVersion: 1, requestId: REQUEST_ID, marker: "secret-delegation" };

  test("a fresh relay key is a valid P-256 key node:crypto can encrypt to, and opens what OpenKey seals", async () => {
    const relay = generateRelayKey();
    expect(relay.publicJwk).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(Buffer.from(relay.privateKey, "base64url")).toHaveLength(32);
    expect(generateRelayKey().privateKey).not.toBe(relay.privateKey);
    const envelope = sealRelay(relay.publicJwk, REQUEST_ID, plaintext);
    expect(await openRelayResult(envelope, REQUEST_ID, relay.privateKey)).toEqual(plaintext);
  });

  test("the private scalar belongs to the public key: node's ECDH built from it publishes the same point", () => {
    const relay = generateRelayKey();
    const node = createECDH("prime256v1");
    node.setPrivateKey(Buffer.from(relay.privateKey, "base64url"));
    const point = node.getPublicKey();
    expect(point.subarray(1, 33).toString("base64url")).toBe(relay.publicJwk.x);
    expect(point.subarray(33).toString("base64url")).toBe(relay.publicJwk.y);
  });

  test("a result sealed for another request id, to another key, or tampered with is refused and never partially returned", async () => {
    const relay = generateRelayKey();
    const envelope = sealRelay(relay.publicJwk, REQUEST_ID, plaintext);
    expect((await refusalOf(() => openRelayResult(envelope, "zzzzzzzzzzzzzzzzzzzzzzzzzz", relay.privateKey))).code).toBe("result_invalid");
    expect((await refusalOf(() => openRelayResult(envelope, REQUEST_ID, generateRelayKey().privateKey))).code).toBe("result_invalid");
    const flipped = Buffer.from(envelope.ciphertext, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect((await refusalOf(() => openRelayResult({ ...envelope, ciphertext: flipped.toString("base64url") }, REQUEST_ID, relay.privateKey))).code).toBe("result_invalid");
    const truncated = Buffer.from(envelope.ciphertext, "base64url").subarray(0, 10);
    expect((await refusalOf(() => openRelayResult({ ...envelope, ciphertext: truncated.toString("base64url") }, REQUEST_ID, relay.privateKey))).code).toBe("result_invalid");
  });

  test.each([
    ["not an object", () => "text"],
    ["an array", () => []],
    ["an unsupported version", (e: Record<string, unknown>) => ({ ...e, version: 2 })],
    ["an unsupported algorithm", (e: Record<string, unknown>) => ({ ...e, algorithm: "RSA-OAEP" })],
    ["a private key in the peer JWK", (e: Record<string, unknown>) => ({ ...e, ephemeralPublicJwk: { ...(e.ephemeralPublicJwk as object), d: "AA" } })],
    ["a peer point off the curve", (e: Record<string, unknown>) => ({ ...e, ephemeralPublicJwk: { kty: "EC", crv: "P-256", x: Buffer.alloc(32, 1).toString("base64url"), y: Buffer.alloc(32, 2).toString("base64url") } })],
    ["a short nonce", (e: Record<string, unknown>) => ({ ...e, nonce: Buffer.alloc(8).toString("base64url") })],
    ["padded base64", (e: Record<string, unknown>) => ({ ...e, nonce: `${e.nonce as string}=` })],
    ["a missing ciphertext", (e: Record<string, unknown>) => ({ ...e, ciphertext: undefined })],
  ])("an envelope with %s is result_invalid", async (_label, change) => {
    const relay = generateRelayKey();
    const envelope = sealRelay(relay.publicJwk, REQUEST_ID, plaintext) as unknown as Record<string, unknown>;
    const error = await refusalOf(() => openRelayResult(change(envelope), REQUEST_ID, relay.privateKey));
    expect(error).toBeInstanceOf(ApprovalClientError);
    expect(error.code).toBe("result_invalid");
  });

  test("a decrypted value that is not a JSON object is refused", async () => {
    const relay = generateRelayKey();
    const envelope = sealRelay(relay.publicJwk, REQUEST_ID, ["not", "an", "object"]);
    expect((await refusalOf(() => openRelayResult(envelope, REQUEST_ID, relay.privateKey))).code).toBe("result_invalid");
  });
});

describe("checkApprovalResultBinding", () => {
  const request = { issuer: "did:key:z6Mkrequester", targetDid: "did:key:z6Mkrequester" };
  const expected = { requestId: REQUEST_ID, bodyCid: BODY_CID, request };
  const expiresAt = "2999-01-01T00:00:00.000Z";
  const good = { resultVersion: 1, requestId: REQUEST_ID, requestDigest: BODY_CID, requesterDid: request.issuer, targetDid: request.targetDid,
    ownerDid: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111", delegationExpiresAt: expiresAt, delegation: { marker: "d" } };

  test("an exact answer yields owner, expiry and the delegation", () => {
    expect(checkApprovalResultBinding(good, expected)).toEqual({ ownerDid: good.ownerDid, delegationExpiresAt: expiresAt, delegation: { marker: "d" } });
  });

  test.each([
    ["another request id", { requestId: "zzzzzzzzzzzzzzzzzzzzzzzzzz" }],
    ["another request digest", { requestDigest: "bafkreiother" }],
    ["another requester", { requesterDid: "did:key:z6Mkother" }],
    ["another target", { targetDid: "did:key:z6Mkother" }],
    ["another result version", { resultVersion: 2 }],
    ["no owner", { ownerDid: "" }],
    ["a non-canonical expiry spelling", { delegationExpiresAt: expiresAt.replace(".000Z", "Z") }],
    ["an unparsable expiry", { delegationExpiresAt: "tomorrow" }],
    ["an already passed expiry", { delegationExpiresAt: new Date(Date.now() - 1000).toISOString() }],
    ["no delegation", { delegation: undefined }],
    ["an array as delegation", { delegation: [] }],
  ])("a result with %s is refused", (_label, change) => {
    let error: unknown;
    try { checkApprovalResultBinding({ ...good, ...change }, expected); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ApprovalClientError);
    expect((error as ApprovalClientError).code).toBe("result_invalid");
  });

  test("the error names the fields that differ, never their values", () => {
    let error: unknown;
    try { checkApprovalResultBinding({ ...good, requestDigest: "bafkreisecretvalue", requesterDid: "did:key:z6Mksecretvalue" }, expected); } catch (caught) { error = caught; }
    const message = (error as ApprovalClientError).message;
    expect(message).toContain("requestDigest, requesterDid");
    expect(message).not.toContain("bafkreisecretvalue");
    expect(message).not.toContain("z6Mksecretvalue");
    try { checkApprovalResultBinding({ ...good, delegation: undefined, ownerDid: "" }, expected); } catch (caught) { error = caught; }
    expect((error as ApprovalClientError).message).toContain("ownerDid, delegation");
  });

  test("the expiry is judged against the supplied clock", () => {
    expect(() => checkApprovalResultBinding(good, { ...expected, now: Date.parse(expiresAt) + 1 })).toThrow();
    expect(() => checkApprovalResultBinding(good, { ...expected, now: Date.parse(expiresAt) - 1 })).not.toThrow();
  });
});
