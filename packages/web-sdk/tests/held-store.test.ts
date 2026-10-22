import { describe, expect, test } from "bun:test";
import type { IKVService } from "@tinycloud/sdk-core";
import { toChecksumAddress, type VerifiedHeldCredential } from "@tinycloud/sdk-core/held-credentials";
import {
  HELD_REUSE_MARGIN_MS,
  createHeldStorageReceipt,
  deleteHeldCredential,
  findHeldCredential,
  heldRecordKey,
  pruneHeldCredentials,
  storeHeldCredential,
  verifyHeldStorageReceipt,
  type HeldCredentialRecord,
} from "../src/credentials/held-store";

const RAW_ADDRESS_A = "0xabcdef0123456789abcdef0123456789abcdef01";
const RAW_ADDRESS_B = "0x1111222233334444555566667777888899990000";
const OWNER_A = `did:pkh:eip155:1:${toChecksumAddress(RAW_ADDRESS_A)}`;
const OWNER_B = `did:pkh:eip155:1:${toChecksumAddress(RAW_ADDRESS_B)}`;
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const NOW_DATE = new Date(NOW);
const HOUR = 3_600_000;

interface FakeKv {
  readonly kv: IKVService;
  readonly data: Map<string, unknown>;
  readonly calls: { list: number; get: number; batchPut: number; delete: number };
}

interface FakeOptions {
  readonly truncated?: boolean;
  readonly corruptPut?: (value: unknown) => unknown;
  readonly failPut?: boolean;
}

function fakeKv(options: FakeOptions = {}): FakeKv {
  const data = new Map<string, unknown>();
  const calls = { list: 0, get: 0, batchPut: 0, delete: 0 };
  const kv = {
    list: async (opts?: { prefix?: string }) => {
      calls.list += 1;
      const prefix = opts?.prefix ?? "";
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix));
      return { ok: true, data: { keys, truncated: options.truncated ?? false } };
    },
    get: async (key: string) => {
      calls.get += 1;
      if (!data.has(key)) return { ok: false, error: { code: "NOT_FOUND", message: key } };
      return { ok: true, data: { data: data.get(key), headers: { etag: `etag-${key}` } } };
    },
    batchPut: async (items: Array<{ key: string; value: unknown }>) => {
      calls.batchPut += 1;
      if (options.failPut) return { ok: false, error: { code: "PUT_FAILED", message: "put" } };
      for (const item of items) data.set(item.key, options.corruptPut ? options.corruptPut(item.value) : item.value);
      return { ok: true, data: { written: items.length } };
    },
    delete: async (key: string) => {
      calls.delete += 1;
      if (!data.delete(key)) return { ok: false, error: { code: "NOT_FOUND", message: key } };
      return { ok: true, data: undefined };
    },
  };
  return { kv: kv as unknown as IKVService, data, calls };
}

function verified(input: { email?: string; expiresAt?: Date; subject?: string; credentialId?: string; omitEmail?: boolean }): VerifiedHeldCredential {
  return {
    issuer: "did:web:issuer.example",
    subject: input.subject ?? OWNER_A,
    subjectAddress: toChecksumAddress(RAW_ADDRESS_A),
    expiresAt: input.expiresAt ?? new Date(NOW + 2 * HOUR),
    credentialId: input.credentialId ?? "cred-1",
    profile: "held-email",
    profileVersion: 1,
    vct: "urn:tinycloud:held-email:v1",
    claims: input.omitEmail ? {} : { email: input.email ?? "alice@example.com" },
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return errorCode(error);
  }
}

async function storeOne(fake: FakeKv, options: { owner?: string; email?: string; expiresAt?: Date; sdJwt?: string; credentialId?: string } = {}) {
  return storeHeldCredential({
    kv: fake.kv,
    verified: verified({ email: options.email, expiresAt: options.expiresAt, subject: options.owner, credentialId: options.credentialId }),
    sdJwt: options.sdJwt ?? "sd-jwt-1",
    ownerDid: options.owner ?? OWNER_A,
    now: NOW_DATE,
  });
}

describe("held store round trip", () => {
  test("stored record is found under the owner's prefix and keyed by recordId", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake);
    expect(fake.data.has(heldRecordKey(OWNER_A, record.recordId))).toBe(true);
    expect(record.recordId.length).toBeGreaterThan(0);
    const found = await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE });
    expect(found?.recordId).toBe(record.recordId);
  });
});

describe("M1 owner isolation", () => {
  test("two owners with the same email keep separate records; reads return only the caller's", async () => {
    const fake = fakeKv();
    const a = await storeOne(fake, { owner: OWNER_A, sdJwt: "sd-a" });
    const b = await storeOne(fake, { owner: OWNER_B, sdJwt: "sd-b" });
    expect(a.record.recordId).not.toBe(b.record.recordId);
    expect(fake.data.size).toBe(2);
    const foundA = await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE });
    const foundB = await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_B, email: "alice@example.com", now: NOW_DATE });
    expect(foundA?.recordId).toBe(a.record.recordId);
    expect(foundB?.recordId).toBe(b.record.recordId);
  });

  test("J1: a record stored by A is not returned to B and does not overwrite A", async () => {
    const fake = fakeKv();
    const a = await storeOne(fake, { owner: OWNER_A });
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_B, email: "alice@example.com", now: NOW_DATE })).toBeUndefined();
    await storeOne(fake, { owner: OWNER_B });
    const stillA = await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE });
    expect(stillA?.recordId).toBe(a.record.recordId);
  });
});

describe("M2 exact email, ASCII-lowercase only", () => {
  test("requested Alice@Example.com matches stored alice@example.com", async () => {
    const fake = fakeKv();
    await storeOne(fake, { email: "alice@example.com" });
    const found = await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "Alice@Example.com", now: NOW_DATE });
    expect(found?.email).toBe("alice@example.com");
  });

  test("mixed-case claim is stored lowercased and still matches a lowercase request", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake, { email: "Alice@Example.com" });
    expect(record.email).toBe("alice@example.com");
    expect((await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE }))?.recordId).toBe(record.recordId);
  });
});

describe("M3 no provider-specific folding", () => {
  test("plus-tag and gmail-dot variants do not match", async () => {
    const fake = fakeKv();
    await storeOne(fake, { email: "alice@gmail.com" });
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice+x@gmail.com", now: NOW_DATE })).toBeUndefined();
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "a.lice@gmail.com", now: NOW_DATE })).toBeUndefined();
  });
});

describe("M4 expiry at or before now is skipped", () => {
  test("expiresAt equal to now is not returned", async () => {
    const fake = fakeKv();
    await storeOne(fake, { expiresAt: new Date(NOW) });
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE })).toBeUndefined();
  });

  test("expiresAt before now is not returned", async () => {
    const fake = fakeKv();
    await storeOne(fake, { expiresAt: new Date(NOW - 1) });
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE })).toBeUndefined();
  });
});

describe("M5 near-expiry margin", () => {
  test("remaining lifetime just under 600 s is skipped", async () => {
    const fake = fakeKv();
    await storeOne(fake, { expiresAt: new Date(NOW + HELD_REUSE_MARGIN_MS - 1) });
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE })).toBeUndefined();
  });

  test("remaining lifetime of exactly 600 s is returned", async () => {
    const fake = fakeKv();
    await storeOne(fake, { expiresAt: new Date(NOW + HELD_REUSE_MARGIN_MS) });
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE })).toBeDefined();
  });
});

describe("M6 receipt principal check", () => {
  test("receipt naming a different owner fails verification", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake);
    const receipt = await createHeldStorageReceipt(record);
    expect(await verifyHeldStorageReceipt(record, receipt, OWNER_A)).toBe(true);
    expect(await verifyHeldStorageReceipt(record, { ...receipt, ownerDid: OWNER_B }, OWNER_A)).toBe(false);
  });

  test("receipt for the same owner with different address case verifies", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake);
    const receipt = await createHeldStorageReceipt(record);
    const lowercaseOwner = `did:pkh:eip155:1:${RAW_ADDRESS_A}`;
    expect(await verifyHeldStorageReceipt(record, { ...receipt, ownerDid: lowercaseOwner }, OWNER_A)).toBe(true);
  });
});

describe("M7 readback mismatch refuses the store", () => {
  test("stored value that differs on readback yields VERIFIED_NOT_SAVED", async () => {
    const fake = fakeKv({ corruptPut: (value) => ({ ...(value as object), email: "mallory@example.com" }) });
    expect(await codeOf(storeOne(fake))).toBe("VERIFIED_NOT_SAVED");
  });

  test("failed batchPut yields VERIFIED_NOT_SAVED", async () => {
    const fake = fakeKv({ failPut: true });
    expect(await codeOf(storeOne(fake))).toBe("VERIFIED_NOT_SAVED");
  });
});

describe("M8/M9/J2 refuse without an account owner, with zero KV calls", () => {
  test("did:key holder is refused by store and find", async () => {
    const fake = fakeKv();
    const didKey = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
    expect(await codeOf(storeOne(fake, { owner: didKey }))).toBe("ACTIVE_SESSION_REQUIRED");
    expect(await codeOf(findHeldCredential({ kv: fake.kv, ownerDid: didKey, email: "alice@example.com", now: NOW_DATE }))).toBe("ACTIVE_SESSION_REQUIRED");
    expect(fake.calls).toEqual({ list: 0, get: 0, batchPut: 0, delete: 0 });
  });

  test("no account owner: store refused with zero batchPut", async () => {
    const fake = fakeKv();
    const result = await codeOf(
      storeHeldCredential({ kv: fake.kv, verified: verified({}), sdJwt: "sd", ownerDid: undefined, now: NOW_DATE }),
    );
    expect(result).toBe("ACTIVE_SESSION_REQUIRED");
    expect(fake.calls.batchPut).toBe(0);
    expect(fake.data.size).toBe(0);
  });

  test("claim without email is refused before any write", async () => {
    const fake = fakeKv();
    const result = await codeOf(storeHeldCredential({ kv: fake.kv, verified: verified({ omitEmail: true }), sdJwt: "sd", ownerDid: OWNER_A, now: NOW_DATE }));
    expect(result).toBe("VERIFICATION_FAILED");
    expect(fake.calls.batchPut).toBe(0);
  });
});

describe("M10 delete removes only the named record", () => {
  test("deleting one record leaves the other owner-scoped record in place", async () => {
    const fake = fakeKv();
    const first = await storeOne(fake, { email: "alice@example.com", sdJwt: "sd-1" });
    const second = await storeOne(fake, { email: "bob@example.com", sdJwt: "sd-2" });
    expect(await deleteHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, recordId: first.record.recordId })).toBe(true);
    expect(fake.data.has(heldRecordKey(OWNER_A, first.record.recordId))).toBe(false);
    expect(fake.data.has(heldRecordKey(OWNER_A, second.record.recordId))).toBe(true);
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "bob@example.com", now: NOW_DATE })).toBeDefined();
  });
});

describe("M11 owner compare uses principal equality", () => {
  test("lowercase address variant of a checksummed owner finds the same record", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake);
    const lowercaseOwner = `did:pkh:eip155:1:${RAW_ADDRESS_A}`;
    const found = await findHeldCredential({ kv: fake.kv, ownerDid: lowercaseOwner, email: "alice@example.com", now: NOW_DATE });
    expect(found?.recordId).toBe(record.recordId);
  });
});

describe("M12 email-proof records are not returned by the held reader", () => {
  test("a held-shaped record under v1/records/ is ignored", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake);
    fake.data.set("v1/records/elsewhere", { ...record, recordId: "elsewhere" });
    fake.data.delete(heldRecordKey(OWNER_A, record.recordId));
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE })).toBeUndefined();
  });

  test("a record stored under a key that does not match its recordId is ignored", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake);
    fake.data.delete(heldRecordKey(OWNER_A, record.recordId));
    fake.data.set(heldRecordKey(OWNER_A, "misplaced"), record);
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE })).toBeUndefined();
  });
});

describe("prune and refresh", () => {
  test("expired records are removed and only the newest unexpired record per email is kept", async () => {
    const fake = fakeKv();
    const expired = await storeOne(fake, { sdJwt: "sd-expired", expiresAt: new Date(NOW - 1), credentialId: "c-expired" });
    const older = await storeOne(fake, { sdJwt: "sd-older", expiresAt: new Date(NOW + HOUR), credentialId: "c-older" });
    const newer = await storeOne(fake, { sdJwt: "sd-newer", expiresAt: new Date(NOW + 2 * HOUR), credentialId: "c-newer" });
    const removed = await pruneHeldCredentials({ kv: fake.kv, ownerDid: OWNER_A, now: NOW_DATE });
    expect([...removed].sort()).toEqual(
      [heldRecordKey(OWNER_A, expired.record.recordId), heldRecordKey(OWNER_A, older.record.recordId)].sort(),
    );
    expect(fake.data.has(heldRecordKey(OWNER_A, newer.record.recordId))).toBe(true);
    expect(fake.data.size).toBe(1);
  });

  test("a truncated listing prunes nothing", async () => {
    const fake = fakeKv({ truncated: true });
    await storeOne(fake, { sdJwt: "sd-x", expiresAt: new Date(NOW - 1) });
    expect(await pruneHeldCredentials({ kv: fake.kv, ownerDid: OWNER_A, now: NOW_DATE })).toEqual([]);
    expect(fake.calls.delete).toBe(0);
  });
});

describe("J3 held records stay on the held prefix", () => {
  test("every stored held key begins with v1/held/ and none begins with v1/records/", async () => {
    const fake = fakeKv();
    await storeOne(fake);
    const keys = [...fake.data.keys()];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith("v1/held/")).toBe(true);
      expect(key.startsWith("v1/records/")).toBe(false);
    }
  });
});

describe("type shape", () => {
  test("stored record carries the held type tag and a store timestamp", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake);
    const typed: HeldCredentialRecord = record;
    expect(typed.type).toBe("TinyCloudHeldCredential");
    expect(typed.storedAt).toBe(NOW_DATE.toISOString());
  });
});

describe("owner filter inside the prefix", () => {
  test("a record whose ownerDid names another account is ignored even under this owner's prefix", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake, { owner: OWNER_B });
    fake.data.delete(heldRecordKey(OWNER_B, record.recordId));
    fake.data.set(heldRecordKey(OWNER_A, record.recordId), record);
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE })).toBeUndefined();
  });

  test("a record whose ownerDid is the same account in lowercase is still matched", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake);
    const lowercased: HeldCredentialRecord = { ...record, ownerDid: `did:pkh:eip155:1:${RAW_ADDRESS_A}` };
    fake.data.set(heldRecordKey(OWNER_A, record.recordId), lowercased);
    const found = await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE });
    expect(found?.recordId).toBe(record.recordId);
  });
});

describe("verify compares the record owner by principal", () => {
  test("a record whose ownerDid is the lowercase form of the same account still verifies", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake);
    const lowercased: HeldCredentialRecord = { ...record, ownerDid: `did:pkh:eip155:1:${RAW_ADDRESS_A}` };
    const receipt = await createHeldStorageReceipt(lowercased);
    expect(await verifyHeldStorageReceipt(lowercased, receipt, OWNER_A)).toBe(true);
  });
});

describe("find returns the latest expiry", () => {
  test("among two valid records for one email, the later expiry is returned", async () => {
    const fake = fakeKv();
    await storeOne(fake, { sdJwt: "sd-earlier", expiresAt: new Date(NOW + HOUR), credentialId: "c-earlier" });
    const later = await storeOne(fake, { sdJwt: "sd-later", expiresAt: new Date(NOW + 3 * HOUR), credentialId: "c-later" });
    const found = await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "alice@example.com", now: NOW_DATE });
    expect(found?.recordId).toBe(later.record.recordId);
  });
});

describe("ASCII-only case folding", () => {
  test("non-ASCII letters are not case-folded, so a differently cased non-ASCII request does not match", async () => {
    const fake = fakeKv();
    await storeOne(fake, { email: "Äx@example.com" });
    expect(await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "äx@example.com", now: NOW_DATE })).toBeUndefined();
    expect((await findHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, email: "Äx@example.com", now: NOW_DATE }))?.email).toBe("Äx@example.com");
  });
});

describe("held key format is pinned", () => {
  test("record key is v1/held/<lowercase address>/<recordId>, not a checksummed or owner-less path", async () => {
    const fake = fakeKv();
    const { record } = await storeOne(fake);
    expect([...fake.data.keys()]).toEqual([`v1/held/${RAW_ADDRESS_A}/${record.recordId}`]);
  });
});
