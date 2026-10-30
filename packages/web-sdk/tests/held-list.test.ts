import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign as signEd25519 } from "node:crypto";
import { CredentialError, canonicalDigest, type IKVService } from "@tinycloud/sdk-core";
import { parseIssuerSet } from "@tinycloud/sdk-core/held-credentials";
import {
  HELD_REUSE_MARGIN_MS,
  findHeldCredential,
  heldAccountOwner,
  heldPrefix,
  heldRecordKey,
  pruneHeldCredentials,
  listHeldEmailCredentials,
  type HeldCredentialRecord,
  type HeldMatch,
} from "../src/credentials/held-store";
import * as subpath from "../src/credentials-subpath";

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

function policy(retiredAt: string | null = null) {
  return {
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
            retiredAt,
            vcts: [VCT],
          },
        ],
      },
      { didMethods: { issuer: ["web"] } },
    ),
    acceptedIssuers: [{ issuerDid: ISSUER_DID }],
    didMethods: { issuer: ["web"] },
  };
}
const POLICY = policy();

const enc = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function disclosure(name: string, value: unknown) {
  const text = enc(JSON.stringify([`salt-${name}`, name, value]));
  return { text, digest: createHash("sha256").update(text, "ascii").digest("base64url") };
}

interface CredentialSpec {
  readonly subject?: string;
  readonly email?: string;
  readonly iat?: number;
  readonly exp?: number;
  readonly statusMethod?: string;
  readonly tamperSignature?: boolean;
}

/** Signs an SD-JWT with the test issuer key. The holder binding matches the subject. */
function makeSdJwt(spec: CredentialSpec = {}): string {
  const subject = spec.subject ?? OWNER_A;
  const email = spec.email ?? "alice@example.com";
  const disclosures = [disclosure("email", email), disclosure("emailDomain", email.split("@")[1])];
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
    status: { method: spec.statusMethod ?? "none" },
    _sd_alg: "sha-256",
    _sd: disclosures.map((d) => d.digest),
  };
  const header = { alg: "EdDSA", typ: "vc+sd-jwt", kid: KID };
  const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
  const signature = signEd25519(null, Buffer.from(signingInput, "ascii"), issuerKeys.privateKey);
  if (spec.tamperSignature) signature[0] ^= 0x01;
  return [`${signingInput}.${signature.toString("base64url")}`, ...disclosures.map((d) => d.text)].join("~") + "~";
}

interface Fake {
  readonly kv: IKVService;
  readonly data: Map<string, unknown>;
  readonly listPrefixes: string[];
  readonly deleted: string[];
}

interface FakeOptions {
  /** `kv.get` rejects for this key (a transport failure that throws). */
  readonly getThrowsFor?: (key: string) => boolean;
  /** `kv.get` resolves `{ ok: false }` with a non-not-found error for this key. */
  readonly getFailsFor?: (key: string) => boolean;
  readonly listThrows?: boolean;
  readonly listFails?: boolean;
  /** Every listed key comes back twice. */
  readonly repeatKeys?: boolean;
  /** The listing claims to be truncated and gives no cursor. */
  readonly truncatedNoCursor?: boolean;
}

/** Keys come back in REVERSE sorted order, so a comparator that ignores recordId cannot pass by luck. */
function fakeKv(options: FakeOptions = {}): Fake {
  const data = new Map<string, unknown>();
  const listPrefixes: string[] = [];
  const deleted: string[] = [];
  const kv = {
    async list(opts: { prefix?: string } = {}) {
      listPrefixes.push(opts.prefix ?? "");
      if (options.listThrows) throw new Error("kv list failed");
      if (options.listFails) return { ok: false, error: { code: "NETWORK_ERROR" } };
      const sorted = [...data.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort().reverse();
      const keys = options.repeatKeys ? sorted.flatMap((k) => [k, k]) : sorted;
      return { ok: true, data: { keys, truncated: options.truncatedNoCursor === true } };
    },
    async get(key: string) {
      if (options.getThrowsFor?.(key)) throw new Error("kv get failed");
      if (options.getFailsFor?.(key)) return { ok: false, error: { code: "NETWORK_ERROR" } };
      if (!data.has(key)) return { ok: false, error: { code: "KV_NOT_FOUND" } };
      return { ok: true, data: { data: structuredClone(data.get(key)) } };
    },
    async delete(key: string) {
      deleted.push(key);
      data.delete(key);
      return { ok: true };
    },
  };
  return { kv: kv as unknown as IKVService, data, listPrefixes, deleted };
}

/** Places a record directly, as a stale writer or an attacker could. Derives a consistent recordId. */
async function place(fake: Fake, owner: string, credential: string, extra: Record<string, unknown> = {}) {
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
  } as HeldCredentialRecord;
  fake.data.set(heldRecordKey(ownerDid, recordId), record);
  return { record, key: heldRecordKey(ownerDid, recordId), recordId };
}

const list = (fake: Fake, owner: unknown = OWNER_A, extra: Record<string, unknown> = {}) =>
  listHeldEmailCredentials({ kv: fake.kv, ownerDid: owner, email: "ignored@example.com", now: NOW, ...POLICY, ...extra });

async function refusalOf(run: () => Promise<unknown>): Promise<CredentialError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CredentialError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("listHeldEmailCredentials is owner-only", () => {
  test("lists only under the owner's own prefix and never sees another account's records", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ email: "a@example.com" }));
    await place(fake, OWNER_B, makeSdJwt({ subject: OWNER_B, email: "b@example.com" }));
    const mine = await list(fake, OWNER_A);
    expect(mine.map((m) => m.email)).toEqual(["a@example.com"]);
    expect(fake.listPrefixes).toEqual([heldPrefix(OWNER_A)]);
    const theirs = await list(fake, OWNER_B);
    expect(theirs.map((m) => m.email)).toEqual(["b@example.com"]);
  });

  test("a record planted under the owner's prefix that belongs to another account is skipped", async () => {
    const fake = fakeKv();
    const foreign = makeSdJwt({ subject: OWNER_B, email: "b@example.com" });
    const credentialDigest = await canonicalDigest(foreign);
    const recordId = await canonicalDigest({ credentialDigest, holderDid: heldAccountOwner(OWNER_B) });
    fake.data.set(heldRecordKey(OWNER_A, recordId), {
      type: "TinyCloudHeldCredential",
      version: 1,
      ownerDid: heldAccountOwner(OWNER_B),
      recordId,
      credentialDigest,
      credential: foreign,
      storedAt: NOW.toISOString(),
    });
    expect(await list(fake, OWNER_A)).toEqual([]);
  });

  test("refuses an owner that is not a chain-1 did:pkh, as the other store functions do", async () => {
    const fake = fakeKv();
    for (const owner of ["did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", "did:pkh:eip155:137:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "", null, 7]) {
      const error = await refusalOf(() => list(fake, owner));
      expect(error.code).toBe("ACTIVE_SESSION_REQUIRED");
    }
    expect(fake.listPrefixes).toEqual([]);
  });

  test("accepts a lowercase owner DID and reads the same records", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt());
    expect(await list(fake, OWNER_A.toLowerCase().replace("did:pkh:eip155:1:0x", "did:pkh:eip155:1:0x"))).toHaveLength(1);
  });
});

describe("the signed subject must be the account being read", () => {
  // The attack shape: the record sits under A's key, says ownerDid A, carries an A-derived recordId, and
  // holds a credential issued for B. Only the subject-to-owner check in verification refuses it.
  test("list: a record under A whose credential was issued for B is not returned; the same shape for A is", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ subject: OWNER_B, email: "b@example.com" }));
    expect(await list(fake, OWNER_A)).toEqual([]);
    const control = fakeKv();
    await place(control, OWNER_A, makeSdJwt({ subject: OWNER_A, email: "a@example.com" }));
    expect(await list(control, OWNER_A)).toHaveLength(1);
  });

  test("find: a record under A whose credential was issued for B is not returned; the same shape for A is", async () => {
    const find = (fake: Fake, email: string) => findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email, now: NOW, ...POLICY });
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ subject: OWNER_B, email: "b@example.com" }));
    expect(await find(fake, "b@example.com")).toBeUndefined();
    const control = fakeKv();
    await place(control, OWNER_A, makeSdJwt({ subject: OWNER_A, email: "a@example.com" }));
    expect((await find(control, "a@example.com"))?.email).toBe("a@example.com");
  });
});

describe("listHeldEmailCredentials: bad records are skipped, an unreadable store is an error", () => {
  test("a record that fails verification is skipped while its valid neighbour is listed", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ email: "forged@example.com", tamperSignature: true }));
    await place(fake, OWNER_A, makeSdJwt({ email: "ok@example.com" }));
    expect((await list(fake)).map((m) => m.email)).toEqual(["ok@example.com"]);
  });

  test("a kv.get that throws for one record propagates; it is not an empty or partial list", async () => {
    let failKey = "";
    const fake = fakeKv({ getThrowsFor: (key) => key === failKey });
    await place(fake, OWNER_A, makeSdJwt({ email: "ok@example.com" }));
    failKey = (await place(fake, OWNER_A, makeSdJwt({ email: "unreadable@example.com" }))).key;
    await expect(list(fake)).rejects.toThrow("kv get failed");
  });

  test("a kv.get that resolves not-ok with a non-not-found error is OFFLINE", async () => {
    let failKey = "";
    const fake = fakeKv({ getFailsFor: (key) => key === failKey });
    await place(fake, OWNER_A, makeSdJwt({ email: "ok@example.com" }));
    failKey = (await place(fake, OWNER_A, makeSdJwt({ email: "unreadable@example.com" }))).key;
    const error = await refusalOf(() => list(fake));
    expect(error.code).toBe("OFFLINE");
  });

  test("a listed key that is gone by the time it is read (not found) is skipped", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ email: "ok@example.com" }));
    const gone = await place(fake, OWNER_A, makeSdJwt({ email: "gone@example.com" }));
    const realGet = fake.kv.get.bind(fake.kv);
    // The key stays in the listing but is deleted before the read.
    (fake.kv as unknown as { get: unknown }).get = async (key: string) => {
      if (key === gone.key) fake.data.delete(key);
      return realGet(key);
    };
    expect((await list(fake)).map((m) => m.email)).toEqual(["ok@example.com"]);
  });

  test("a kv.list that throws propagates", async () => {
    await expect(list(fakeKv({ listThrows: true }))).rejects.toThrow("kv list failed");
  });

  test("a kv.list that resolves not-ok is OFFLINE, not an empty list", async () => {
    const error = await refusalOf(() => list(fakeKv({ listFails: true })));
    expect(error.code).toBe("OFFLINE");
  });

  test("a truncated listing with no cursor is still refused", async () => {
    const fake = fakeKv({ truncatedNoCursor: true });
    await place(fake, OWNER_A, makeSdJwt());
    const error = await refusalOf(() => list(fake));
    expect(error.code).toBe("VERIFICATION_FAILED");
  });
});

describe("a listing that repeats a key", () => {
  test("list returns each record once", async () => {
    const fake = fakeKv({ repeatKeys: true });
    await place(fake, OWNER_A, makeSdJwt({ email: "one@example.com" }));
    await place(fake, OWNER_A, makeSdJwt({ email: "two@example.com" }));
    expect(await list(fake)).toHaveLength(2);
  });

  test("prune does not compare a record with itself and delete the only valid copy", async () => {
    const fake = fakeKv({ repeatKeys: true });
    const { key } = await place(fake, OWNER_A, makeSdJwt({ email: "only@example.com" }));
    expect(await pruneHeldCredentials({ kv: fake.kv, ownerDid: OWNER_A, now: NOW, ...POLICY })).toEqual([]);
    expect(fake.deleted).toEqual([]);
    expect(fake.data.has(key)).toBe(true);
  });

  test("prune still removes a superseded record once, and an expired one once", async () => {
    const fake = fakeKv({ repeatKeys: true });
    const older = await place(fake, OWNER_A, makeSdJwt({ email: "same@example.com", exp: NOW_S + 30 * DAY }));
    const newer = await place(fake, OWNER_A, makeSdJwt({ email: "same@example.com", exp: NOW_S + 60 * DAY }));
    const expired = await place(fake, OWNER_A, makeSdJwt({ email: "old@example.com", iat: NOW_S - 300 * DAY, exp: NOW_S - 1 }));
    const removed = await pruneHeldCredentials({ kv: fake.kv, ownerDid: OWNER_A, now: NOW, ...POLICY });
    expect([...removed].sort()).toEqual([older.key, expired.key].sort());
    expect(fake.data.has(newer.key)).toBe(true);
  });
});

describe("listHeldEmailCredentials returns every valid record", () => {
  test("no records is an empty list", async () => {
    expect(await list(fakeKv())).toEqual([]);
  });

  test("an expired record is excluded and an unexpired one is kept", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ email: "old@example.com", iat: NOW_S - 300 * DAY, exp: NOW_S - 1 }));
    await place(fake, OWNER_A, makeSdJwt({ email: "live@example.com" }));
    expect((await list(fake)).map((m) => m.email)).toEqual(["live@example.com"]);
  });

  test("a record that expires exactly now is excluded; one that outlasts the reuse margin is listed", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ email: "edge@example.com", iat: NOW_S - DAY, exp: NOW_S }));
    expect(await list(fake)).toEqual([]);
    await place(fake, OWNER_A, makeSdJwt({ email: "edge@example.com", iat: NOW_S - DAY, exp: NOW_S + HELD_REUSE_MARGIN_MS / 1000 + 1 }));
    expect(await list(fake)).toHaveLength(1);
  });

  test("the reuse margin boundary is findHeldCredential's: exactly at the margin is excluded, one second later is listed", async () => {
    const marginS = HELD_REUSE_MARGIN_MS / 1000;
    const find = (fake: Fake) => findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW, ...POLICY });
    const atMargin = fakeKv();
    await place(atMargin, OWNER_A, makeSdJwt({ exp: NOW_S + marginS }));
    expect(await list(atMargin)).toEqual([]);
    expect(await find(atMargin)).toBeUndefined();
    const justInside = fakeKv();
    await place(justInside, OWNER_A, makeSdJwt({ exp: NOW_S + marginS - 60 }));
    expect(await list(justInside)).toEqual([]);
    expect(await find(justInside)).toBeUndefined();
    const justOutside = fakeKv();
    await place(justOutside, OWNER_A, makeSdJwt({ exp: NOW_S + marginS + 1 }));
    expect(await list(justOutside)).toHaveLength(1);
    expect((await find(justOutside))?.recordId).toBe((await list(justOutside))[0]!.recordId);
  });

  test("a record whose status is not none (revoked) is excluded", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ email: "revoked@example.com", statusMethod: "revoked" }));
    await place(fake, OWNER_A, makeSdJwt({ email: "ok@example.com" }));
    expect((await list(fake)).map((m) => m.email)).toEqual(["ok@example.com"]);
  });

  test("a record issued at or after the issuer key was retired is excluded (issuer policy)", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ iat: NOW_S - 1000 }));
    expect(await list(fake, OWNER_A, policy(new Date((NOW_S - 2000) * 1000).toISOString().replace(".000Z", "Z")))).toEqual([]);
    expect(await list(fake, OWNER_A, policy(new Date((NOW_S + 2000) * 1000).toISOString().replace(".000Z", "Z")))).toHaveLength(1);
  });

  test("a record from an issuer the caller does not accept is excluded", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt());
    expect(await list(fake, OWNER_A, { acceptedIssuers: [{ issuerDid: "did:web:other.example.com" }] })).toEqual([]);
  });

  test("several valid records come back, all emails, newest issuedAt first", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ email: "middle@example.com", iat: NOW_S - 3000 }));
    await place(fake, OWNER_A, makeSdJwt({ email: "newest@example.com", iat: NOW_S - 100 }));
    await place(fake, OWNER_A, makeSdJwt({ email: "oldest@example.com", iat: NOW_S - 9000 }));
    await place(fake, OWNER_A, makeSdJwt({ email: "middle@example.com", iat: NOW_S - 2000 }));
    const matches = await list(fake);
    expect(matches.map((m) => [m.email, m.issuedAt.getTime() / 1000])).toEqual([
      ["newest@example.com", NOW_S - 100],
      ["middle@example.com", NOW_S - 2000],
      ["middle@example.com", NOW_S - 3000],
      ["oldest@example.com", NOW_S - 9000],
    ]);
  });

  test("equal issuedAt ties break by ascending record id, whatever the listing order", async () => {
    const fake = fakeKv();
    const placed = [] as string[];
    for (let i = 0; i < 6; i += 1) placed.push((await place(fake, OWNER_A, makeSdJwt({ email: `u${i}@example.com`, iat: NOW_S - 500 }))).recordId);
    const first = await list(fake);
    expect(first.map((m) => m.recordId)).toEqual([...placed].sort());
    // Re-insert in the opposite order: the result does not depend on KV order.
    const entries = [...fake.data.entries()].reverse();
    fake.data.clear();
    for (const [key, value] of entries) fake.data.set(key, value);
    expect((await list(fake)).map((m) => m.recordId)).toEqual([...placed].sort());
  });

  test("the email argument is ignored: no filter and no latest-per-email pick", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ email: "same@example.com", iat: NOW_S - 100 }));
    await place(fake, OWNER_A, makeSdJwt({ email: "same@example.com", iat: NOW_S - 200 }));
    await place(fake, OWNER_A, makeSdJwt({ email: "other@example.com", iat: NOW_S - 300 }));
    expect(await list(fake)).toHaveLength(3);
    expect(await list(fake, OWNER_A, { email: "same@example.com" })).toHaveLength(3);
  });
});

describe("listHeldEmailCredentials never throws on a corrupt or unverifiable record", () => {
  test("skips every kind of bad record and still returns the good one", async () => {
    const fake = fakeKv();
    const good = await place(fake, OWNER_A, makeSdJwt({ email: "good@example.com" }));
    const prefix = heldPrefix(OWNER_A);
    fake.data.set(`${prefix}not-an-object`, "garbage");
    fake.data.set(`${prefix}null-value`, null);
    fake.data.set(`${prefix}number`, 7);
    fake.data.set(`${prefix}array`, []);
    fake.data.set(`${prefix}empty-object`, {});
    fake.data.set(`${prefix}wrong-type`, { ...good.record, type: "Other" });
    fake.data.set(`${prefix}credential-not-string`, { ...good.record, credential: { not: "a string" } });
    fake.data.set(`${prefix}credential-not-sdjwt`, { ...good.record, credential: "not.an.sdjwt" });
    fake.data.set(`${prefix}credential-huge`, { ...good.record, credential: "a".repeat(5_000_000) });
    fake.data.set(`${prefix}credential-non-ascii`, { ...good.record, credential: "é~" });
    fake.data.set(`${prefix}owner-garbage`, { ...good.record, ownerDid: "not a did" });
    await place(fake, OWNER_A, makeSdJwt({ tamperSignature: true, email: "forged@example.com" }));
    const matches = await list(fake);
    expect(matches.map((m) => m.email)).toEqual(["good@example.com"]);
  });

  test("a record stored under a key that is not its own recordId is skipped", async () => {
    const fake = fakeKv();
    const { record, key } = await place(fake, OWNER_A, makeSdJwt());
    fake.data.delete(key);
    fake.data.set(heldRecordKey(OWNER_A, "A".repeat(43)), record);
    expect(await list(fake)).toEqual([]);
  });
});

describe("listHeldEmailCredentials reads only the verified credential", () => {
  test("every field the claim screen needs comes from the re-verified credential", async () => {
    const fake = fakeKv();
    const iat = NOW_S - 4000;
    const exp = NOW_S + 90 * DAY;
    const { recordId } = await place(fake, OWNER_A, makeSdJwt({ email: "carol@example.com", iat, exp }));
    const [match, ...rest] = await list(fake);
    expect(rest).toEqual([]);
    expect(match!.recordId).toBe(recordId);
    expect(match!.email).toBe("carol@example.com");
    expect(match!.issuedAt).toEqual(new Date(iat * 1000));
    expect(match!.expiresAt).toEqual(new Date(exp * 1000));
    expect(match!.issuer).toBe(ISSUER_DID);
    expect(match!.verified.claims.email).toBe("carol@example.com");
  });

  test("tampering stored email, expiry, issuer and timestamp fields changes nothing that is returned", async () => {
    const clean = fakeKv();
    const tampered = fakeKv();
    const credential = makeSdJwt({ email: "dave@example.com" });
    await place(clean, OWNER_A, credential);
    await place(tampered, OWNER_A, credential, {
      email: "mallory@example.com",
      emailDomain: "evil.example",
      expiresAt: "2099-01-01T00:00:00Z",
      issuedAt: "2099-01-01T00:00:00Z",
      issuer: "did:web:evil.example",
      storedAt: "1999-01-01T00:00:00Z",
      status: "valid",
    });
    const view = (matches: readonly HeldMatch[]) =>
      matches.map((m) => [m.recordId, m.email, m.issuedAt.toISOString(), m.expiresAt.toISOString(), m.issuer]);
    expect(view(await list(tampered))).toEqual(view(await list(clean)));
    expect(view(await list(tampered))[0]![1]).toBe("dave@example.com");
  });

  test("a tampered stored recordId is never returned: the record is skipped", async () => {
    const fake = fakeKv();
    const { key, record } = await place(fake, OWNER_A, makeSdJwt());
    fake.data.set(key, { ...record, recordId: "B".repeat(43) });
    expect(await list(fake)).toEqual([]);
  });

  test("a stored expiry far in the future does not revive an expired credential", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ iat: NOW_S - 300 * DAY, exp: NOW_S - 1 }), { expiresAt: "2099-01-01T00:00:00Z" });
    expect(await list(fake)).toEqual([]);
  });
});

describe("findHeldCredential is unchanged", () => {
  test("still returns the single latest-expiry match for one email and nothing for another", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ exp: NOW_S + 30 * DAY }));
    const latest = await place(fake, OWNER_A, makeSdJwt({ exp: NOW_S + 60 * DAY }));
    await place(fake, OWNER_A, makeSdJwt({ email: "other@example.com", exp: NOW_S + 90 * DAY }));
    const found = await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "ALICE@example.com", now: NOW, ...POLICY });
    expect(found?.record.recordId).toBe(latest.recordId);
    expect(found?.verified.expiresAt.getTime()).toBe((NOW_S + 60 * DAY) * 1000);
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "nobody@example.com", now: NOW, ...POLICY })).toBeUndefined();
  });

  test("its match now also carries the verified summary fields", async () => {
    const fake = fakeKv();
    const { recordId } = await place(fake, OWNER_A, makeSdJwt());
    const found = await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW, ...POLICY });
    expect(found?.recordId).toBe(recordId);
    expect(found?.email).toBe("alice@example.com");
    expect(found?.issuer).toBe(ISSUER_DID);
  });
});

describe("a caller or config error is thrown, never read as 'no credentials'", () => {
  const find = (fake: Fake, extra: Record<string, unknown> = {}) =>
    findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW, ...POLICY, ...extra });
  const seeded = async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt());
    return fake;
  };
  const plainObjectSet = { issuerSet: {} as unknown as typeof POLICY.issuerSet };

  test("list: an issuer set that did not come from parseIssuerSet throws bad-config", async () => {
    await expect(list(await seeded(), OWNER_A, plainObjectSet)).rejects.toMatchObject({ code: "bad-config" });
  });

  test("find: an issuer set that did not come from parseIssuerSet throws bad-config", async () => {
    await expect(find(await seeded(), plainObjectSet)).rejects.toMatchObject({ code: "bad-config" });
  });

  test("list: an invalid now throws bad-config", async () => {
    await expect(list(await seeded(), OWNER_A, { now: new Date("not a date") })).rejects.toMatchObject({ code: "bad-config" });
  });

  test("find: an invalid now throws bad-config", async () => {
    await expect(find(await seeded(), { now: new Date("not a date") })).rejects.toMatchObject({ code: "bad-config" });
  });

  test("a record that merely fails verification is still skipped, not thrown", async () => {
    const fake = fakeKv();
    await place(fake, OWNER_A, makeSdJwt({ tamperSignature: true }));
    expect(await list(fake)).toEqual([]);
    expect(await find(fake)).toBeUndefined();
  });
});

describe("@tinycloud/web-sdk/credentials entry exposes the held surface", () => {
  test("exports the signer, store and source functions the claim screen needs", () => {
    for (const name of ["createAccountHolderSigner", "storeHeldCredential", "findHeldCredential", "acquireHeldCredential", "listHeldEmailCredentials"] as const) {
      expect(typeof subpath[name]).toBe("function");
    }
    expect(subpath.listHeldEmailCredentials).toBe(listHeldEmailCredentials);
    expect(subpath.findHeldCredential).toBe(findHeldCredential);
  });
});
