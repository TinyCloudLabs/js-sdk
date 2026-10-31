// TC-2276: a user may change the expiry in the OpenKey approval. The SDK accepts the SIGNED expiry only when the
// request it sent carried `expiryChangeable: true`; every other difference stays refused.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NodeUserAuthorization, type PreparedOpenKeyAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";
import { richResultFor, withExpiration } from "../test-support/openkey-result";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
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

async function setup() {
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

function complete(s: Setup, signedMessage: string, options?: { expiryChangeable?: boolean }) {
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
    await expect(complete(s, twice, { expiryChangeable: true })).rejects.toThrow();
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
    ).rejects.toThrow();
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
