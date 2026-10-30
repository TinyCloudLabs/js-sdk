import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign as signEd25519 } from "node:crypto";
import { CredentialError, type IKVService } from "@tinycloud/sdk-core";
import { parseIssuerSet } from "@tinycloud/sdk-core/held-credentials";
import { createEd25519HolderSigner, createMemoryEmailProofPendingStore, EmailProofError } from "@tinycloud/node-sdk/credentials";
import type { EmailProofAcquireInput, EmailProofAcquisition, EmailProofPending, EmailProofProfileId, EmailProofResult } from "@tinycloud/node-sdk/credentials";
import { acquireHeldCredential, acquireHeldCredentialWith, HeldSourceError, scopeHeldPendingStore } from "../src/credentials/held-source";
import type { HeldAcquireStep } from "../src/credentials/held-source";
import { storeHeldCredential } from "../src/credentials/held-store";
import { createAccountHolderSigner } from "../src/credentials/account-holder";

const ISSUER_DID = "did:web:issuer.credentials.org";
const KID = `${ISSUER_DID}#controller`;
const PROFILE = "tinycloud.email-held/v1";
const VCT = "opencredentials.email/v1";
const BINDING = "tinycloud.credentials/account-binding/v1";
const DAY = 86_400;
const NOW = new Date("2026-10-20T00:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const OWNER_A = "did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OWNER_B = "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DID_KEY = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const EMAIL = "alice@example.com";
const sign = async (bytes: Uint8Array) => bytes;

const issuerKeys = generateKeyPairSync("ed25519");
const issuerPublicKey = (issuerKeys.publicKey.export({ format: "jwk" }) as { x: string }).x;

const POLICY = {
  issuerSet: parseIssuerSet(
    {
      format: "tinycloud.credentials-issuers/v1",
      version: 1,
      issuers: [
        {
          alg: "EdDSA",
          issuerDid: ISSUER_DID,
          kid: KID,
          notAfter: null,
          notBefore: "2025-01-01T00:00:00Z",
          profiles: [PROFILE],
          publicKey: issuerPublicKey,
          retiredAt: null,
          vcts: [VCT],
        },
      ],
    },
    { didMethods: { issuer: ["web"] } },
  ),
  acceptedIssuers: [{ issuerDid: ISSUER_DID }],
  didMethods: { issuer: ["web"] },
};

const enc = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function disclosure(name: string, value: unknown) {
  const text = enc(JSON.stringify([`salt-${name}`, name, value]));
  return { text, digest: createHash("sha256").update(text, "ascii").digest("base64url") };
}

/** Signs a held-shaped SD-JWT for `subject` with the test issuer key. */
function makeSdJwt(subject: string = OWNER_A, lifetimeDays = 365): string {
  const disclosures = [["email", EMAIL], ["emailDomain", "example.com"]].map(([n, v]) => disclosure(n as string, v));
  const iat = NOW_S - 1000;
  const payload = {
    iss: ISSUER_DID,
    sub: subject,
    iat,
    nbf: iat,
    exp: iat + lifetimeDays * DAY,
    jti: `urn:uuid:${randomUUID()}`,
    vct: VCT,
    profile: PROFILE,
    profileVersion: 1,
    holderBinding: { did: subject, signingDomain: BINDING },
    status: { method: "none" },
    _sd_alg: "sha-256",
    _sd: disclosures.map((d) => d.digest),
  };
  const header = { alg: "EdDSA", typ: "vc+sd-jwt", kid: KID };
  const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
  const signature = signEd25519(null, Buffer.from(signingInput, "ascii"), issuerKeys.privateKey);
  return [`${signingInput}.${signature.toString("base64url")}`, ...disclosures.map((d) => d.text)].join("~") + "~";
}

interface FakeKv {
  readonly kv: IKVService;
  readonly data: Map<string, unknown>;
  readonly calls: { batchPut: number; list: number };
}

/** Listing override. Receives the 1-based call number; returns a shaped page, or undefined to list every key. */
type ListingOverride = (call: number) => { readonly keys: readonly string[]; readonly truncated: boolean; readonly nextCursor?: string } | undefined;

/** KV with get, list, batchPut and delete. Records writes and listings; `listing` can shape or refuse a listing. */
function fakeKv(listing: ListingOverride = () => undefined): FakeKv {
  const data = new Map<string, unknown>();
  const calls = { batchPut: 0, list: 0 };
  const kv = {
    async list(opts: { prefix?: string } = {}) {
      calls.list += 1;
      const shaped = listing(calls.list);
      if (shaped !== undefined) return { ok: true, data: shaped };
      const keys = [...data.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
      return { ok: true, data: { keys, truncated: false, nextCursor: undefined } };
    },
    async get(key: string) {
      if (!data.has(key)) return { ok: false, error: { code: "NOT_FOUND" } };
      return { ok: true, data: { data: data.get(key) } };
    },
    async batchPut(items: Array<{ key: string; value: unknown }>) {
      calls.batchPut += 1;
      for (const item of items) data.set(item.key, item.value);
      return { ok: true };
    },
    async delete(key: string) {
      data.delete(key);
      return { ok: true };
    },
  };
  return { kv: kv as unknown as IKVService, data, calls };
}

/** Typed as fetch without a cast: Bun's fetch type carries `preconnect`. */
function countingFetch(): { fetch: typeof globalThis.fetch; calls: () => number } {
  let count = 0;
  const impl = async () => {
    count += 1;
    throw new Error("network must not be reached");
  };
  return { fetch: Object.assign(impl, { preconnect: () => {} }) as typeof globalThis.fetch, calls: () => count };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CredentialError || error instanceof EmailProofError) return error.code;
    throw error;
  }
  return "no-throw";
}

const getCode = async () => "000000";

describe("held acquisition refusals happen before network and writes", () => {
  test("a did:key holder is refused ACTIVE_SESSION_REQUIRED with no KV read and no network", async () => {
    const fake = fakeKv();
    const net = countingFetch();
    const holder = createEd25519HolderSigner(DID_KEY, sign);
    const code = await codeOf(() => acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, fetch: net.fetch }));
    expect(code).toBe("ACTIVE_SESSION_REQUIRED");
    expect(fake.calls.list).toBe(0);
    expect(net.calls()).toBe(0);
  });

  test("a session account other than the holder is refused HOLDER_MISMATCH with no network", async () => {
    const fake = fakeKv();
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const code = await codeOf(() =>
      acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, sessionDid: OWNER_B, getCode, fetch: net.fetch }),
    );
    expect(code).toBe("HOLDER_MISMATCH");
    expect(net.calls()).toBe(0);
  });

  test("a session account that differs only in address case is the same principal, not a mismatch", async () => {
    const fake = fakeKv();
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const code = await codeOf(() =>
      acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, sessionDid: OWNER_A.toLowerCase(), getCode, fetch: net.fetch, now: () => NOW }),
    );
    expect(code).toBe("PROFILE_UNAVAILABLE");
    expect(net.calls()).toBe(0);
  });

  test("a cache miss for an account goes to the held profile and is refused PROFILE_UNAVAILABLE with no network and no write", async () => {
    const fake = fakeKv();
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const code = await codeOf(() =>
      acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, fetch: net.fetch, now: () => NOW }),
    );
    expect(code).toBe("PROFILE_UNAVAILABLE");
    expect(net.calls()).toBe(0);
    expect(fake.calls.batchPut).toBe(0);
  });
});

describe("held reuse is owner-scoped and returns stored verified records without network", () => {
  test("a stored verified credential is returned with its verified expiry and no network", async () => {
    const fake = fakeKv();
    const sdJwt = makeSdJwt(OWNER_A);
    await storeHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, sdJwt, now: NOW, ...POLICY });
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const result = await acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, fetch: net.fetch, now: () => NOW });
    expect(result.credential).toBe(sdJwt);
    expect(result.holderDid).toBe(OWNER_A);
    expect(result.expiresAt.getTime()).toBe((NOW_S - 1000 + 365 * DAY) * 1000);
    expect(net.calls()).toBe(0);
  });

  test("the email lookup is case-insensitive", async () => {
    const fake = fakeKv();
    const sdJwt = makeSdJwt(OWNER_A);
    await storeHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, sdJwt, now: NOW, ...POLICY });
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const result = await acquireHeldCredential({ ...POLICY, kv: fake.kv, address: "ALICE@Example.com", holder, getCode, now: () => NOW });
    expect(result.credential).toBe(sdJwt);
  });

  test("another account's stored credential is not returned to a different holder", async () => {
    const fake = fakeKv();
    await storeHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, sdJwt: makeSdJwt(OWNER_A), now: NOW, ...POLICY });
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_B, sign);
    const code = await codeOf(() =>
      acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, fetch: net.fetch, now: () => NOW }),
    );
    expect(code).toBe("PROFILE_UNAVAILABLE");
    expect(net.calls()).toBe(0);
  });
});

const LATER = new Date(NOW.getTime() + 2 * DAY * 1000);
/** One page that says more keys follow, so the listing never ends within the page limit. */
const LIMIT_PAGE = { keys: [], truncated: true, nextCursor: "more" };

async function errorOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("a listing beyond the page limit is pruned once, retried once, then refused typed", () => {
  test("prune deletes the expired records and the one retry reads the store", async () => {
    const fake = fakeKv((call) => (call <= 50 ? LIMIT_PAGE : undefined));
    const valid = makeSdJwt(OWNER_A, 365);
    for (const sdJwt of [makeSdJwt(OWNER_A, 1), makeSdJwt(OWNER_A, 1), valid]) {
      await storeHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, sdJwt, now: NOW, ...POLICY });
    }
    const stored = fake.data.size;
    fake.calls.list = 0;
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const result = await acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, fetch: net.fetch, now: () => LATER });
    expect(result.credential).toBe(valid);
    expect(fake.data.size).toBe(stored - 2);
    expect(fake.calls.list).toBe(52);
    expect(net.calls()).toBe(0);
  });

  test("a refusal that survives the prune and the one retry is held-store-listing-limit, with no further retry", async () => {
    const fake = fakeKv((call) => (call <= 50 || (call > 51 && call <= 101) ? LIMIT_PAGE : undefined));
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const error = await errorOf(() =>
      acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, fetch: net.fetch, now: () => LATER }),
    );
    expect(error).toBeInstanceOf(HeldSourceError);
    expect((error as HeldSourceError).code).toBe("held-store-listing-limit");
    expect((error as HeldSourceError).retryable).toBe(false);
    expect((error as HeldSourceError).message).not.toContain(EMAIL);
    expect(fake.calls.list).toBe(101);
    expect(net.calls()).toBe(0);
  });

  test("prune itself hitting the listing limit is the same typed error, and the retry never runs", async () => {
    const fake = fakeKv((call) => (call <= 100 ? LIMIT_PAGE : undefined));
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const error = await errorOf(() => acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, now: () => LATER }));
    expect(error).toBeInstanceOf(HeldSourceError);
    expect((error as HeldSourceError).code).toBe("held-store-listing-limit");
    expect(fake.calls.list).toBe(100);
  });

  test("a different find error is not swallowed: no prune, no retry, the original code surfaces", async () => {
    const fake = fakeKv((call) => (call === 1 ? { keys: [], truncated: true } : undefined));
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const error = await errorOf(() => acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, now: () => LATER }));
    expect(error).toBeInstanceOf(CredentialError);
    expect(error).not.toBeInstanceOf(HeldSourceError);
    expect((error as CredentialError).code).toBe("VERIFICATION_FAILED");
    expect(fake.calls.list).toBe(1);
  });
});

const V1: EmailProofProfileId = "tinycloud.email-proof/v1";
const OLDER = "2026-10-19T23:58:00.000Z";
const NEWER = "2026-10-19T23:59:00.000Z";

/** A pending request carrying the fields the held scope reads. Live at NOW, so findLive and get return it. */
function pendingOf(profile: EmailProofProfileId, holderDid: string, requestId: string, createdAt: string): EmailProofPending {
  return {
    type: "TinyCloudEmailProofPending",
    version: 1,
    profile,
    address: EMAIL,
    requestId,
    verifier: `verifier-${requestId}`,
    holderDid,
    descriptorDigest: "descriptor",
    requirementDigest: "requirement",
    openerOrigin: "https://app.example",
    createdAt,
    expiresAt: "2026-10-20T00:05:00.000Z",
  };
}

/** Acquisition step that records its input and returns the given acquisition. */
function stepReturning(result: EmailProofAcquisition, seen: EmailProofAcquireInput[] = []): HeldAcquireStep {
  return async (input) => {
    seen.push(input);
    return result;
  };
}

/** Issued acquisition. Only `envelope.credential` and `expiresAt` are read by the held seam, so the other result fields are not built. */
function issued(credential: string): EmailProofAcquisition {
  const result = { envelope: { credential }, expiresAt: "2027-10-20T00:00:00.000Z" } as unknown as EmailProofResult;
  return { status: "issued", result, warnings: [] };
}

describe("held acquisition success branch through the injected seam", () => {
  test("issued: the held profile is used, the credential is stored, and the receipt is returned", async () => {
    const fake = fakeKv();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const seen: EmailProofAcquireInput[] = [];
    const credential = makeSdJwt(OWNER_A);
    const receipt = await acquireHeldCredentialWith(
      { ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode: async () => "12345678", now: () => NOW },
      stepReturning(issued(credential), seen),
    );
    expect(seen.map((input) => input.profile)).toEqual([PROFILE]);
    expect(receipt.credential).toBe(credential);
    expect(receipt.holderDid).toBe(OWNER_A);
    expect(receipt.expiresAt).toEqual(new Date((NOW_S - 1000 + 365 * DAY) * 1000));
    expect(fake.calls.batchPut).toBe(1);

    const cached = await acquireHeldCredentialWith(
      { ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode: async () => "12345678", now: () => NOW },
      async () => {
        throw new Error("a stored credential must be reused without acquisition");
      },
    );
    expect(cached.credential).toBe(credential);
  });

  test("the receipt's expiresAt is the signed exp, whatever the witness response says", async () => {
    const fake = fakeKv();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const credential = makeSdJwt(OWNER_A);
    const lying = { envelope: { credential }, expiresAt: "2099-01-01T00:00:00.000Z" } as unknown as EmailProofResult;
    const receipt = await acquireHeldCredentialWith(
      { ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode: async () => "12345678", now: () => NOW },
      stepReturning({ status: "issued", result: lying, warnings: [] }),
    );
    expect(receipt.expiresAt).toEqual(new Date((NOW_S - 1000 + 365 * DAY) * 1000));
    expect(receipt.expiresAt.getTime()).not.toBe(new Date("2099-01-01T00:00:00.000Z").getTime());
  });

  test("a store failure after a verified issue surfaces VERIFIED_NOT_SAVED", async () => {
    const fake = fakeKv();
    const failing = { ...fake.kv, batchPut: async () => { throw new Error("write refused"); } } as unknown as IKVService;
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const code = await codeOf(() =>
      acquireHeldCredentialWith(
        { ...POLICY, kv: failing, address: EMAIL, holder, getCode: async () => "12345678", now: () => NOW },
        stepReturning(issued(makeSdJwt(OWNER_A))),
      ),
    );
    expect(code).toBe("VERIFIED_NOT_SAVED");
  });

  test("a non-issued acquisition is refused as PROOF_REJECTED and nothing is stored", async () => {
    const fake = fakeKv();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const code = await codeOf(() =>
      acquireHeldCredentialWith(
        { ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode: async () => "12345678", now: () => NOW },
        stepReturning({ status: "code-requested", pending: pendingOf(PROFILE, OWNER_A, "held-1", NEWER) }),
      ),
    );
    expect(code).toBe("PROOF_REJECTED");
    expect(fake.calls.batchPut).toBe(0);
  });
});

describe("held pending scope shares the store with the did:key flow", () => {
  test("a newer v1 pending for the address is not resumed by a held acquisition, and survives it", async () => {
    const store = createMemoryEmailProofPendingStore();
    await store.put(pendingOf(PROFILE, OWNER_A, "held-a", OLDER));
    await store.put(pendingOf(V1, OWNER_A, "v1-a", NEWER));
    const fake = fakeKv();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    let prompted = 0;
    let found: EmailProofPending | undefined;
    const code = await codeOf(() =>
      acquireHeldCredentialWith(
        {
          ...POLICY,
          kv: fake.kv,
          address: EMAIL,
          holder,
          pendingStore: store,
          getCode: async () => {
            prompted += 1;
            return "12345678";
          },
          now: () => NOW,
        },
        async (input) => {
          found = await input.pendingStore?.findLive(input.address, NOW);
          return { status: "code-requested", pending: pendingOf(PROFILE, OWNER_A, "probe", NEWER) };
        },
      ),
    );
    expect(found).toBeUndefined();
    expect(prompted).toBe(0);
    expect(code).toBe("PROOF_REJECTED");
    expect(await store.get("v1-a", NOW)).toBeDefined();
  });

  test("a held pending is found for its own holder even when an older v1 pending exists", async () => {
    const store = createMemoryEmailProofPendingStore();
    await store.put(pendingOf(V1, OWNER_A, "v1-a", OLDER));
    await store.put(pendingOf(PROFILE, OWNER_A, "held-a", NEWER));
    const scoped = scopeHeldPendingStore(store, OWNER_A, () => NOW);
    expect((await scoped?.findLive(EMAIL, NOW))?.requestId).toBe("held-a");
  });

  test("a held pending of another holder is never returned", async () => {
    const store = createMemoryEmailProofPendingStore();
    await store.put(pendingOf(PROFILE, OWNER_B, "held-b", NEWER));
    const scoped = scopeHeldPendingStore(store, OWNER_A, () => NOW);
    expect(await scoped?.findLive(EMAIL, NOW)).toBeUndefined();
    expect(await scoped?.get("held-b", NOW)).toBeUndefined();
  });

  test("holder match is by principal: a lowercase holder did owns the pending", async () => {
    const store = createMemoryEmailProofPendingStore();
    await store.put(pendingOf(PROFILE, OWNER_A.toLowerCase(), "held-a", NEWER));
    const scoped = scopeHeldPendingStore(store, OWNER_A, () => NOW);
    expect((await scoped?.findLive(EMAIL, NOW))?.requestId).toBe("held-a");
  });

  test("get never returns a v1 pending, and a held pending only to its own holder", async () => {
    const store = createMemoryEmailProofPendingStore();
    await store.put(pendingOf(V1, OWNER_A, "v1-a", NEWER));
    await store.put(pendingOf(PROFILE, OWNER_A, "held-a", NEWER));
    const own = scopeHeldPendingStore(store, OWNER_A, () => NOW);
    const other = scopeHeldPendingStore(store, OWNER_B, () => NOW);
    expect(await own?.get("v1-a", NOW)).toBeUndefined();
    expect((await own?.get("held-a", NOW))?.requestId).toBe("held-a");
    expect(await other?.get("held-a", NOW)).toBeUndefined();
  });

  test("delete never removes a v1 pending, nor a pending of another holder", async () => {
    const store = createMemoryEmailProofPendingStore();
    await store.put(pendingOf(V1, OWNER_A, "v1-a", NEWER));
    await store.put(pendingOf(PROFILE, OWNER_A, "held-a", NEWER));
    const own = scopeHeldPendingStore(store, OWNER_A, () => NOW);
    const other = scopeHeldPendingStore(store, OWNER_B, () => NOW);
    await own?.delete("v1-a");
    await other?.delete("held-a");
    expect(await store.get("v1-a", NOW)).toBeDefined();
    expect(await store.get("held-a", NOW)).toBeDefined();
  });

  test("delete removes the holder's own held pending", async () => {
    const store = createMemoryEmailProofPendingStore();
    await store.put(pendingOf(PROFILE, OWNER_A, "held-a", NEWER));
    const own = scopeHeldPendingStore(store, OWNER_A, () => NOW);
    await own?.delete("held-a");
    expect(await store.get("held-a", NOW)).toBeUndefined();
  });
});
