import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import {
  callApproval,
  classifyReply,
  exitCodeOf,
  reduce,
  requesterState,
  serverDateSkewMs,
  type ApprovalRequesterState,
  type Ed25519PrivateJwk,
  type Reply,
  type Step,
} from "../src/links/index.js";
import { T0, entryIn } from "./approval-machine-fixtures.js";

// TC-2377: `classifyReply` is the ONE place an OpenKey answer becomes a typed reply for the machine. The wire contract
// (OpenKey #418): a denied request answers HTTP 410, the EXISTING code `expired_request`, plus additive `status:"denied"`
// and `deniedAt`.

const REQUEST_ID = "abcdefghijklmnopqrstuvwxyz";
const BODY_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const RESULT_REF = "synthetic-result-reference-123456";
const EXPIRES = "2026-11-03T12:10:00.000Z";
const expect_ = { requestId: REQUEST_ID, bodyCid: BODY_CID, resultRef: RESULT_REF, resultExpiresAt: EXPIRES, ackId: "ack-id-0123456789abcdef" };
const code = (reply: Reply) => (reply.kind === "error" ? reply.code : reply.kind);

describe("classifyReply: discover", () => {
  test("202 is pending; 200 with a canonical reference is ready", () => {
    expect(classifyReply("discover", 202, { status: "pending" }, expect_)).toEqual({ kind: "pending" });
    expect(classifyReply("discover", 200, { status: "approved", resultRef: RESULT_REF, expiresAt: EXPIRES }, expect_))
      .toEqual({ kind: "ready", resultRef: RESULT_REF, resultExpiresAt: EXPIRES });
  });

  test("a 200 without a usable reference or expiry is malformed, never ready", () => {
    for (const body of [null, {}, { resultRef: "short", expiresAt: EXPIRES }, { resultRef: RESULT_REF }, { resultRef: RESULT_REF, expiresAt: "tomorrow" },
      { resultRef: RESULT_REF, expiresAt: "2026-11-03T12:10:00Z" }]) {
      expect(classifyReply("discover", 200, body, expect_)).toEqual({ kind: "malformed", call: "discover" });
    }
  });

  test("a denied request: 410 expired_request + status denied, or code request_denied, is request_denied", () => {
    const denied = { error: "Approval request was denied", code: "expired_request", status: "denied", deniedAt: "2026-11-03T12:00:00.000Z" };
    expect(classifyReply("discover", 410, denied, expect_)).toEqual({ kind: "error", call: "discover", status: 410, code: "request_denied" });
    expect(classifyReply("discover", 410, { code: "request_denied" }, expect_)).toMatchObject({ code: "request_denied" });
    expect(classifyReply("discover", 410, { status: "denied" }, expect_)).toMatchObject({ code: "request_denied" });
  });

  test("a plain 410 expired_request (no denied field) stays expired_request", () => {
    expect(classifyReply("discover", 410, { error: "Approval request expired. Start a new request.", code: "expired_request" }, expect_))
      .toMatchObject({ code: "expired_request", status: 410 });
    expect(classifyReply("discover", 410, { code: "expired_request", status: "expired" }, expect_)).toMatchObject({ code: "expired_request" });
  });

  test("a 200 whose body says denied is NOT a denial (OpenKey never answers it so), it is malformed", () => {
    expect(classifyReply("discover", 200, { status: "denied" }, expect_)).toEqual({ kind: "malformed", call: "discover" });
  });

  test("400 invalid_request keeps its own code: it is never mapped to expired_request", () => {
    expect(code(classifyReply("discover", 400, { error: "Signed approval request header is invalid", code: "invalid_request" }, expect_))).toBe("invalid_request");
  });

  test("401 invalid_proof stays distinct from 400 request_binding", () => {
    expect(code(classifyReply("discover", 401, { code: "invalid_proof" }, expect_))).toBe("invalid_proof");
    expect(code(classifyReply("discover", 400, { code: "request_binding" }, expect_))).toBe("request_binding");
  });

  test("a body that is not JSON, has no code, or an unknown code is `unknown`, carrying the status", () => {
    expect(classifyReply("discover", 502, null, expect_)).toEqual({ kind: "error", call: "discover", status: 502, code: "unknown" });
    expect(classifyReply("discover", 500, { error: "boom" }, expect_)).toMatchObject({ code: "unknown" });
    expect(classifyReply("discover", 400, { code: "header_fields" }, expect_)).toMatchObject({ code: "unknown" });
    expect(classifyReply("discover", 400, { code: 7 }, expect_)).toMatchObject({ code: "unknown" });
  });
});

describe("classifyReply: fetch and ack", () => {
  const relay = { v: 1 };
  const fetched = { requestId: REQUEST_ID, bodyCid: BODY_CID, resultRef: RESULT_REF, expiresAt: EXPIRES, relay };

  test("a fetch 200 that names this request is an envelope; any mismatch is malformed", () => {
    expect(classifyReply("fetch", 200, fetched, expect_)).toEqual({ kind: "envelope", envelope: relay });
    for (const patch of [{ requestId: "zzzzzzzzzzzzzzzzzzzzzzzzzz" }, { bodyCid: "x" }, { resultRef: "y" }, { expiresAt: "2026-11-03T12:11:00.000Z" }, { relay: null }, { relay: "str" }]) {
      expect(classifyReply("fetch", 200, { ...fetched, ...patch }, expect_)).toEqual({ kind: "malformed", call: "fetch" });
    }
  });

  test("fetch error codes", () => {
    expect(code(classifyReply("fetch", 404, { code: "not_found" }, expect_))).toBe("not_found");
    expect(code(classifyReply("fetch", 410, { code: "expired_result" }, expect_))).toBe("expired_result");
    expect(code(classifyReply("fetch", 409, { code: "acknowledged" }, expect_))).toBe("acknowledged");
  });

  test("an ack 200 that echoes this ackId is acked; anything else is malformed", () => {
    expect(classifyReply("ack", 200, { ackId: expect_.ackId, status: "acknowledged" }, expect_)).toEqual({ kind: "acked" });
    expect(classifyReply("ack", 200, { ackId: "other-ack-id-0123456789", status: "acknowledged" }, expect_)).toEqual({ kind: "malformed", call: "ack" });
    expect(classifyReply("ack", 200, { ackId: expect_.ackId, status: "pending" }, expect_)).toEqual({ kind: "malformed", call: "ack" });
    expect(code(classifyReply("ack", 409, { code: "ack_conflict" }, expect_))).toBe("ack_conflict");
    expect(code(classifyReply("ack", 400, { code: "invalid_ack" }, expect_))).toBe("invalid_ack");
  });
});

describe("end to end: wire answer -> classifyReply -> reduce", () => {
  const open = () => requesterState(entryIn("open", { staged: true }));
  const run = (status: number, body: unknown) => {
    const started = reduce(open(), { type: "start", now: T0 + 1_000 });
    return reduce(started.state, { type: "reply", now: T0 + 2_000, reply: classifyReply("discover", status, body, expect_) });
  };
  const outcomeOf = (step: Step) => { const last = step.effects[step.effects.length - 1]!; return last.type === "finish" ? last.outcome : undefined; };

  test("410 + status denied -> denied, exit 11, entry and keys dropped", () => {
    const step = run(410, { code: "expired_request", status: "denied", deniedAt: "2026-11-03T12:00:00.000Z" });
    expect(outcomeOf(step)).toEqual({ kind: "denied" });
    expect(exitCodeOf(outcomeOf(step)!)).toBe(11);
    expect(step.state.entry).toBeUndefined();
    expect(step.effects[0]).toMatchObject({ type: "purge", keys: ["relayPrivateKey", "stagedSigningKey"] });
  });
  test("410 code request_denied -> denied", () => {
    expect(outcomeOf(run(410, { code: "request_denied" }))).toEqual({ kind: "denied" });
  });
  test("plain 410 expired_request -> lapsed, exit 3", () => {
    const step = run(410, { code: "expired_request" });
    expect(outcomeOf(step)).toMatchObject({ kind: "lapsed", reason: "expired_request" });
    expect(exitCodeOf(outcomeOf(step)!)).toBe(3);
  });
  test("400 invalid_request -> refused (request invalid), exit 5, never lapsed", () => {
    const step = run(400, { code: "invalid_request" });
    expect(outcomeOf(step)).toMatchObject({ kind: "refused", reason: "request_invalid" });
    expect(exitCodeOf(outcomeOf(step)!)).toBe(5);
  });
});

describe("serverDateSkewMs", () => {
  test("is local minus server: positive when the local clock is ahead", () => {
    expect(serverDateSkewMs("Tue, 03 Nov 2026 12:00:00 GMT", Date.parse("2026-11-03T12:01:30.000Z"))).toBe(90_000);
    expect(serverDateSkewMs("Tue, 03 Nov 2026 12:00:00 GMT", Date.parse("2026-11-03T11:59:00.000Z"))).toBe(-60_000);
  });
  test("a missing, empty or unparseable Date header is unknown (undefined)", () => {
    for (const value of [null, undefined, "", "yesterday-ish"]) expect(serverDateSkewMs(value, T0)).toBeUndefined();
  });
});

describe("callApproval", () => {
  const seed = new Uint8Array(32).fill(7);
  const signingKey: Ed25519PrivateJwk = {
    kty: "OKP", crv: "Ed25519", x: Buffer.from(ed25519.getPublicKey(seed)).toString("base64url"), d: Buffer.from(seed).toString("base64url"),
  };
  const entry = entryIn("open");
  const state: ApprovalRequesterState = {
    requestId: entry.requestId, bodyCid: entry.bodyCid, record: entry.record as ApprovalRequesterState["record"], apiOrigin: entry.apiOrigin, signingKey,
  };
  const asFetch = (fn: () => Promise<Response>): typeof globalThis.fetch => fn as unknown as typeof globalThis.fetch;
  const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  test("returns the classified reply and the skew measured against the HTTP Date header", async () => {
    const result = await callApproval(state, "discover", {}, {
      fetch: asFetch(async () => json({ code: "invalid_proof" }, 401, { date: "Tue, 03 Nov 2026 12:00:00 GMT" })),
      now: () => Date.parse("2026-11-03T12:02:00.000Z"),
    });
    expect(result).toEqual({ reply: { kind: "error", call: "discover", status: 401, code: "invalid_proof" }, serverDateSkewMs: 120_000 });
  });

  test("a network failure is a `network` reply, not an exception", async () => {
    const result = await callApproval(state, "discover", {}, { fetch: asFetch(async () => { throw new TypeError("fetch failed"); }) });
    expect(result.reply).toEqual({ kind: "network" });
  });

  test("an aborted call rethrows the abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(callApproval(state, "discover", {}, { signal: controller.signal, fetch: asFetch(async () => { throw controller.signal.reason; }) })).rejects.toThrow("stop");
  });

  test("a denied answer survives the transport", async () => {
    const result = await callApproval(state, "discover", {}, {
      fetch: asFetch(async () => json({ code: "expired_request", status: "denied", deniedAt: "2026-11-03T12:00:00.000Z" }, 410)),
    });
    expect(result.reply).toMatchObject({ kind: "error", code: "request_denied", status: 410 });
  });

  test("a 202 is pending and a body that is not JSON is `unknown`", async () => {
    expect((await callApproval(state, "discover", {}, { fetch: asFetch(async () => json({ status: "pending" }, 202)) })).reply).toEqual({ kind: "pending" });
    expect((await callApproval(state, "discover", {}, { fetch: asFetch(async () => new Response("<html>bad gateway</html>", { status: 502 })) })).reply)
      .toEqual({ kind: "error", call: "discover", status: 502, code: "unknown" });
  });
});
