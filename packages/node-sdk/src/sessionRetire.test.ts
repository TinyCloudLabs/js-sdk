import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { retireSessionKey, retireSessionKeys } from "./session-retire";
import type { SessionRetireSigner } from "./sessionRetire";

const NOW_MS = Date.UTC(2026, 10, 21, 12, 0, 0);

function sessionSigner(): { signer: SessionRetireSigner; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    publicKey,
    signer: {
      verificationMethod: "did:key:z6MkSession#z6MkSession",
      signJwt: async (header, payload) => {
        const input = [header, payload].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
        return `${input}.${edSign(null, Buffer.from(input), privateKey).toString("base64url")}`;
      },
    },
  };
}

type Reply = number | "down" | "not_recorded" | "unflagged" | "skipped" | "refuse_root_2";
interface Seen { host: string; path: string; authorization?: string; keepalive?: boolean; contentType?: string; body?: string }

/** A set of fake nodes: each host answers `/info` with its DID and `/session/retire` from a script of replies. */
function fakeNodes(script: Record<string, Reply[]>) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const host = url.origin;
    const headers = new Headers(init?.headers);
    seen.push({
      host, path: url.pathname, keepalive: init?.keepalive,
      authorization: headers.get("authorization") ?? undefined,
      contentType: headers.get("content-type") ?? undefined,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (url.pathname === "/info") return Response.json({ nodeId: `did:key:node-${url.hostname}` });
    if (url.pathname !== "/session/retire" || init?.method !== "POST") throw new Error(`unexpected ${url.pathname}`);
    const reply = script[host]?.shift() ?? "down";
    if (reply === "down") throw new TypeError("fetch failed");
    if (reply === 200) return Response.json({ did: "did:key:z6MkSession", retiredAt: "2026-11-21T12:00:00Z", recorded: true });
    if (reply === "not_recorded") return Response.json({ did: "did:key:z6MkSession", retiredAt: "2026-11-21T12:00:00Z", recorded: false });
    if (reply === "unflagged") return Response.json({ did: "did:key:z6MkSession", retiredAt: "2026-11-21T12:00:00Z" });
    if (reply === "skipped") return Response.json({ did: "did:key:z6MkSession", retiredAt: "2026-11-21T12:00:00Z", recorded: true, skipped: [0] });
    if (reply === "refuse_root_2") return new Response("session_retire_invalid: delegation 2: its delegatee is not the retiring key", { status: 401 });
    const bodies: Record<number, string> = {
      401: "session_retire_invalid: the audience is not this node",
      503: "session_retire_unavailable: the retire was not recorded",
    };
    return new Response(bodies[reply] ?? "nope", { status: reply });
  }) as typeof globalThis.fetch;
  const retires = (host: string) => seen.filter((entry) => entry.host === host && entry.path === "/session/retire");
  return { fetch, seen, retires };
}

const noSleep = async () => {};

function decode(authorization: string) {
  expect(authorization.startsWith("Bearer ")).toBe(true);
  const [header, payload, signature] = authorization.slice("Bearer ".length).split(".");
  const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  return { header: json(header), payload: json(payload), signingInput: `${header}.${payload}`, signature: Buffer.from(signature, "base64url") };
}

describe("retireSessionKey", () => {
  test("every host acknowledges", async () => {
    const { signer } = sessionSigner();
    const nodes = fakeNodes({ "https://a.test": [200], "https://b.test": [200], "https://c.test": [200] });
    const outcome = await retireSessionKey({
      signer, hosts: ["https://a.test", "https://b.test", "https://c.test", "https://a.test"],
      fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep,
    });
    expect(outcome).toEqual({ confirmed: ["https://a.test", "https://b.test", "https://c.test"], nothingToRecord: [], notConfirmed: [] });
    // Each host is asked once, however often it was listed.
    expect(nodes.retires("https://a.test")).toHaveLength(1);
  });

  test("a host that answers 503 and then 200 is confirmed", async () => {
    const { signer } = sessionSigner();
    const nodes = fakeNodes({ "https://a.test": [200], "https://b.test": [503, 200] });
    const outcome = await retireSessionKey({ signer, hosts: ["https://a.test", "https://b.test"], fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep });
    expect(outcome).toEqual({ confirmed: ["https://a.test", "https://b.test"], nothingToRecord: [], notConfirmed: [] });
    expect(nodes.retires("https://b.test")).toHaveLength(2);
  });

  test("a host that stays down is named, after a bounded number of attempts", async () => {
    const { signer } = sessionSigner();
    const nodes = fakeNodes({ "https://a.test": [200], "https://down.test": [] });
    const waits: number[] = [];
    const outcome = await retireSessionKey({
      signer, hosts: ["https://a.test", "https://down.test"],
      fetch: nodes.fetch, now: () => NOW_MS, sleep: async (ms) => { waits.push(ms); },
    });
    expect(outcome.confirmed).toEqual(["https://a.test"]);
    expect(outcome.notConfirmed).toEqual([{ host: "https://down.test", reason: "unreachable", message: "fetch failed" }]);
    expect(nodes.retires("https://down.test")).toHaveLength(3);
    expect(waits).toEqual([250, 1_000]);
  });

  test("a 401 session_retire_invalid is reported and not retried", async () => {
    const { signer } = sessionSigner();
    const nodes = fakeNodes({ "https://a.test": [401, 200] });
    const outcome = await retireSessionKey({ signer, hosts: ["https://a.test"], fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep });
    expect(outcome).toEqual({
      confirmed: [],
      nothingToRecord: [],
      notConfirmed: [{ host: "https://a.test", reason: "refused", status: 401, message: "session_retire_invalid: the audience is not this node" }],
    });
    expect(nodes.retires("https://a.test")).toHaveLength(1);
  });

  test("a node without the retire route (404) is reported as unsupported and not retried", async () => {
    const { signer } = sessionSigner();
    const nodes = fakeNodes({ "https://old.test": [404, 200] });
    const outcome = await retireSessionKey({ signer, hosts: ["https://old.test"], fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep });
    expect(outcome.notConfirmed).toEqual([{ host: "https://old.test", reason: "unsupported", status: 404, message: "nope" }]);
    expect(nodes.retires("https://old.test")).toHaveLength(1);
  });

  test("a host still answering 429 after every try is not confirmed: failed, with its status", async () => {
    const { signer } = sessionSigner();
    const nodes = fakeNodes({ "https://busy.test": [429, 429, 429] });
    const outcome = await retireSessionKey({ signer, hosts: ["https://busy.test"], fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep });
    expect(outcome.notConfirmed).toEqual([{ host: "https://busy.test", reason: "failed", status: 429, message: "nope" }]);
    expect(nodes.retires("https://busy.test")).toHaveLength(3);
  });

  test("only recorded: true confirms, with or without skipped roots; recorded: false or no flag is reported apart, never as confirmed", async () => {
    const { signer } = sessionSigner();
    const nodes = fakeNodes({ "https://a.test": [200], "https://skip.test": ["skipped"], "https://empty.test": ["not_recorded"], "https://bare.test": ["unflagged"] });
    const outcome = await retireSessionKey({
      signer, hosts: ["https://a.test", "https://skip.test", "https://empty.test", "https://bare.test"], delegations: ["root-1"],
      fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep,
    });
    expect(outcome).toEqual({ confirmed: ["https://a.test", "https://skip.test"], nothingToRecord: ["https://empty.test", "https://bare.test"], notConfirmed: [] });
    // Nothing to retry: the host answered.
    expect(nodes.retires("https://empty.test")).toHaveLength(1);
  });

  test("every root goes to every host in the body, once each", async () => {
    const { signer } = sessionSigner();
    const nodes = fakeNodes({ "https://a.test": [200], "https://b.test": [200] });
    await retireSessionKey({
      signer, hosts: ["https://a.test", "https://b.test"], delegations: ["root-1", "root-2", "root-1"],
      fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep,
    });
    for (const host of ["https://a.test", "https://b.test"]) {
      const [request] = nodes.retires(host);
      expect(request!.contentType).toBe("application/json");
      expect(JSON.parse(request!.body!)).toEqual({ delegations: ["root-1", "root-2"] });
    }
  });

  test("with no roots the request carries no body", async () => {
    const { signer } = sessionSigner();
    const nodes = fakeNodes({ "https://a.test": [200] });
    await retireSessionKey({ signer, hosts: ["https://a.test"], fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep });
    expect(nodes.retires("https://a.test")[0]!.body).toBeUndefined();
  });

  test("more roots than one request holds go in several; the host counts only if every one recorded", async () => {
    const { signer } = sessionSigner();
    const roots = Array.from({ length: 11 }, (_, index) => `root-${index}`);
    const nodes = fakeNodes({
      "https://a.test": [200, 200], "https://b.test": [200, "not_recorded"], "https://c.test": [200, "refuse_root_2", 200],
    });
    const outcome = await retireSessionKey({
      signer, hosts: ["https://a.test", "https://b.test", "https://c.test"], delegations: roots,
      fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep,
    });
    expect(outcome.confirmed).toEqual(["https://a.test"]);
    expect(outcome.nothingToRecord).toEqual(["https://b.test"]);
    // A refused root is named by its place among all roots sent. The host is asked once more without it,
    // and stays unconfirmed even though that recorded.
    expect(outcome.notConfirmed).toEqual([{
      host: "https://c.test", reason: "refused", status: 401, delegation: 10,
      message: "session_retire_invalid: delegation 2: its delegatee is not the retiring key",
    }]);
    const retried = nodes.retires("https://c.test").map((request) => JSON.parse(request.body!).delegations as string[]);
    expect(retried).toEqual([roots.slice(0, 8), roots.slice(8), ["root-8", "root-9"]]);
    const bodies = nodes.retires("https://a.test").map((request) => JSON.parse(request.body!).delegations as string[]);
    expect(bodies.map((body) => body.length)).toEqual([8, 3]);
    expect(bodies.flat()).toEqual(roots);
  });

  test("after a refused root is dropped, the later requests still go; a second refusal is reported in the original numbering and ends the host", async () => {
    const { signer } = sessionSigner();
    const roots = Array.from({ length: 11 }, (_, index) => `root-${index}`);
    const nodes = fakeNodes({ "https://a.test": ["refuse_root_2", 200, 200], "https://b.test": ["refuse_root_2", "refuse_root_2", 200] });
    const outcome = await retireSessionKey({
      signer, hosts: ["https://a.test", "https://b.test"], delegations: roots, fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep,
    });
    const sent = (host: string) => nodes.retires(host).map((request) => JSON.parse(request.body!).delegations as string[]);
    const withoutRoot2 = roots.slice(0, 8).filter((root) => root !== "root-2");
    expect(sent("https://a.test")).toEqual([roots.slice(0, 8), withoutRoot2, roots.slice(8)]);
    // b refuses the retry's third root, root-3: no third try, and the remaining roots are not sent.
    expect(sent("https://b.test")).toEqual([roots.slice(0, 8), withoutRoot2]);
    expect(outcome).toEqual({
      confirmed: [], nothingToRecord: [],
      notConfirmed: [
        { host: "https://a.test", reason: "refused", status: 401, delegation: 2, message: "session_retire_invalid: delegation 2: its delegatee is not the retiring key" },
        { host: "https://b.test", reason: "refused", status: 401, delegation: 3, message: "session_retire_invalid: delegation 2: its delegatee is not the retiring key" },
      ],
    });
  });

  test("the retire UCAN matches the node contract and is signed by the session key", async () => {
    const { signer, publicKey } = sessionSigner();
    const nodes = fakeNodes({ "https://a.test": [503, 200], "https://known.test": [200] });
    await retireSessionKey({
      signer, hosts: ["https://a.test", "https://known.test"],
      knownNodeIds: new Map([["https://known.test", "did:key:registry-node"]]),
      fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep,
    });
    // A DID the caller already knows is used as is; others come from the host's own /info.
    expect(nodes.seen.filter((entry) => entry.path === "/info").map((entry) => entry.host)).toEqual(["https://a.test"]);
    const requests = [...nodes.retires("https://a.test"), ...nodes.retires("https://known.test")];
    // Only a first try is keepalive; a retry would count against the page's keepalive budget.
    expect(requests.map((request) => request.keepalive)).toEqual([true, false, true]);
    const nonces = new Set<string>();
    for (const request of requests) {
      const { header, payload, signingInput, signature } = decode(request.authorization!);
      expect(header).toEqual({ alg: "EdDSA", typ: "JWT", ucv: "0.10.0" });
      expect(Object.keys(payload).sort()).toEqual(["att", "aud", "exp", "iss", "nnc", "prf"]);
      expect(payload.iss).toBe(signer.verificationMethod);
      expect(payload.aud).toBe(request.host === "https://known.test" ? "did:key:registry-node" : "did:key:node-a.test");
      expect(payload.att).toEqual({ "urn:tinycloud:session:self": { "tinycloud.session/retire": [{}] } });
      expect(payload.prf).toEqual([]);
      expect(typeof payload.nnc === "string" && payload.nnc.length > 0).toBe(true);
      nonces.add(payload.nnc);
      const lifetime = payload.exp - NOW_MS / 1000;
      expect(lifetime > 0 && lifetime <= 120).toBe(true);
      expect(edVerify(null, Buffer.from(signingInput), publicKey, signature)).toBe(true);
    }
    // Every attempt, a retry included, carries its own nonce.
    expect(nonces.size).toBe(requests.length);
  });
});

describe("retireSessionKeys", () => {
  test("a host is confirmed when no key failed there and one recorded; any key's failure names the host", async () => {
    const nodes = fakeNodes({
      "https://a.test": [200, "not_recorded"], "https://b.test": [200, 401], "https://c.test": ["not_recorded", "not_recorded"],
    });
    const hosts = ["https://a.test", "https://b.test", "https://c.test"];
    const outcome = await retireSessionKeys([sessionSigner(), sessionSigner()].map(({ signer }) => ({
      signer, hosts, fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep,
    })));
    expect(outcome).toEqual({
      confirmed: ["https://a.test"],
      nothingToRecord: ["https://c.test"],
      notConfirmed: [{ host: "https://b.test", reason: "refused", status: 401, message: "session_retire_invalid: the audience is not this node" }],
    });
  });

  test("first tries are keepalive only while the sign-out's bodies, across keys and hosts, fit one 48 KiB allowance", async () => {
    const hosts = ["https://a.test", "https://b.test", "https://c.test"];
    const script = () => Object.fromEntries(hosts.map((host) => [host, [200, 200] as Reply[]]));
    const nodes = fakeNodes(script());
    // About 10 KB per request: two keys on three hosts would be about 60 KB, past the browser's 64 KiB with any other request.
    const roots = (key: string) => Array.from({ length: 4 }, (_, index) => `${key}-${index}-${"x".repeat(2_500)}`);
    const keys = ["first", "second"].map((key) => ({
      signer: sessionSigner().signer, hosts, delegations: roots(key), fetch: nodes.fetch, now: () => NOW_MS, sleep: noSleep,
    }));
    expect((await retireSessionKeys(keys)).confirmed).toEqual(hosts);
    const requests = nodes.seen.filter((entry) => entry.path === "/session/retire");
    expect(requests).toHaveLength(6);
    const keepalive = requests.filter((request) => request.keepalive);
    expect(keepalive.length).toBe(4);
    expect(keepalive.reduce((total, request) => total + request.body!.length, 0)).toBeLessThanOrEqual(48 * 1024);
  });
});
