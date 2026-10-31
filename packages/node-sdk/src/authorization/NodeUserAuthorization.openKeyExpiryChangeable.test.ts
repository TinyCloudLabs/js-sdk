// TC-2276: a user may change the expiry in the OpenKey approval. The SDK accepts the SIGNED expiry only when the
// request it sent carried `expiryChangeable: true`; every other difference stays refused.

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";

import { NodeUserAuthorization, type PreparedOpenKeyAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";
import { richResultFor, withExpiration } from "../test-support/openkey-result";

let originalFetch: typeof globalThis.fetch;

const calls = { delegate: 0 };

beforeEach(() => {
  calls.delegate = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      calls.delegate++;
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const PRIVATE_KEY = "1".padStart(64, "0");
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function setup(extra: Record<string, unknown> = {}) {
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const storage = new MemorySessionStorage();
  const auth = new NodeUserAuthorization({
    signer,
    wasmBindings: new NodeWasmBindings(),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: storage,
    ...extra,
  });
  const preparation = await auth.prepareSessionForSigning();
  const prepared = {
    siwe: preparation.prepared.siwe,
    jwk: preparation.prepared.jwk,
    spaceId: preparation.prepared.spaceId,
    verificationMethod: preparation.prepared.verificationMethod,
  };
  return { auth, signer, storage, preparation, prepared };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function complete(s: Setup, signedMessage: string, options?: Parameters<NodeUserAuthorization["signInWithOpenKeyResult"]>[4]) {
  return richResultFor(s.signer, signedMessage).then((result) =>
    s.auth.signInWithOpenKeyResult(result, s.prepared, s.preparation.keyId, s.preparation.prepared.jwk, options),
  );
}

const DEFAULT_REFUSAL = "OpenKey signedMessage altered immutable SIWE fields: expirationTime";

describe("without the opt-in", () => {
  for (const [label, offset] of [["a later expiry", 40 * DAY_MS], ["an earlier expiry", 10 * 60_000]] as const) {
    test(`${label} is still refused with the unchanged message`, async () => {
      const s = await setup();
      await expect(complete(s, withExpiration(s.prepared.siwe, iso(offset)))).rejects.toThrow(DEFAULT_REFUSAL);
      expect(s.auth.tinyCloudSession).toBeUndefined();
      expect(await s.storage.load(await s.signer.getAddress())).toBeNull();
    });

    test(`${label} is refused when the option is explicitly false`, async () => {
      const s = await setup();
      await expect(complete(s, withExpiration(s.prepared.siwe, iso(offset)), { expiryChangeable: false })).rejects.toThrow(DEFAULT_REFUSAL);
    });
  }

  test("an unchanged expiry is accepted, as before", async () => {
    const s = await setup();
    const session = await complete(s, s.prepared.siwe);
    expect(session.siwe).toBe(s.prepared.siwe);
  });
});

describe("with the opt-in", () => {
  for (const [label, offset] of [["a later expiry", 40 * DAY_MS], ["an earlier expiry", 10 * 60_000]] as const) {
    test(`${label}: the session is built from the signed message and persists the signed expiry`, async () => {
      const s = await setup();
      const expiry = iso(offset);
      const signed = withExpiration(s.prepared.siwe, expiry);
      const session = await complete(s, signed, { expiryChangeable: true });

      expect(session.siwe).toBe(signed);
      expect(s.auth.tinyCloudSession?.siwe).toBe(signed);
      const persisted = await s.storage.load(await s.signer.getAddress());
      expect(persisted?.expiresAt).toBe(expiry);
      expect(persisted?.siwe).toBe(signed);
      // The prepared expiry (30 days by default) is not what was stored.
      expect(persisted?.expiresAt).not.toBe(/Expiration Time: (.+)/.exec(s.prepared.siwe)?.[1]);
    });
  }

  test("an unchanged expiry is accepted", async () => {
    const s = await setup();
    const session = await complete(s, s.prepared.siwe, { expiryChangeable: true });
    expect(session.siwe).toBe(s.prepared.siwe);
  });

  test("an expiry in the past, inside the 60 second margin, or beyond 10 years is refused and creates no session", async () => {
    // An already-expired message never reaches the expiry check: SIWE verification refuses it first.
    for (const [offset, message] of [
      [-1_000, "OpenKey signature verification failed: Expired message"],
      [30_000, "OpenKey signedMessage expiry must be more than 60 seconds from now"],
      [11 * 365 * DAY_MS, "OpenKey signedMessage expiry is more than 10 years away, the longest this SDK accepts; choose a shorter expiry"],
    ] as const) {
      const s = await setup();
      await expect(complete(s, withExpiration(s.prepared.siwe, iso(offset)), { expiryChangeable: true })).rejects.toThrow(message);
      expect(s.auth.tinyCloudSession).toBeUndefined();
      expect(await s.storage.load(await s.signer.getAddress())).toBeNull();
    }
  });

  test("a changed nonce or Issued At together with a valid expiry is refused with the unchanged message", async () => {
    const s = await setup();
    const valid = withExpiration(s.prepared.siwe, iso(40 * DAY_MS));
    const nonce = valid.replace(/Nonce: .*/, "Nonce: deadbeefdeadbeef");
    await expect(complete(s, nonce, { expiryChangeable: true })).rejects.toThrow("OpenKey signedMessage altered immutable SIWE fields: nonce");
    const issuedAt = valid.replace(/Issued At: .*/, `Issued At: ${iso(-5_000)}`);
    await expect(complete(s, issuedAt, { expiryChangeable: true })).rejects.toThrow("OpenKey signedMessage altered immutable SIWE fields: issuedAt");
    expect(s.auth.tinyCloudSession).toBeUndefined();
  });

  test("a changed domain together with a valid expiry is refused", async () => {
    const s = await setup();
    const signed = withExpiration(s.prepared.siwe, iso(40 * DAY_MS)).replace("example.com wants you", "attacker.example wants you");
    await expect(complete(s, signed, { expiryChangeable: true })).rejects.toThrow(/altered immutable SIWE fields: domain/);
  });

  test("a second Expiration Time line is refused", async () => {
    const s = await setup();
    const valid = withExpiration(s.prepared.siwe, iso(40 * DAY_MS));
    const twice = valid.replace(/(Expiration Time: .*)/, `$1\nExpiration Time: ${iso(10 * 60_000)}`);
    // The SIWE parser refuses a second line before the helper runs; the helper's own one-line rule is pinned in
    // sdk-core (`openkey-changed-expiration.test.ts`, "two Expiration Time lines, whichever one the parser would pick").
    await expect(complete(s, twice, { expiryChangeable: true })).rejects.toThrow(/not a parseable SIWE/);
    expect(s.auth.tinyCloudSession).toBeUndefined();
  });

  test("the ReCap check still applies: a broadened ReCap is refused even with a valid expiry", async () => {
    const s = await setup();
    const valid = withExpiration(s.prepared.siwe, iso(40 * DAY_MS));
    // Drop the real ReCap from the prepared side so the signed one is a broadening.
    const narrowedPrepared = { ...s.prepared, siwe: s.prepared.siwe.replace(/- urn:recap:[A-Za-z0-9_-]+/, "- urn:recap:eyJhdHQiOnt9LCJwcmYiOltdfQ") };
    const result = await richResultFor(s.signer, valid);
    await expect(
      s.auth.signInWithOpenKeyResult(result, narrowedPrepared, s.preparation.keyId, s.preparation.prepared.jwk, { expiryChangeable: true }),
    ).rejects.toThrow(/broadened authorization/);
  });
});

describe("through signInWithOpenKey / prepareOpenKeySignIn", () => {
  async function prepare(options?: { expiryChangeable?: boolean }) {
    const signer = new PrivateKeySigner(PRIVATE_KEY);
    const storage = new MemorySessionStorage();
    const auth = new NodeUserAuthorization({
      signer,
      wasmBindings: new NodeWasmBindings(),
      signStrategy: { type: "auto-sign" },
      domain: "example.com",
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: storage,
    });
    const pending: PreparedOpenKeyAuthorization = await auth.prepareOpenKeySignIn(options);
    return { auth, signer, storage, pending };
  }

  test("the request carries expiryChangeable only when the option is set", async () => {
    expect((await prepare({ expiryChangeable: true })).pending.request.expiryChangeable).toBe(true);
    for (const options of [undefined, {}, { expiryChangeable: false }]) {
      const request = (await prepare(options)).pending.request;
      expect(Object.keys(request)).not.toContain("expiryChangeable");
    }
  });

  test("a prepared request that carried the opt-in accepts a changed expiry on completion", async () => {
    const { auth, signer, storage, pending } = await prepare({ expiryChangeable: true });
    const expiry = iso(40 * DAY_MS);
    const signed = withExpiration(pending.request.siwe, expiry);
    const session = await auth.completeOpenKeySignIn(pending, richResultFor(signer, signed));
    expect(session.siwe).toBe(signed);
    expect((await storage.load(await signer.getAddress()))?.expiresAt).toBe(expiry);
  });

  test("a prepared request without the opt-in refuses the same changed expiry", async () => {
    const { auth, signer, pending } = await prepare();
    const signed = withExpiration(pending.request.siwe, iso(40 * DAY_MS));
    await expect(auth.completeOpenKeySignIn(pending, richResultFor(signer, signed))).rejects.toThrow(DEFAULT_REFUSAL);
  });

  test("signInWithOpenKey sends the opt-in to the authorize function and completes with the signed expiry", async () => {
    const signer = new PrivateKeySigner(PRIVATE_KEY);
    const storage = new MemorySessionStorage();
    const auth = new NodeUserAuthorization({
      signer,
      wasmBindings: new NodeWasmBindings(),
      signStrategy: { type: "auto-sign" },
      domain: "example.com",
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: storage,
    });
    const expiry = iso(10 * 60_000);
    let sent: { expiryChangeable?: boolean } | undefined;
    const session = await auth.signInWithOpenKey(
      async (request) => {
        sent = request;
        return richResultFor(signer, withExpiration(request.siwe, expiry));
      },
      { expiryChangeable: true },
    );
    expect(sent?.expiryChangeable).toBe(true);
    expect(/Expiration Time: (.+)/.exec(session.siwe)?.[1]).toBe(expiry);
    expect((await storage.load(await signer.getAddress()))?.expiresAt).toBe(expiry);
  });

  test("signInWithOpenKey without the option sends no flag and refuses the changed expiry", async () => {
    const signer = new PrivateKeySigner(PRIVATE_KEY);
    const auth = new NodeUserAuthorization({
      signer,
      wasmBindings: new NodeWasmBindings(),
      signStrategy: { type: "auto-sign" },
      domain: "example.com",
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: new MemorySessionStorage(),
    });
    let sent: Record<string, unknown> | undefined;
    await expect(
      auth.signInWithOpenKey(async (request) => {
        sent = request as unknown as Record<string, unknown>;
        return richResultFor(signer, withExpiration(request.siwe, iso(40 * DAY_MS)));
      }),
    ).rejects.toThrow(DEFAULT_REFUSAL);
    expect(Object.keys(sent ?? {})).not.toContain("expiryChangeable");
  });
});

// Review follow-up (TC-2276): an app-level maximum (`maxExpiresAt`), checked before anything is activated.
describe("maxExpiresAt: an app-level maximum for the signed expiry", () => {
  const refusal = /^OpenKey signedMessage expiry is later than the maximum for this request \(the latest allowed is \d{4}-\d{2}-\d{2}T/;

  test("a signed expiry above the maximum is refused BEFORE any session, storage, replica stamp or activation", async () => {
    for (const asMax of [(ms: number) => ms, (ms: number) => new Date(ms), (ms: number) => () => ms]) {
      let stamps = 0;
      const s = await setup({ establishReplicaStamp: async () => { stamps++; return undefined; } });
      calls.delegate = 0;
      const max = Date.now() + DAY_MS;
      await expect(complete(s, withExpiration(s.prepared.siwe, iso(10 * DAY_MS)), { expiryChangeable: true, maxExpiresAt: asMax(max) }))
        .rejects.toThrow(refusal);
      expect(s.auth.tinyCloudSession).toBeUndefined();
      expect(await s.storage.load(await s.signer.getAddress())).toBeNull();
      expect(stamps).toBe(0);
      expect(calls.delegate).toBe(0);
    }
  });

  test("an expiry at or below the maximum is accepted, and the activation then runs", async () => {
    const s = await setup();
    calls.delegate = 0;
    const atMax = new Date(Date.now() + DAY_MS).toISOString();
    const session = await complete(s, withExpiration(s.prepared.siwe, atMax), { expiryChangeable: true, maxExpiresAt: Date.parse(atMax) });
    expect(/Expiration Time: (.+)/.exec(session.siwe)?.[1]).toBe(atMax);
    expect(calls.delegate).toBeGreaterThan(0);
    const t = await setup();
    await complete(t, withExpiration(t.prepared.siwe, iso(10 * 60_000)), { expiryChangeable: true, maxExpiresAt: Date.now() + DAY_MS });
    expect(t.auth.tinyCloudSession).toBeDefined();
  });

  test("a function maximum is read when the result arrives, so a slow approval is not refused for the delay", async () => {
    const signer = new PrivateKeySigner(PRIVATE_KEY);
    const auth = new NodeUserAuthorization({
      signer, wasmBindings: new NodeWasmBindings(), signStrategy: { type: "auto-sign" }, domain: "example.com",
      tinycloudHosts: ["https://tinycloud.test"], sessionStorage: new MemorySessionStorage(),
    });
    // The request asks for 10 minutes. The ceiling is "10 minutes + 30 s from now", evaluated at each call.
    let reads = 0;
    const pending = await auth.prepareOpenKeySignIn({ expiryChangeable: true, maxExpiresAt: () => { reads++; return Date.now() + 10 * 60_000 + 30_000; } });
    expect(reads).toBe(0);
    setSystemTime(new Date(Date.now() + 4 * 60_000));
    try {
      // Approved four minutes later; the user picks nine minutes from then: later than "request time + 10.5 minutes".
      const signed = withExpiration(pending.request.siwe, new Date(Date.now() + 9 * 60_000).toISOString());
      const session = await auth.completeOpenKeySignIn(pending, richResultFor(signer, signed));
      expect(session.siwe).toBe(signed);
      expect(reads).toBe(1);
    } finally {
      setSystemTime();
    }
  });

  test("it is never sent to OpenKey and never persisted", async () => {
    const signer = new PrivateKeySigner(PRIVATE_KEY);
    const storage = new MemorySessionStorage();
    const auth = new NodeUserAuthorization({
      signer, wasmBindings: new NodeWasmBindings(), signStrategy: { type: "auto-sign" }, domain: "example.com",
      tinycloudHosts: ["https://tinycloud.test"], sessionStorage: storage,
    });
    let sent = "";
    await auth.signInWithOpenKey(async (request) => {
      sent = JSON.stringify(request);
      return richResultFor(signer, withExpiration(request.siwe, iso(60 * 60_000)));
    }, { expiryChangeable: true, maxExpiresAt: Date.now() + DAY_MS });
    expect(sent).toContain("expiryChangeable");
    expect(sent).not.toContain("maxExpiresAt");
    const persisted = await storage.load(await signer.getAddress());
    expect(JSON.stringify(persisted)).not.toContain("maxExpiresAt");
  });

  test("a maximum that is not a finite time is refused before OpenKey is asked", async () => {
    const signer = new PrivateKeySigner(PRIVATE_KEY);
    const auth = new NodeUserAuthorization({
      signer, wasmBindings: new NodeWasmBindings(), signStrategy: { type: "auto-sign" }, domain: "example.com",
      tinycloudHosts: ["https://tinycloud.test"], sessionStorage: new MemorySessionStorage(),
    });
    for (const maxExpiresAt of [Number.NaN, new Date(Number.NaN), Number.POSITIVE_INFINITY]) {
      let asked = false;
      await expect(auth.signInWithOpenKey(async () => { asked = true; throw new Error("unreachable"); }, { expiryChangeable: true, maxExpiresAt }))
        .rejects.toThrow(/maxExpiresAt must be/);
      expect(asked).toBe(false);
    }
  });

  test("without the opt-in it is not consulted: a changed expiry is still refused with the unchanged message", async () => {
    const s = await setup();
    await expect(complete(s, withExpiration(s.prepared.siwe, iso(60 * 60_000)), { maxExpiresAt: Date.now() + 2 * 60 * 60_000 }))
      .rejects.toThrow(DEFAULT_REFUSAL);
  });
});

// Review follow-up (TC-2276, pre-existing): the persisted expiry and creation time come from the signed message's own
// lines. A ReCap-bearing statement is not diffed, so a signer can put `Expiration Time: ...` text inside it.
describe("the persisted expiry is the signed Expiration Time line, not text in the statement", () => {
  const injected = " x Expiration Time: 2099-01-01T00:00:00.000Z Issued At: 1999-01-01T00:00:00.000Z";

  test("unchanged expiry", async () => {
    const s = await setup();
    const lines = s.prepared.siwe.split("\n");
    expect(lines[3]).toMatch(/^I further authorize/);
    lines[3] += injected;
    await complete(s, lines.join("\n"));
    const persisted = await s.storage.load(await s.signer.getAddress());
    expect(persisted?.expiresAt).toBe(/^Expiration Time: (.+)$/m.exec(s.prepared.siwe)![1]);
    expect(persisted?.createdAt).toBe(/^Issued At: (.+)$/m.exec(s.prepared.siwe)![1]);
  });

  test("changed expiry with the opt-in", async () => {
    const s = await setup();
    const expiry = iso(2 * DAY_MS);
    const lines = withExpiration(s.prepared.siwe, expiry).split("\n");
    lines[3] += injected;
    await complete(s, lines.join("\n"), { expiryChangeable: true });
    const persisted = await s.storage.load(await s.signer.getAddress());
    expect(persisted?.expiresAt).toBe(expiry);
    expect(persisted?.createdAt).toBe(/^Issued At: (.+)$/m.exec(s.prepared.siwe)![1]);
  });
});
