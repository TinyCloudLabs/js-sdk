import { describe, expect, test } from "bun:test";
import { CredentialError, type IKVService } from "@tinycloud/sdk-core";
import * as held from "../src/credentials/held-store";
import * as subpath from "../src/credentials-subpath";

// TC-1454: two additive exports of `@tinycloud/web-sdk/credentials` for an app that wants to ask for the storage grant first and delete one record:
// `probeHeldStoreAccess` (ONE kv.list of the owner's prefix: a cheap "may this session list held credentials" check) and `deleteHeldCredential`.
// The probe checks LIST access only; it never reads, verifies, writes or deletes anything.
const OWNER = "did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const RECORD_ID = "R".repeat(43);
const READ_TEXT = "This app can't read held credentials: the session may lack kv get and list on v1/held/ (skipPrefix), or may need to sign in again.";
const DELETE_TEXT = "This app can't delete held credentials: the session may lack kv del on v1/held/ (skipPrefix), or may need to sign in again.";
const LIST_TEXT = "Held credentials could not be listed";

const kvError = (error: Record<string, unknown>) => ({ ok: false as const, error: { service: "kv", message: "kv failed", ...error } });
const denied = (status: number) => kvError({ code: "AUTH_UNAUTHORIZED", message: `kv/list: ${status} - Unauthorized Action: space/kv/v1/held/x / tinycloud.kv/list`, meta: { status } });

interface Responses {
  list?: unknown;
  delete?: unknown;
  throwOnList?: boolean;
}
/** A kv that counts every call. */
function countingKv(responses: Responses = {}) {
  const calls = { list: [] as unknown[], get: 0, put: 0, batchPut: 0, delete: [] as string[] };
  const kv = {
    async list(options?: unknown) {
      calls.list.push(options);
      if (responses.throwOnList) throw new Error("socket closed");
      return responses.list ?? { ok: true, data: { keys: [], truncated: false } };
    },
    async get() { calls.get += 1; return kvError({ code: "KV_NOT_FOUND" }); },
    async put() { calls.put += 1; return { ok: true }; },
    async batchPut() { calls.batchPut += 1; return { ok: true }; },
    async delete(key: string) { calls.delete.push(key); return responses.delete ?? { ok: true }; },
  };
  return { kv: kv as unknown as IKVService, calls };
}
const total = (calls: ReturnType<typeof countingKv>["calls"]) => calls.list.length + calls.get + calls.put + calls.batchPut + calls.delete.length;

async function failure(run: () => Promise<unknown>): Promise<CredentialError | undefined> {
  try { await run(); } catch (error) { if (error instanceof CredentialError) return error; throw error; }
  return undefined;
}
const probe = (kv: IKVService, ownerDid: unknown = OWNER) => held.probeHeldStoreAccess({ kv, ownerDid });

describe("probeHeldStoreAccess: a permission failure of the one list is PERMISSION_DENIED with the read text", () => {
  for (const [name, result] of [["401", denied(401)], ["403", denied(403)], ["AUTH_UNAUTHORIZED with no status", kvError({ code: "AUTH_UNAUTHORIZED" })]] as const) {
    test(name, async () => {
      const { kv, calls } = countingKv({ list: result });
      const error = await failure(() => probe(kv));
      expect([error?.code, error?.message, error?.recoverable]).toEqual(["PERMISSION_DENIED", READ_TEXT, false]);
      expect(calls.list).toHaveLength(1);
    });
  }
});

describe("probeHeldStoreAccess: it resolves when the list is ok, with exactly one list call and no other kv call", () => {
  const cases: [string, unknown][] = [
    ["an empty listing", { ok: true, data: { keys: [], truncated: false } }],
    ["a listing with entries", { ok: true, data: { keys: [`v1/held/x/${RECORD_ID}`, `v1/held/x/${"S".repeat(43)}`], truncated: false } }],
    ["a truncated listing with a cursor (the cursor is not followed)", { ok: true, data: { keys: [`v1/held/x/${RECORD_ID}`], truncated: true, nextCursor: "c1" } }],
    ["a truncated listing without a cursor (not an error here: nothing is read)", { ok: true, data: { keys: [], truncated: true } }],
  ];
  for (const [name, list] of cases) {
    test(name, async () => {
      const { kv, calls } = countingKv({ list });
      await expect(probe(kv)).resolves.toBeUndefined();
      expect(calls.list).toHaveLength(1);
      expect([calls.get, calls.put, calls.batchPut, calls.delete.length]).toEqual([0, 0, 0, 0]);
    });
  }

  test("the one list asks for the owner's prefix only, with no cursor", async () => {
    const { kv, calls } = countingKv();
    await probe(kv);
    expect(calls.list).toEqual([{ prefix: held.heldPrefix(OWNER) }]);
    expect((calls.list[0] as { prefix: string }).prefix.startsWith("v1/held/")).toBe(true);
  });

  test("a lowercase owner address is the same owner: one canonical prefix", async () => {
    const lower = OWNER.slice(0, "did:pkh:eip155:1:".length) + OWNER.slice("did:pkh:eip155:1:".length).toLowerCase();
    const { kv, calls } = countingKv();
    await probe(kv, lower);
    expect(calls.list).toEqual([{ prefix: held.heldPrefix(OWNER) }]);
  });
});

describe("probeHeldStoreAccess: any other failure is OFFLINE with the list text", () => {
  const cases: [string, Responses][] = [
    ["a 404", { list: kvError({ code: "KV_ERROR", message: "kv/list: 404 - not found", meta: { status: 404 } }) }],
    ["a 500", { list: kvError({ code: "KV_ERROR", meta: { status: 500 } }) }],
    ["a network error", { list: kvError({ code: "NETWORK_ERROR", message: "fetch failed" }) }],
    ["a message that merely says 401, with another code and no status", { list: kvError({ code: "NETWORK_ERROR", message: "kv/list: 401 - Unauthorized Action" }) }],
    ["a 5xx that carries the AUTH_UNAUTHORIZED code (the status decides)", { list: kvError({ code: "AUTH_UNAUTHORIZED", meta: { status: 503 } }) }],
    ["a kv that throws", { throwOnList: true }],
  ];
  for (const [name, responses] of cases) {
    test(name, async () => {
      const { kv, calls } = countingKv(responses);
      const error = await failure(() => probe(kv));
      expect([error?.code, error?.message, error?.recoverable]).toEqual(["OFFLINE", LIST_TEXT, true]);
      expect([calls.get, calls.put, calls.batchPut, calls.delete.length]).toEqual([0, 0, 0, 0]);
    });
  }
});

describe("probeHeldStoreAccess: the owner guard of every held function, before any kv call", () => {
  for (const [name, owner] of [
    ["a non-mainnet account", "did:pkh:eip155:5:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
    ["a did:key", "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd"],
    ["not a string", 7],
    ["an empty string", ""],
  ] as const) {
    test(`${name}: ACTIVE_SESSION_REQUIRED with 0 kv calls`, async () => {
      const { kv, calls } = countingKv();
      const error = await failure(() => probe(kv, owner));
      expect(error?.code).toBe("ACTIVE_SESSION_REQUIRED");
      expect(total(calls)).toBe(0);
    });
  }
});

describe("deleteHeldCredential", () => {
  const remove = (kv: IKVService, recordId: string = RECORD_ID) => held.deleteHeldCredential({ kv, ownerDid: OWNER, recordId });

  test("401 and 403 are PERMISSION_DENIED with the delete text", async () => {
    for (const status of [401, 403]) {
      const { kv } = countingKv({ delete: denied(status) });
      const error = await failure(() => remove(kv));
      expect([status, error?.code, error?.message]).toEqual([status, "PERMISSION_DENIED", DELETE_TEXT]);
    }
  });
  test("ok is true, and the one delete is of this owner's key for this record", async () => {
    const { kv, calls } = countingKv();
    expect(await remove(kv)).toBe(true);
    expect(calls.delete).toEqual([`${held.heldPrefix(OWNER)}${RECORD_ID}`]);
    expect([calls.list.length, calls.get, calls.put, calls.batchPut]).toEqual([0, 0, 0, 0]);
  });
  test("a not-ok that is not a permission failure is false (not thrown)", async () => {
    for (const result of [kvError({ code: "NETWORK_ERROR" }), kvError({ code: "KV_ERROR", meta: { status: 500 } }), kvError({ code: "KV_NOT_FOUND" })]) {
      expect(await remove(countingKv({ delete: result }).kv)).toBe(false);
    }
  });
  test("a bad recordId is DESCRIPTOR_INVALID with 0 kv calls", async () => {
    for (const recordId of ["", "short", "R".repeat(42), "R".repeat(44), "R".repeat(42) + "/", "../" + "R".repeat(40), `${"R".repeat(42)}\n`]) {
      const { kv, calls } = countingKv();
      const error = await failure(() => remove(kv, recordId));
      expect([recordId, error?.code, total(calls)]).toEqual([recordId, "DESCRIPTOR_INVALID", 0]);
    }
  });
  test("a non-mainnet owner is ACTIVE_SESSION_REQUIRED with 0 kv calls", async () => {
    const { kv, calls } = countingKv();
    const error = await failure(() => held.deleteHeldCredential({ kv, ownerDid: "did:pkh:eip155:5:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", recordId: RECORD_ID }));
    expect([error?.code, total(calls)]).toEqual(["ACTIVE_SESSION_REQUIRED", 0]);
  });
});

describe("the @tinycloud/web-sdk/credentials entry (credentials-subpath)", () => {
  test("exports probeHeldStoreAccess and deleteHeldCredential, the same functions the store defines", () => {
    expect(subpath.probeHeldStoreAccess).toBe(held.probeHeldStoreAccess);
    expect(subpath.deleteHeldCredential).toBe(held.deleteHeldCredential);
  });
  test("pruneHeldCredentials is NOT exported (a bulk delete stays internal)", () => {
    expect("pruneHeldCredentials" in subpath).toBe(false);
    expect((subpath as Record<string, unknown>).pruneHeldCredentials).toBeUndefined();
  });
  test("the existing held surface is still there", () => {
    for (const name of ["createAccountHolderSigner", "storeHeldCredential", "findHeldCredential", "listHeldEmailCredentials", "acquireHeldCredential"] as const) {
      expect(typeof subpath[name]).toBe("function");
    }
  });
});
