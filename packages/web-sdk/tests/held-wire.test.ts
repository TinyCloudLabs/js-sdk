import { describe, expect, test } from "bun:test";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CredentialError, type IKVService } from "@tinycloud/sdk-core";
import { parseIssuerSet } from "@tinycloud/sdk-core/held-credentials";
import { acquireHeldCredentialWith, HeldSourceError, type HeldAcquireInput } from "../src/credentials/held-source";
import { createAccountHolderSigner } from "../src/credentials/account-holder";
import { heldPrefix, type HeldIssuerPolicy } from "../src/credentials/held-store";
// The node-sdk test seam (caller-supplied issuer keys) and the fake witness are node-sdk sources: tests only.
import { acquireEmailProofWithIssuerKeys } from "../../node-sdk/src/credentials/email-proof";
import { createHeldWitness, vectors, type HeldWitnessOptions } from "../../node-sdk/src/credentials/test-support/held-witness";

// TC-2254 S15 and S17 (contract v2.4): acquireHeldCredential forwards the per-call opt-in, reads the member's storage strictly before any
// request (so before any mail), checks the caller's issuer policy first, reuses with a clock-shifted read, and stores at max(client, iat).
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER = privateKeyToAccount(ANVIL_0);
const ADDRESS = "alice@example.com";
const T0 = Date.parse("2026-10-30T06:53:00Z");
const ISSUER_DID = "did:web:issuer.credentials.org";
const ISSUER_KID = `${ISSUER_DID}#controller`;
const HELD = "tinycloud.email-held/v1";

const walletSign = (account: typeof OWNER) => async (bytes: Uint8Array): Promise<Uint8Array> => hexToBytes(await account.signMessage({ message: { raw: bytes } }));

function policyFor(issuerX: string, patch: Partial<Record<string, unknown>> = {}): HeldIssuerPolicy {
  return {
    issuerSet: parseIssuerSet(
      { format: "tinycloud.credentials-issuers/v1", version: 1, issuers: [{ alg: "EdDSA", issuerDid: ISSUER_DID, kid: ISSUER_KID, notAfter: null, notBefore: "2020-01-01T00:00:00Z", profiles: [HELD], publicKey: issuerX, retiredAt: null, vcts: ["opencredentials.email/v1"], ...patch }] },
      { didMethods: { issuer: ["web"] } },
    ),
    acceptedIssuers: [{ issuerDid: ISSUER_DID }],
    didMethods: { issuer: ["web"] },
  };
}

interface KvOptions {
  readonly listFails?: boolean;
  readonly listThrows?: boolean;
  readonly getFailsFor?: (key: string) => { readonly code: string } | undefined;
  readonly getThrowsFor?: (key: string) => boolean;
}
function fakeKv(options: KvOptions = {}) {
  const data = new Map<string, unknown>();
  const calls = { list: 0, get: 0, put: 0 };
  const kv = {
    async list(opts: { prefix?: string } = {}) {
      calls.list += 1;
      if (options.listThrows) throw new Error("kv list failed");
      if (options.listFails) return { ok: false, error: { code: "NETWORK_ERROR" } };
      return { ok: true, data: { keys: [...data.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort(), truncated: false } };
    },
    async get(key: string) {
      calls.get += 1;
      if (options.getThrowsFor?.(key)) throw new Error("kv get failed");
      const failure = options.getFailsFor?.(key);
      if (failure) return { ok: false, error: failure };
      return data.has(key) ? { ok: true, data: { data: structuredClone(data.get(key)) } } : { ok: false, error: { code: "KV_NOT_FOUND" } };
    },
    async batchPut(items: { key: string; value: unknown }[]) {
      calls.put += 1;
      for (const item of items) data.set(item.key, item.value);
      return { ok: true };
    },
    async delete(key: string) { data.delete(key); return { ok: true }; },
  };
  return { kv: kv as unknown as IKVService, data, calls };
}

function world(witnessOptions: Omit<HeldWitnessOptions, "serverClock"> = {}, slowBy = 0, kvOptions: KvOptions = {}, policyPatch: Partial<Record<string, unknown>> = {}, privateKey = ANVIL_0) {
  const time = { server: T0, slow: slowBy };
  const client = () => time.server - time.slow;
  const witness = createHeldWitness({ ...witnessOptions, serverClock: () => time.server });
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const holder = createAccountHolderSigner(`did:pkh:eip155:1:${account.address}`, walletSign(account));
  const store = fakeKv(kvOptions);
  const policy = policyFor(witness.issuerX, policyPatch);
  const acquireCalls = { count: 0 };
  const acquire: Parameters<typeof acquireHeldCredentialWith>[1] = (input) => { acquireCalls.count += 1; return acquireEmailProofWithIssuerKeys(input, witness.issuerKeys); };
  const input = (extra: Partial<HeldAcquireInput> & Record<string, unknown> = {}): HeldAcquireInput =>
    ({ ...policy, kv: store.kv, address: ADDRESS, holder, getCode: async () => "12345678", fetch: witness.fetch, now: () => new Date(client()), allowHeldProfile: true, ...extra }) as HeldAcquireInput;
  const run = (extra: Partial<HeldAcquireInput> & Record<string, unknown> = {}) => acquireHeldCredentialWith(input(extra), acquire);
  return { time, client, witness, holder, store, policy, input, run, acquireCalls };
}
async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  return undefined;
}
const code = (error: unknown): unknown => (error instanceof CredentialError ? error.code : error instanceof HeldSourceError ? error.code : error);

describe("acquisition through the account signer, the opt-in and the store", () => {
  test("with the per-call opt-in: issued, verified, stored; a second call reuses with zero requests and zero mails", async () => {
    const w = world();
    const first = await w.run();
    expect(first.holderDid).toBe(w.holder.did);
    expect(first.credential).toMatch(/~$/);
    expect(w.store.calls.put).toBe(1);
    expect(w.witness.mails.map((m) => m.kind)).toEqual(["code", "notice"]);
    const callsAfterFirst = w.witness.calls.length;
    const second = await w.run();
    expect(second.credential).toBe(first.credential);
    expect(w.witness.calls).toHaveLength(callsAfterFirst);
    expect(w.witness.mails).toHaveLength(2);
    expect(w.acquireCalls.count).toBe(1);
  });

  test("without the opt-in the held profile is refused PROFILE_UNAVAILABLE before any request, and nothing is stored", async () => {
    const w = world();
    const error = await failure(() => w.run({ allowHeldProfile: undefined }));
    expect((error as { code?: string }).code).toBe("PROFILE_UNAVAILABLE");
    expect(w.witness.calls).toHaveLength(0);
    expect(w.store.calls.put).toBe(0);
  });

  test("the receipt's expiresAt is the signed exp of the stored credential", async () => {
    const w = world();
    const result = await w.run();
    expect(result.expiresAt.getTime()).toBe(Math.floor(T0 / 1000) * 1000 + 31_536_000_000);
  });
});

describe("the strict storage read and the issuer-policy check come before the first request (S17)", () => {
  const noRequest = (w: ReturnType<typeof world>) => {
    expect(w.witness.calls).toHaveLength(0);
    expect(w.witness.mails).toHaveLength(0);
    expect(w.acquireCalls.count).toBe(0);
  };

  test("a kv.list that resolves not-ok is OFFLINE with zero requests, zero mails and no acquire", async () => {
    const w = world({}, 0, { listFails: true });
    expect(code(await failure(() => w.run()))).toBe("OFFLINE");
    noRequest(w);
  });

  test("a kv.list that throws is OFFLINE", async () => {
    const w = world({}, 0, { listThrows: true });
    expect(code(await failure(() => w.run()))).toBe("OFFLINE");
    noRequest(w);
  });

  test("a listed key whose kv.get throws, or resolves not-ok with a code other than KV_NOT_FOUND, is OFFLINE", async () => {
    for (const kvOptions of [{ getThrowsFor: () => true }, { getFailsFor: () => ({ code: "NETWORK_ERROR" }) }] as KvOptions[]) {
      const seed = world();
      await seed.run();
      const w = world({}, 0, kvOptions);
      for (const [key, value] of seed.store.data) w.store.data.set(key, value);
      expect(code(await failure(() => w.run()))).toBe("OFFLINE");
      noRequest(w);
    }
  });

  test("a listed key whose kv.get is KV_NOT_FOUND is skipped, and the acquisition goes on", async () => {
    const seed = world();
    await seed.run();
    const seeded = new Set(seed.store.data.keys());
    const w = world({}, 0, { getFailsFor: (key) => (seeded.has(key) ? { code: "KV_NOT_FOUND" } : undefined) });
    for (const [key, value] of seed.store.data) w.store.data.set(key, value);
    const result = await w.run();
    expect(result.credential).toMatch(/~$/);
    expect(w.acquireCalls.count).toBe(1);
  });

  test("a caller policy that does not accept the pinned issuer is refused with zero requests: not accepted, retired, not yet valid, withdrawn, wrong profile or vct", async () => {
    const patches: [string, Partial<Record<string, unknown>>, Partial<HeldAcquireInput> & Record<string, unknown>][] = [
      ["acceptedIssuers lists another issuer", {}, { acceptedIssuers: [{ issuerDid: "did:web:other.example.com" }] }],
      ["acceptedIssuers pins another kid", {}, { acceptedIssuers: [{ issuerDid: ISSUER_DID, kid: `${ISSUER_DID}#other` }] }],
      ["retired before now", { retiredAt: "2026-10-30T06:00:00Z" }, {}],
      ["not yet valid", { notBefore: "2027-01-01T00:00:00Z" }, {}],
      ["withdrawn before now", { notAfter: "2026-10-30T06:00:00Z" }, {}],
      ["does not list the held profile", { profiles: ["tinycloud.email-proof/v1"] }, {}],
    ];
    for (const [name, patch, extra] of patches) {
      const w = world({}, 0, {}, patch);
      const error = await failure(() => w.run(extra));
      expect([name, code(error)]).toEqual([name, "VERIFICATION_FAILED"]);
      noRequest(w);
    }
  });

  test("a verified record for the address that clears the reuse margin is returned with zero requests", async () => {
    const seed = world();
    const issued = await seed.run();
    const w = world();
    for (const [key, value] of seed.store.data) w.store.data.set(key, value);
    const reused = await w.run();
    expect(reused.credential).toBe(issued.credential);
    noRequest(w);
  });

  test("another account's records under its own prefix are never offered", async () => {
    const seed = world();
    await seed.run();
    const other = world({}, 0, {}, {}, "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    for (const [key, value] of seed.store.data) other.store.data.set(key.replace(heldPrefix(seed.holder.did), heldPrefix(other.holder.did)), value);
    const result = await other.run();
    expect(other.acquireCalls.count).toBe(1);
    expect(result.holderDid).toBe(other.holder.did);
  });
});

describe("clocks: the store step verifies at max(client, iat) and the reuse read looks 300 s ahead (C5.5 item 4, C5.6 item 5)", () => {
  test("a client 1 s slow is stored; the stored record carries verifyAt, the credential's own iat", async () => {
    const w = world({}, 1000);
    await w.run();
    const record = [...w.store.data.values()][0] as { storedAt: string };
    expect(record.storedAt).toBe(new Date(Math.floor(T0 / 1000) * 1000).toISOString());
  });

  test("a client 299 s slow is stored; a client 6 minutes fast is stored too", async () => {
    for (const slow of [299_000, -360_000]) {
      const w = world({}, slow);
      await w.run();
      expect(w.store.calls.put).toBe(1);
    }
  });

  test("a client 301 s slow is refused CLIENT_CLOCK_SKEW before any mail; nothing is stored", async () => {
    const w = world({}, 301_000);
    const error = await failure(() => w.run());
    expect((error as { code?: string }).code).toBe("CLIENT_CLOCK_SKEW");
    expect(w.witness.mails).toHaveLength(0);
    expect(w.store.calls.put).toBe(0);
  });

  test("a second call right after a 1-minute-slow acquisition is a reuse: zero requests, zero mails, one stored record", async () => {
    const w = world({}, 60_000);
    const first = await w.run();
    const before = w.witness.calls.length;
    w.time.server += 1000;
    const second = await w.run();
    expect(second.credential).toBe(first.credential);
    expect(w.witness.calls).toHaveLength(before);
    expect(w.witness.mails.filter((m) => m.kind === "code")).toHaveLength(1);
    expect(w.store.data.size).toBe(1);
  });

  test("a credential whose iat is more than 300 s ahead of the client is refused before the store step", async () => {
    // The acquisition seam returns a credential the witness issued 400 s after this client's clock (the node-sdk post-issue check is bypassed).
    const ahead = world({}, 0);
    ahead.time.server = T0 + 400_000;
    const issued = await acquireEmailProofWithIssuerKeys({ address: ADDRESS, holder: ahead.holder, profile: HELD, allowHeldProfile: true, getCode: async () => "12345678", fetch: ahead.witness.fetch, now: () => new Date(T0 + 400_000) }, ahead.witness.issuerKeys);
    if (issued.status !== "issued") throw new Error("expected issued");
    const w = world();
    const error = await failure(() => acquireHeldCredentialWith(w.input(), async () => issued));
    expect((error as { code?: string }).code).toBe("VERIFICATION_FAILED");
    expect(w.store.calls.put).toBe(0);
    // 300 s ahead is within the bound and is stored (verified at its own iat).
    const within = world();
    within.time.server = T0 + 300_000;
    const inBound = await acquireEmailProofWithIssuerKeys({ address: ADDRESS, holder: within.holder, profile: HELD, allowHeldProfile: true, getCode: async () => "12345678", fetch: within.witness.fetch, now: () => new Date(T0 + 300_000) }, within.witness.issuerKeys);
    if (inBound.status !== "issued") throw new Error("expected issued");
    const w2 = world();
    await acquireHeldCredentialWith(w2.input(), async () => inBound);
    expect(w2.store.calls.put).toBe(1);
  });
});

describe("W1: an EIP-55 account with hex letters and no lowercase letter acquires from both holder forms", () => {
  const W1 = vectors.acceptanceW1.account;
  for (const [form, did] of [["EIP-55", W1.did], ["lowercase", W1.didLowercase]] as const) {
    test(`${form} DID: the signer returns the EIP-55 holder and the account is stored`, async () => {
      const time = { server: T0 };
      const witness = createHeldWitness({ serverClock: () => time.server });
      const account = privateKeyToAccount(W1.privateKeyHex);
      const holder = createAccountHolderSigner(did, walletSign(account));
      expect(holder.did).toBe(W1.did);
      expect(holder.kid).toBe(`${W1.did}#blockchainAccountId`);
      const store = fakeKv();
      const result = await acquireHeldCredentialWith({ ...policyFor(witness.issuerX), kv: store.kv, address: ADDRESS, holder, getCode: async () => "12345678", fetch: witness.fetch, now: () => new Date(time.server), allowHeldProfile: true } as HeldAcquireInput, (input) => acquireEmailProofWithIssuerKeys(input, witness.issuerKeys));
      expect(result.holderDid).toBe(W1.did);
      expect(store.calls.put).toBe(1);
    });
  }
});
