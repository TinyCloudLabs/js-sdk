import { describe, expect, test } from "bun:test";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CredentialError, type IKVService } from "@tinycloud/sdk-core";
import { parseIssuerSet } from "@tinycloud/sdk-core/held-credentials";
import { acquireHeldCredentialWith, type HeldAcquireInput } from "../src/credentials/held-source";
import { createAccountHolderSigner } from "../src/credentials/account-holder";
import { deleteHeldCredential, findHeldCredential, heldPrefix, listHeldEmailCredentials, pruneHeldCredentials, type HeldIssuerPolicy } from "../src/credentials/held-store";
// The node-sdk test seam (caller-supplied issuer keys) and the fake witness are node-sdk sources: tests only.
import { acquireEmailProofWithIssuerKeys } from "../../node-sdk/src/credentials/email-proof";
import { createHeldWitness } from "../../node-sdk/src/credentials/test-support/held-witness";

// TC-1454, QA finding on web-sdk 3.9.0-beta.3: on a signed-in manifest app, `kv.list` on `v1/held/<addr>/` answers 401 when the app session holds no
// kv get/list on that prefix, and the held store read it as OFFLINE. A consumer could not tell "not permitted" from "offline". The signal is the TYPED
// kv result (`error.meta.status` 401/403, or `error.code` AUTH_UNAUTHORIZED without a status), never the message text.
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER = privateKeyToAccount(ANVIL_0);
const OWNER_DID = `did:pkh:eip155:1:${OWNER.address}`;
const T0 = Date.parse("2026-10-30T06:53:00Z");
const ISSUER_DID = "did:web:issuer.credentials.org";
const HELD = "tinycloud.email-held/v1";
const READ_MESSAGE = "This app has no permission to read held credentials: request kv get and list on v1/held/ (skipPrefix).";
const DELETE_MESSAGE = "This app has no permission to delete held credentials: request kv del on v1/held/ (skipPrefix).";
const RECORD_ID = "R".repeat(43);

const witness0 = createHeldWitness({ serverClock: () => T0 });
const policy: HeldIssuerPolicy = {
  issuerSet: parseIssuerSet(
    { format: "tinycloud.credentials-issuers/v1", version: 1, issuers: [{ alg: "EdDSA", issuerDid: ISSUER_DID, kid: `${ISSUER_DID}#controller`, notAfter: null, notBefore: "2020-01-01T00:00:00Z", profiles: [HELD], publicKey: witness0.issuerX, retiredAt: null, vcts: ["opencredentials.email/v1"] }] },
    { didMethods: { issuer: ["web"] } },
  ),
  acceptedIssuers: [{ issuerDid: ISSUER_DID }],
  didMethods: { issuer: ["web"] },
};

type KvResult = { ok: false; error: Record<string, unknown> };
const kvError = (error: Record<string, unknown>): KvResult => ({ ok: false, error: { service: "kv", message: "kv failed", ...error } });
/** What the kv service returns for a 401 or 403 (KVService.ts: AUTH_UNAUTHORIZED with the HTTP status in meta). */
const denied = (status: number) => kvError({ code: "AUTH_UNAUTHORIZED", message: `kv/list: ${status} - Unauthorized Action: space/kv/v1/held/x / tinycloud.kv/list`, meta: { status } });

interface Responses {
  list?: unknown;
  get?: unknown;
  batchPut?: unknown;
  delete?: unknown;
  keys?: readonly string[];
}
function fakeKv(responses: Responses = {}) {
  const key = `${heldPrefix(OWNER_DID)}${RECORD_ID}`;
  const calls = { list: 0, get: 0, batchPut: 0, delete: 0 };
  const kv = {
    async list() { calls.list += 1; return responses.list ?? { ok: true, data: { keys: responses.keys ?? [key], truncated: false } }; },
    async get() { calls.get += 1; return responses.get ?? kvError({ code: "KV_NOT_FOUND" }); },
    async batchPut() { calls.batchPut += 1; return responses.batchPut ?? { ok: true }; },
    async delete() { calls.delete += 1; return responses.delete ?? { ok: true }; },
  };
  return { kv: kv as unknown as IKVService, calls, key };
}

async function failure(run: () => Promise<unknown>): Promise<CredentialError | undefined> {
  try { await run(); } catch (error) { if (error instanceof CredentialError) return error; throw error; }
  return undefined;
}
const input = (kv: IKVService) => ({ ...policy, kv, ownerDid: OWNER_DID, now: new Date(T0) });

function world(kv: IKVService) {
  const witness = createHeldWitness({ serverClock: () => T0 });
  const holder = createAccountHolderSigner(OWNER_DID, async (bytes) => hexToBytes(await OWNER.signMessage({ message: { raw: bytes } })));
  const acquire: Parameters<typeof acquireHeldCredentialWith>[1] = (i) => acquireEmailProofWithIssuerKeys(i, witness.issuerKeys);
  const base = { ...policy, kv, address: "alice@example.com", holder, getCode: async () => "12345678", fetch: witness.fetch, now: () => new Date(T0) } as unknown as HeldAcquireInput;
  return { witness, acquire, base };
}


describe("a kv list the app session may not make is PERMISSION_DENIED, not OFFLINE", () => {
  for (const [name, result] of [["401", denied(401)], ["403", denied(403)], ["AUTH_UNAUTHORIZED with no status", kvError({ code: "AUTH_UNAUTHORIZED" })]] as const) {
    test(`listHeldEmailCredentials: ${name}`, async () => {
      const { kv } = fakeKv({ list: result });
      const error = await failure(() => listHeldEmailCredentials(input(kv)));
      expect([error?.code, error?.message, error?.recoverable]).toEqual(["PERMISSION_DENIED", READ_MESSAGE, false]);
    });
  }

  test("the error carries no kv detail: no node message, no address, no space id", async () => {
    const { kv } = fakeKv({ list: denied(401) });
    const error = await failure(() => listHeldEmailCredentials(input(kv)));
    expect(JSON.stringify({ message: error?.message, details: error?.details })).not.toMatch(/space|0x|Unauthorized Action|401/);
  });

  test("findHeldCredential surfaces it too (a missing grant is not 'no credential': the caller would acquire, mail a code and then fail to store)", async () => {
    const { kv } = fakeKv({ list: denied(401) });
    const error = await failure(() => findHeldCredential({ ...input(kv), email: "alice@example.com" }));
    expect(error?.code).toBe("PERMISSION_DENIED");
  });

  test("pruneHeldCredentials surfaces it", async () => {
    const { kv } = fakeKv({ list: denied(401) });
    expect((await failure(() => pruneHeldCredentials(input(kv))))?.code).toBe("PERMISSION_DENIED");
  });

  test("the first page may be listed and a later page denied: still PERMISSION_DENIED", async () => {
    const key = `${heldPrefix(OWNER_DID)}${RECORD_ID}`;
    let page = 0;
    const kv = { async list() { page += 1; return page === 1 ? { ok: true, data: { keys: [key], truncated: true, nextCursor: "c1" } } : denied(401); }, async get() { return kvError({ code: "KV_NOT_FOUND" }); } } as unknown as IKVService;
    expect((await failure(() => listHeldEmailCredentials(input(kv))))?.code).toBe("PERMISSION_DENIED");
  });
});

describe("a kv get the app session may not make is PERMISSION_DENIED", () => {
  test("listHeldEmailCredentials: a listed key whose get is 401", async () => {
    const { kv } = fakeKv({ get: denied(401) });
    const error = await failure(() => listHeldEmailCredentials(input(kv)));
    expect([error?.code, error?.message]).toEqual(["PERMISSION_DENIED", READ_MESSAGE]);
  });
  test("findHeldCredential and pruneHeldCredentials: a listed key whose get is 403", async () => {
    const { kv } = fakeKv({ get: denied(403) });
    expect((await failure(() => findHeldCredential({ ...input(kv), email: "alice@example.com" })))?.code).toBe("PERMISSION_DENIED");
    expect((await failure(() => pruneHeldCredentials(input(kv))))?.code).toBe("PERMISSION_DENIED");
  });
});

describe("a kv delete the app session may not make is PERMISSION_DENIED", () => {
  test("deleteHeldCredential: 401 throws; a not-ok that is not a permission failure still returns false", async () => {
    const refused = fakeKv({ delete: denied(401) });
    const error = await failure(() => deleteHeldCredential({ kv: refused.kv, ownerDid: OWNER_DID, recordId: RECORD_ID }));
    expect([error?.code, error?.message]).toEqual(["PERMISSION_DENIED", DELETE_MESSAGE]);
    const offline = fakeKv({ delete: kvError({ code: "NETWORK_ERROR" }) });
    expect(await deleteHeldCredential({ kv: offline.kv, ownerDid: OWNER_DID, recordId: RECORD_ID })).toBe(false);
  });
  test("pruneHeldCredentials: a doomed (expired) record whose delete is denied throws instead of reporting nothing removed; other failures leave it unremoved", async () => {
    const memory = new Map<string, unknown>();
    const deletes: { result: unknown } = { result: { ok: true } };
    const kv = {
      async list() { return { ok: true, data: { keys: [...memory.keys()], truncated: false } }; },
      async get(key: string) { return memory.has(key) ? { ok: true, data: { data: structuredClone(memory.get(key)) } } : kvError({ code: "KV_NOT_FOUND" }); },
      async batchPut(items: { key: string; value: unknown }[]) { for (const item of items) memory.set(item.key, item.value); return { ok: true }; },
      async delete(key: string) { const result = deletes.result as { ok: boolean }; if (result.ok) memory.delete(key); return result; },
    } as unknown as IKVService;
    const w = world(kv);
    await acquireHeldCredentialWith({ ...w.base, allowHeldProfile: true }, w.acquire);
    expect(memory.size).toBe(1);
    const later = new Date(T0 + 400 * 86_400_000);
    deletes.result = denied(401);
    const error = await failure(() => pruneHeldCredentials({ ...policy, kv, ownerDid: OWNER_DID, now: later }));
    expect([error?.code, error?.message]).toEqual(["PERMISSION_DENIED", DELETE_MESSAGE]);
    expect(memory.size).toBe(1);
    deletes.result = kvError({ code: "NETWORK_ERROR" });
    expect(await pruneHeldCredentials({ ...policy, kv, ownerDid: OWNER_DID, now: later })).toEqual([]);
    deletes.result = { ok: true };
    expect(await pruneHeldCredentials({ ...policy, kv, ownerDid: OWNER_DID, now: later })).toHaveLength(1);
  });
});

describe("the signal is the typed result, never the message text; real failures keep OFFLINE", () => {
  const offlineCases: [string, unknown][] = [
    ["a network failure", kvError({ code: "NETWORK_ERROR", message: "fetch failed" })],
    ["a 500", kvError({ code: "KV_ERROR", meta: { status: 500 } })],
    ["a 404 with a node text", kvError({ code: "KV_ERROR", message: "kv/list: 404 - not found", meta: { status: 404 } })],
    ["a message that merely says 401 and Unauthorized, with another code and no status", kvError({ code: "NETWORK_ERROR", message: "kv/list: 401 - Unauthorized Action" })],
    ["a 5xx that carries the AUTH_UNAUTHORIZED code (the status decides)", kvError({ code: "AUTH_UNAUTHORIZED", meta: { status: 503 } })],
  ];
  for (const [name, result] of offlineCases) {
    test(`listHeldEmailCredentials: ${name} is OFFLINE`, async () => {
      const { kv } = fakeKv({ list: result });
      const error = await failure(() => listHeldEmailCredentials(input(kv)));
      expect([error?.code, error?.message]).toEqual(["OFFLINE", "Held credentials could not be listed"]);
    });
  }
  test("a listed key whose get fails on the network is OFFLINE, and a get that is KV_NOT_FOUND is skipped", async () => {
    const offline = fakeKv({ get: kvError({ code: "NETWORK_ERROR" }) });
    const error = await failure(() => listHeldEmailCredentials(input(offline.kv)));
    expect([error?.code, error?.message]).toEqual(["OFFLINE", "A held credential could not be read"]);
    expect(await listHeldEmailCredentials(input(fakeKv({ get: kvError({ code: "KV_NOT_FOUND" }) }).kv))).toEqual([]);
  });
  test("findHeldCredential keeps its looser contract for a failed list that is not a permission failure: not found", async () => {
    const { kv } = fakeKv({ list: kvError({ code: "NETWORK_ERROR" }) });
    expect(await findHeldCredential({ ...input(kv), email: "alice@example.com" })).toBeUndefined();
  });
  test("pruneHeldCredentials keeps returning [] for a failed list that is not a permission failure", async () => {
    const { kv } = fakeKv({ list: kvError({ code: "NETWORK_ERROR" }) });
    expect(await pruneHeldCredentials(input(kv))).toEqual([]);
  });
});

describe("acquireHeldCredential: the strict read comes first, so a missing grant is reported before any request or mail", () => {
  test("with the opt-in: PERMISSION_DENIED, zero witness calls, zero mails", async () => {
    const { kv } = fakeKv({ list: denied(401) });
    const w = world(kv);
    const error = await failure(() => acquireHeldCredentialWith({ ...w.base, allowHeldProfile: true }, w.acquire));
    expect([error?.code, error?.message]).toEqual(["PERMISSION_DENIED", READ_MESSAGE]);
    expect(w.witness.calls).toHaveLength(0);
    expect(w.witness.mails).toHaveLength(0);
  });

  test("without the opt-in a miss is still PROFILE_UNAVAILABLE whatever the storage says (C8.3): an unreadable store, permission or network, does not change that", async () => {
    for (const list of [denied(401), kvError({ code: "NETWORK_ERROR" })]) {
      const { kv } = fakeKv({ list });
      const w = world(kv);
      const error = (await acquireHeldCredentialWith(w.base, w.acquire).catch((e: unknown) => e)) as { code?: string };
      expect(error.code).toBe("PROFILE_UNAVAILABLE");
      expect(w.witness.calls).toHaveLength(0);
    }
  });

  test("a write the app may not make is still VERIFIED_NOT_SAVED (the documented invariant: issued, then not confirmed in storage)", async () => {
    const { kv } = fakeKv({ keys: [], batchPut: denied(401) });
    const w = world(kv);
    const error = await failure(() => acquireHeldCredentialWith({ ...w.base, allowHeldProfile: true }, w.acquire));
    expect(error?.code).toBe("VERIFIED_NOT_SAVED");
  });
});
