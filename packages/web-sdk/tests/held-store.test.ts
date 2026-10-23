import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign as signEd25519 } from "node:crypto";
import { readFileSync } from "node:fs";
import { CredentialError, canonicalDigest, type IKVService } from "@tinycloud/sdk-core";
import { parseIssuerSet } from "@tinycloud/sdk-core/held-credentials";
import {
  HELD_REUSE_MARGIN_MS,
  createHeldStorageReceipt,
  deleteHeldCredential,
  findHeldCredential,
  heldAccountOwner,
  heldRecordKey,
  pruneHeldCredentials,
  storeHeldCredential,
  verifyHeldStorageReceipt,
  type HeldCredentialRecord,
} from "../src/credentials/held-store";

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

// Test-only issuer key. The verifier takes the public half through the issuer set.
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

// Real vector from the S3.1 fixture. Its own issuer set and account, not the test key.
const vector = JSON.parse(
  readFileSync(new URL("../../sdk-core/src/held-credentials/fixtures/held-email-v1/vector.json", import.meta.url), "utf8"),
) as { now: string; account: string; email: string; sdJwt: string; issuerSet: unknown };

const enc = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function disclosure(name: string, value: unknown) {
  const text = enc(JSON.stringify([`salt-${name}`, name, value]));
  return { text, digest: createHash("sha256").update(text, "ascii").digest("base64url") };
}

interface CredentialSpec {
  readonly subject?: string;
  readonly iat?: number;
  readonly exp?: number;
  readonly disclosures?: readonly (readonly [string, unknown])[];
  readonly tamperSignature?: boolean;
}

/** Signs an SD-JWT with the test issuer key. The holder binding matches the subject. */
function makeSdJwt(spec: CredentialSpec = {}): string {
  const subject = spec.subject ?? OWNER_A;
  const disclosures = (spec.disclosures ?? [["email", "alice@example.com"], ["emailDomain", "example.com"]]).map(([n, v]) =>
    disclosure(n, v),
  );
  const iat = spec.iat ?? NOW_S - 1000;
  const payload = {
    iss: ISSUER_DID,
    sub: subject,
    iat,
    nbf: iat,
    exp: spec.exp ?? iat + 365 * DAY,
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
  if (spec.tamperSignature) signature[0] ^= 0x01;
  const jwt = `${signingInput}.${signature.toString("base64url")}`;
  return [jwt, ...disclosures.map((d) => d.text)].join("~") + "~";
}

interface FakeOptions {
  readonly pageSize?: number;
  readonly dropCursor?: boolean;
  readonly putNotOk?: boolean;
  readonly putThrows?: boolean;
  readonly corruptReadback?: boolean;
  readonly getThrows?: boolean;
  readonly readbackPatch?: Readonly<Record<string, unknown>>;
}

interface FakeKv {
  readonly kv: IKVService;
  readonly data: Map<string, unknown>;
  readonly calls: {
    list: Array<{ prefix?: string; cursor?: string }>;
    batchPut: number;
    delete: string[];
  };
}

function fakeKv(options: FakeOptions = {}): FakeKv {
  const data = new Map<string, unknown>();
  const calls = {
    list: [] as Array<{ prefix?: string; cursor?: string }>,
    batchPut: 0,
    delete: [] as string[],
  };
  const kv = {
    async list(opts: { prefix?: string; cursor?: string } = {}) {
      calls.list.push(opts);
      const keys = [...data.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
      const size = options.pageSize ?? Number.MAX_SAFE_INTEGER;
      const start = opts.cursor === undefined ? 0 : Number(opts.cursor);
      const end = start + size;
      const more = end < keys.length;
      return {
        ok: true,
        data: {
          keys: keys.slice(start, end),
          truncated: more,
          nextCursor: more && !options.dropCursor ? String(end) : undefined,
        },
      };
    },
    async get(key: string) {
      if (options.getThrows) throw new Error("kv get failed");
      if (!data.has(key)) return { ok: false, error: { code: "NOT_FOUND" } };
      const stored = data.get(key) as HeldCredentialRecord;
      const served = options.corruptReadback ? { ...stored, credentialDigest: "x" } : { ...stored, ...options.readbackPatch };
      return { ok: true, data: { data: served } };
    },
    async batchPut(items: Array<{ key: string; value: unknown }>) {
      calls.batchPut += 1;
      if (options.putThrows) throw new Error("kv put failed");
      if (options.putNotOk) return { ok: false, error: { code: "X" } };
      for (const item of items) data.set(item.key, item.value);
      return { ok: true };
    },
    async delete(key: string) {
      calls.delete.push(key);
      data.delete(key);
      return { ok: true };
    },
  };
  return { kv: kv as unknown as IKVService, data, calls };
}

type Fake = FakeKv;

async function failureOf(run: () => Promise<unknown>): Promise<CredentialError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CredentialError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function store(fake: Fake, overrides: Partial<{ ownerDid: unknown; sdJwt: unknown; now: Date }> = {}) {
  return storeHeldCredential({
    kv: fake.kv,
    ownerDid: OWNER_A,
    sdJwt: makeSdJwt(),
    now: NOW,
    ...POLICY,
    ...overrides,
  });
}

/** Places a record directly, as an attacker or a stale writer could. Derives a consistent recordId. */
async function placeRaw(fake: Fake, owner: string, credential: string, extra: Record<string, unknown> = {}) {
  const ownerDid = heldAccountOwner(owner);
  const credentialDigest = await canonicalDigest(credential);
  const recordId = await canonicalDigest({ credentialDigest, holderDid: ownerDid });
  const record = {
    type: "TinyCloudHeldCredential",
    version: 1,
    ownerDid,
    recordId,
    credentialDigest,
    credential,
    storedAt: NOW.toISOString(),
    ...extra,
  };
  fake.data.set(heldRecordKey(ownerDid, recordId), record);
  return { record, key: heldRecordKey(ownerDid, recordId) };
}

const findFor = (fake: Fake, email: string, owner = OWNER_A, now = NOW) =>
  findHeldCredential({ kv: fake.kv, ownerDid: owner, email, now, ...POLICY });

describe("store verifies the SD-JWT before writing", () => {
  test("refuses a non-credential string with no write", async () => {
    const fake = fakeKv();
    const error = await failureOf(() => store(fake, { sdJwt: "not-a-credential" }));
    expect(error.code).toBe("VERIFICATION_FAILED");
    expect(fake.calls.batchPut).toBe(0);
  });

  test("refuses a 5,000,000-character SD-JWT before parsing, with no write", async () => {
    const fake = fakeKv();
    const error = await failureOf(() => store(fake, { sdJwt: "A".repeat(5_000_000) }));
    expect(error.code).toBe("VERIFICATION_FAILED");
    expect(error.message).toContain("bad-presentation");
    expect(fake.calls.batchPut).toBe(0);
  });

  test("refuses a credential whose signature does not verify, with no write", async () => {
    const fake = fakeKv();
    const error = await failureOf(() => store(fake, { sdJwt: makeSdJwt({ tamperSignature: true }) }));
    expect(error.code).toBe("VERIFICATION_FAILED");
    expect(error.message).toContain("bad-signature");
    expect(fake.calls.batchPut).toBe(0);
  });

  test("refuses an expired credential with no write", async () => {
    const fake = fakeKv();
    const error = await failureOf(() => store(fake, { sdJwt: makeSdJwt({ exp: NOW_S - 1 }) }));
    expect(error.message).toContain("expired");
    expect(fake.calls.batchPut).toBe(0);
  });

  test("refuses a credential that expires inside the reuse margin", async () => {
    const fake = fakeKv();
    const error = await failureOf(() => store(fake, { sdJwt: makeSdJwt({ exp: NOW_S + HELD_REUSE_MARGIN_MS / 2000 }) }));
    expect(error.code).toBe("VERIFICATION_FAILED");
    expect(fake.calls.batchPut).toBe(0);
  });

  test("refuses a credential that expires exactly at the reuse margin and accepts one second later", async () => {
    const fake = fakeKv();
    const atMargin = NOW_S + HELD_REUSE_MARGIN_MS / 1000;
    const error = await failureOf(() => store(fake, { sdJwt: makeSdJwt({ exp: atMargin }) }));
    expect(error.code).toBe("VERIFICATION_FAILED");
    expect(fake.calls.batchPut).toBe(0);
    await store(fake, { sdJwt: makeSdJwt({ exp: atMargin + 1 }) });
    expect(fake.calls.batchPut).toBe(1);
  });

  test("refuses a signed credential that does not disclose an email claim", async () => {
    const fake = fakeKv();
    const sdJwt = makeSdJwt({ disclosures: [["emailDomain", "example.com"]] });
    const error = await failureOf(() => store(fake, { sdJwt }));
    expect(error.code).toBe("VERIFICATION_FAILED");
    expect(fake.calls.batchPut).toBe(0);
  });

  test("refuses an email that the signed disclosure does not canonically carry", async () => {
    const fake = fakeKv();
    const sdJwt = makeSdJwt({
      disclosures: [
        ["email", "ALICE+tag@Example.com"],
        ["emailDomain", "Example.com"],
      ],
    });
    const error = await failureOf(() => store(fake, { sdJwt }));
    expect(error.code).toBe("VERIFICATION_FAILED");
    expect(error.message).toContain("bad-disclosure");
    expect(fake.calls.batchPut).toBe(0);
  });

  test("refuses a subject that is not the owner as HOLDER_MISMATCH with no write", async () => {
    const fake = fakeKv();
    const error = await failureOf(() => store(fake, { ownerDid: OWNER_B, sdJwt: makeSdJwt({ subject: OWNER_A }) }));
    expect(error.code).toBe("HOLDER_MISMATCH");
    expect(fake.calls.batchPut).toBe(0);
  });

  test("refuses a did:key owner before any write", async () => {
    const fake = fakeKv();
    const error = await failureOf(() => store(fake, { ownerDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" }));
    expect(error.code).toBe("ACTIVE_SESSION_REQUIRED");
    expect(fake.calls.batchPut).toBe(0);
  });

  test("stores under the canonical owner when the owner DID is lowercase", async () => {
    const fake = fakeKv();
    const lowercase = OWNER_A.replace(/0x[0-9a-fA-F]{40}$/, (address) => address.toLowerCase());
    const { record } = await store(fake, { ownerDid: lowercase });
    expect(record.ownerDid).toBe(heldAccountOwner(OWNER_A));
  });
});

describe("round trip", () => {
  test("stores and finds the real vector credential at its own clock", async () => {
    const fake = fakeKv();
    const vectorNow = new Date(vector.now);
    const vectorPolicy = {
      issuerSet: parseIssuerSet(vector.issuerSet as never, { didMethods: { issuer: ["web"] } }),
      acceptedIssuers: [{ issuerDid: ISSUER_DID }],
      didMethods: { issuer: ["web"] },
    };
    const { record, receipt } = await storeHeldCredential({
      kv: fake.kv,
      ownerDid: vector.account,
      sdJwt: vector.sdJwt,
      now: vectorNow,
      ...vectorPolicy,
    });
    expect(record.ownerDid).toBe(heldAccountOwner(vector.account));
    expect(await verifyHeldStorageReceipt(record, receipt, vector.account)).toBe(true);
    const match = await findHeldCredential({
      kv: fake.kv,
      ownerDid: vector.account,
      email: vector.email,
      now: vectorNow,
      ...vectorPolicy,
    });
    expect(match?.verified.claims.email).toBe(vector.email);
  });

  test("finds the record for a mixed-case query, but not for a plus-tag variant", async () => {
    const fake = fakeKv();
    await store(fake);
    expect((await findFor(fake, "ALICE@EXAMPLE.COM"))?.verified.claims.email).toBe("alice@example.com");
    expect(await findFor(fake, "alice+tag@example.com")).toBeUndefined();
  });

  test("receipt compares owner principals and rejects another account", async () => {
    const fake = fakeKv();
    const { record } = await store(fake);
    const receipt = await createHeldStorageReceipt(record);
    const lowerOwner = OWNER_A.replace(/0x[0-9a-fA-F]{40}$/, (address) => address.toLowerCase());
    expect(await verifyHeldStorageReceipt(record, receipt, lowerOwner)).toBe(true);
    expect(await verifyHeldStorageReceipt(record, receipt, OWNER_B)).toBe(false);
  });

  test("receipt refuses a record owned by another account even when the receipt names the checked owner", async () => {
    const { record } = await store(fakeKv());
    const receipt = await createHeldStorageReceipt(record);
    const foreign = { ...record, ownerDid: OWNER_B };
    const forged = { ...receipt, ownerDid: OWNER_A, recordDigest: await canonicalDigest(foreign) };
    expect(await verifyHeldStorageReceipt(foreign, forged, OWNER_A)).toBe(false);
  });

  test("receipt refuses a changed storedAt", async () => {
    const { record } = await store(fakeKv());
    const receipt = await createHeldStorageReceipt(record);
    expect(await verifyHeldStorageReceipt(record, { ...receipt, storedAt: "2001-01-01T00:00:00.000Z" }, OWNER_A)).toBe(false);
  });

  test("receipt refuses a digest that does not cover the record", async () => {
    const { record } = await store(fakeKv());
    const receipt = await createHeldStorageReceipt(record);
    expect(await verifyHeldStorageReceipt(record, { ...receipt, recordDigest: "A".repeat(43) }, OWNER_A)).toBe(false);
  });
});

describe("readback confirms the credential, not the timestamp", () => {
  test("two concurrent stores of the same credential both succeed with one record", async () => {
    const fake = fakeKv();
    const sdJwt = makeSdJwt();
    const [first, second] = await Promise.all([
      store(fake, { sdJwt, now: NOW }),
      store(fake, { sdJwt, now: new Date(NOW.getTime() + 1000) }),
    ]);
    expect(first.record.recordId).toBe(second.record.recordId);
    expect(fake.data.size).toBe(1);
  });

  test("a put that returns not ok is VERIFIED_NOT_SAVED", async () => {
    const error = await failureOf(() => store(fakeKv({ putNotOk: true })));
    expect(error.code).toBe("VERIFIED_NOT_SAVED");
  });

  test("a put that throws is VERIFIED_NOT_SAVED", async () => {
    const error = await failureOf(() => store(fakeKv({ putThrows: true })));
    expect(error.code).toBe("VERIFIED_NOT_SAVED");
  });

  test("a readback that does not match the written credential is VERIFIED_NOT_SAVED", async () => {
    const error = await failureOf(() => store(fakeKv({ corruptReadback: true })));
    expect(error.code).toBe("VERIFIED_NOT_SAVED");
  });

  test("a readback that names another recordId is VERIFIED_NOT_SAVED", async () => {
    const error = await failureOf(() => store(fakeKv({ readbackPatch: { recordId: "A".repeat(43) } })));
    expect(error.code).toBe("VERIFIED_NOT_SAVED");
  });

  test("a readback that names another owner is VERIFIED_NOT_SAVED", async () => {
    const error = await failureOf(() => store(fakeKv({ readbackPatch: { ownerDid: OWNER_B } })));
    expect(error.code).toBe("VERIFIED_NOT_SAVED");
  });

  test("a readback that names the same owner in a different letter case is accepted", async () => {
    const lowerOwner = OWNER_A.replace(/0x[0-9a-fA-F]{40}$/, (address) => address.toLowerCase());
    const { record } = await store(fakeKv({ readbackPatch: { ownerDid: lowerOwner } }));
    expect(record.ownerDid).toBe(lowerOwner);
  });

  test("a get that throws is VERIFIED_NOT_SAVED", async () => {
    const error = await failureOf(() => store(fakeKv({ getThrows: true })));
    expect(error.code).toBe("VERIFIED_NOT_SAVED");
  });

  test("a readback with a different storedAt is accepted, because storedAt is not part of the confirmed identity", async () => {
    const { record } = await store(fakeKv({ readbackPatch: { storedAt: "2001-01-01T00:00:00.000Z" } }));
    expect(record.storedAt).toBe("2001-01-01T00:00:00.000Z");
  });
});

describe("find re-verifies every stored record", () => {
  test("a record whose signature was altered is not returned", async () => {
    const fake = fakeKv();
    await placeRaw(fake, OWNER_A, makeSdJwt({ tamperSignature: true }));
    expect(await findFor(fake, "alice@example.com")).toBeUndefined();
  });

  test("extra email and expiresAt fields are ignored; the verified email and expiry are used", async () => {
    const fake = fakeKv();
    const genuine = makeSdJwt();
    await placeRaw(fake, OWNER_A, genuine, { email: "mallory@example.com", expiresAt: "2099-01-01T00:00:00Z" });
    expect(await findFor(fake, "mallory@example.com")).toBeUndefined();
    const match = await findFor(fake, "alice@example.com");
    expect(match?.verified.expiresAt.getTime()).toBe((NOW_S - 1000 + 365 * DAY) * 1000);
  });

  test("a record stored under a key that does not match its recordId is ignored", async () => {
    const fake = fakeKv();
    const { record } = await placeRaw(fake, OWNER_A, makeSdJwt());
    fake.data.delete(heldRecordKey(OWNER_A, record.recordId));
    fake.data.set(heldRecordKey(OWNER_A, "A".repeat(43)), record);
    expect(await findFor(fake, "alice@example.com")).toBeUndefined();
  });

  test("a record whose ownerDid is another principal is ignored", async () => {
    const fake = fakeKv();
    await placeRaw(fake, OWNER_A, makeSdJwt(), { ownerDid: OWNER_B });
    expect(await findFor(fake, "alice@example.com")).toBeUndefined();
  });

  test("a record within the reuse margin is not offered", async () => {
    const fake = fakeKv();
    await placeRaw(fake, OWNER_A, makeSdJwt({ exp: NOW_S + 300 }));
    expect(await findFor(fake, "alice@example.com")).toBeUndefined();
  });

  test("a record that expires exactly at the reuse margin is not offered; one second later is", async () => {
    const fake = fakeKv();
    await placeRaw(fake, OWNER_A, makeSdJwt({ exp: NOW_S + HELD_REUSE_MARGIN_MS / 1000 }));
    expect(await findFor(fake, "alice@example.com")).toBeUndefined();
    const later = NOW_S + HELD_REUSE_MARGIN_MS / 1000 + 1;
    await placeRaw(fake, OWNER_A, makeSdJwt({ exp: later }));
    expect((await findFor(fake, "alice@example.com"))?.verified.expiresAt.getTime()).toBe(later * 1000);
  });

  test("a non-ASCII letter that lowercases to an ASCII letter does not match the stored email", async () => {
    const fake = fakeKv();
    await placeRaw(fake, OWNER_A, makeSdJwt({ disclosures: [["email", "kelly@example.com"], ["emailDomain", "example.com"]] }));
    expect((await findFor(fake, "kelly@example.com"))?.verified.claims.email).toBe("kelly@example.com");
    expect(await findFor(fake, "\u212Aelly@example.com")).toBeUndefined();
  });

  test("a record whose credentialDigest does not match its credential is ignored", async () => {
    const fake = fakeKv();
    const { record, key } = await placeRaw(fake, OWNER_A, makeSdJwt());
    fake.data.set(key, { ...record, credentialDigest: "A".repeat(43) });
    expect(await findFor(fake, "alice@example.com")).toBeUndefined();
  });

  test("a record whose recordId does not match its credential is ignored, even under its own key", async () => {
    const fake = fakeKv();
    const { record, key } = await placeRaw(fake, OWNER_A, makeSdJwt());
    fake.data.set(key, { ...record, recordId: "A".repeat(43) });
    expect(await findFor(fake, "alice@example.com")).toBeUndefined();
  });

  test("a listing that needs more pages than the limit is refused after the limit", async () => {
    const fake = fakeKv({ pageSize: 1 });
    const prefix = heldRecordKey(OWNER_A, "A".repeat(43)).slice(0, -43);
    for (let i = 0; i < 60; i += 1) fake.data.set(`${prefix}${String(i).padStart(43, "B")}`, {});
    const error = await failureOf(() => findFor(fake, "alice@example.com"));
    expect(error.code).toBe("VERIFICATION_FAILED");
    expect(fake.calls.list.length).toBe(50);
  });

  test("returns the verified record with the latest expiry", async () => {
    const fake = fakeKv();
    await placeRaw(fake, OWNER_A, makeSdJwt({ exp: NOW_S + 2 * DAY }));
    const later = await placeRaw(fake, OWNER_A, makeSdJwt({ exp: NOW_S + 5 * DAY }));
    const match = await findFor(fake, "alice@example.com");
    expect(match?.record.recordId).toBe(later.record.recordId);
  });

  test("is scoped to the owner", async () => {
    const fake = fakeKv();
    await store(fake);
    expect(await findFor(fake, "alice@example.com", OWNER_B)).toBeUndefined();
  });

  test("follows KV cursors across pages", async () => {
    const fake = fakeKv({ pageSize: 2 });
    for (let i = 0; i < 5; i += 1) {
      await store(fake, { sdJwt: makeSdJwt({ disclosures: [["email", `user${i}@example.com`], ["emailDomain", "example.com"]] }) });
    }
    expect((await findFor(fake, "user4@example.com"))?.verified.claims.email).toBe("user4@example.com");
    expect(fake.calls.list.some((call) => call.cursor !== undefined)).toBe(true);
  });

  test("a truncated listing with no cursor is refused loudly", async () => {
    const fake = fakeKv({ pageSize: 1, dropCursor: true });
    await store(fake);
    await placeRaw(fake, OWNER_A, makeSdJwt({ disclosures: [["email", "bob@example.com"], ["emailDomain", "example.com"]] }));
    const error = await failureOf(() => findFor(fake, "alice@example.com"));
    expect(error.code).toBe("VERIFICATION_FAILED");
    expect(fake.calls.list.length).toBe(1);
  });
});

describe("prune deletes only verified expired records and keeps the newest per email", () => {
  test("removes a verified record whose expiry has passed and leaves a tampered record", async () => {
    const fake = fakeKv();
    const expired = await placeRaw(fake, OWNER_A, makeSdJwt({ exp: NOW_S + 3600 }));
    const tampered = await placeRaw(fake, OWNER_A, makeSdJwt({ tamperSignature: true }));
    const removed = await pruneHeldCredentials({
      kv: fake.kv,
      ownerDid: OWNER_A,
      now: new Date(NOW.getTime() + 2 * 3600 * 1000),
      ...POLICY,
    });
    expect(removed).toEqual([heldRecordKey(OWNER_A, expired.record.recordId)]);
    expect(fake.data.has(heldRecordKey(OWNER_A, tampered.record.recordId))).toBe(true);
  });

  test("a forged record cannot evict the genuine one", async () => {
    const fake = fakeKv();
    const genuine = await placeRaw(fake, OWNER_A, makeSdJwt({ exp: NOW_S + 10 * DAY }));
    fake.data.set(heldRecordKey(OWNER_A, "A".repeat(43)), { ...genuine.record, recordId: "A".repeat(43) });
    const removed = await pruneHeldCredentials({ kv: fake.kv, ownerDid: OWNER_A, now: NOW, ...POLICY });
    expect(removed).toEqual([]);
    expect(fake.data.has(genuine.key)).toBe(true);
    expect((await findFor(fake, "alice@example.com"))?.record.recordId).toBe(genuine.record.recordId);
  });

  test("keeps only the newest verified record per email", async () => {
    const fake = fakeKv();
    const older = await placeRaw(fake, OWNER_A, makeSdJwt({ exp: NOW_S + 10 * DAY }));
    const newer = await placeRaw(fake, OWNER_A, makeSdJwt({ exp: NOW_S + 20 * DAY }));
    const removed = await pruneHeldCredentials({ kv: fake.kv, ownerDid: OWNER_A, now: NOW, ...POLICY });
    expect(removed).toEqual([older.key]);
    expect(fake.data.has(newer.key)).toBe(true);
  });

  test("on equal expiry keeps the record with the greater recordId", async () => {
    const fake = fakeKv();
    const first = await placeRaw(fake, OWNER_A, makeSdJwt({ exp: NOW_S + 10 * DAY }));
    const second = await placeRaw(fake, OWNER_A, makeSdJwt({ exp: NOW_S + 10 * DAY }));
    const loser = [first, second].sort((a, b) => (a.record.recordId < b.record.recordId ? -1 : 1))[0];
    const removed = await pruneHeldCredentials({ kv: fake.kv, ownerDid: OWNER_A, now: NOW, ...POLICY });
    expect(removed).toEqual([loser.key]);
  });
});

describe("delete validates recordId before addressing a key", () => {
  test("deletes the key for a valid recordId", async () => {
    const fake = fakeKv();
    const { record, key } = await placeRaw(fake, OWNER_A, makeSdJwt());
    expect(await deleteHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, recordId: record.recordId })).toBe(true);
    expect(fake.calls.delete).toEqual([key]);
  });

  test("refuses any recordId that is not a 43-character base64url digest, with no delete", async () => {
    const fake = fakeKv();
    for (const recordId of ["", "../../records/abc", "A".repeat(42), "A".repeat(44), "A/".repeat(21) + "A"]) {
      const error = await failureOf(() => deleteHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, recordId }));
      expect(error.code).toBe("DESCRIPTOR_INVALID");
    }
    expect(fake.calls.delete).toEqual([]);
  });
});

describe("key layout", () => {
  test("keys are under the owner's lowercase address and the v1/held namespace", () => {
    const id = "A".repeat(43);
    const address = OWNER_A.split(":")[4].toLowerCase();
    expect(heldRecordKey(OWNER_A, id)).toBe(`v1/held/${address}/${id}`);
  });
});

describe("held owner is Ethereum mainnet only", () => {
  const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const refusedCode = (did: unknown): string => {
    try {
      heldAccountOwner(did);
    } catch (error) {
      return error instanceof CredentialError ? error.code : String(error);
    }
    return "no-throw";
  };

  test("chain 1 is accepted and canonicalised to the EIP-55 address", () => {
    expect(heldAccountOwner(`did:pkh:eip155:1:${ADDRESS.toLowerCase()}`)).toBe(`did:pkh:eip155:1:${ADDRESS}`);
  });

  test("chains 137, 0 and 5, non-numeric chains, and did:key owners are refused", () => {
    expect({
      "chain 137": refusedCode(`did:pkh:eip155:137:${ADDRESS}`),
      "chain 0": refusedCode(`did:pkh:eip155:0:${ADDRESS}`),
      "chain 5": refusedCode(`did:pkh:eip155:5:${ADDRESS}`),
      "non-numeric chain": refusedCode(`did:pkh:eip155:one:${ADDRESS}`),
      "did:key": refusedCode("did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH"),
    }).toEqual({
      "chain 137": "ACTIVE_SESSION_REQUIRED",
      "chain 0": "ACTIVE_SESSION_REQUIRED",
      "chain 5": "ACTIVE_SESSION_REQUIRED",
      "non-numeric chain": "ACTIVE_SESSION_REQUIRED",
      "did:key": "ACTIVE_SESSION_REQUIRED",
    });
  });
});
