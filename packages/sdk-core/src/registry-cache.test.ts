import { expect, spyOn, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { signLocationRecord, signLocationRecordV2 } from "./location";
import type { LocationRecordV2Payload } from "./location";
import { createInMemoryRegistryCacheStore, verifyRegistryCacheEntry } from "./registry-cache";
import type { RegistryCacheStore } from "./registry-cache";
import { createInMemoryRegistrySequenceStore, DEFAULT_NEW_USER_HOST, refreshOwnerRegistry, registryOwnerSubjectV1, resolveFailClosedTinyCloudHosts, resolveOwnerHosts, resolveRegistryResource } from "./registry-policy";
import { createLocalStorageRegistrySequenceStore, DEFAULT_REGISTRY_SEQUENCE_STORAGE_KEY } from "./registry-policy";
import { installTestWebLocks } from "./test-support/web-locks";
import { REGISTRY_NOT_FOUND_BODY, RegistryLookupInputError } from "./registry-verdict";

const owner = privateKeyToAccount(generatePrivateKey()); // Ephemeral TEST owner only.
const subject = registryOwnerSubjectV1(owner.address);
const publicKey = ed25519.getPublicKey(new Uint8Array(32).fill(91));
const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 1, ...publicKey]))}`;
const space = `tinycloud:pkh:eip155:1:${owner.address}:secrets`;
async function body(sequence: number, mode: "read-only" | "read-write" = "read-write", url = "https://TEST-node.invalid") {
  const payload: LocationRecordV2Payload = { version: 2, subject, sequence, updated_at: "2026-11-04T00:00:00.000Z",
    nodes: [{ did: nodeDid, url: url.toLowerCase() }], spaces: [{ space, nodes: [{ did: nodeDid, mode }] }], encryptionNode: nodeDid };
  return ` { "record": ${JSON.stringify(await signLocationRecordV2(payload, { type: "did:pkh", signMessage: (message) => owner.signMessage({ message }) }))} }\n`;
}
const answer = (text: string): typeof fetch => (async () => new Response(text)) as typeof fetch;
const down: typeof fetch = (async () => { throw new Error("TEST client transport down"); }) as typeof fetch;

test("exact signed text survives cache reads and owner-chain changes; every read reverifies", async () => {
  const cacheStore = createInMemoryRegistryCacheStore();
  const raw = await body(7);
  await resolveOwnerHosts(subject, { cacheStore, fetch: answer(raw) });
  const saved = (await cacheStore.get(owner.address))!;
  expect(saved.responseBody).toBe(raw);
  expect(await resolveOwnerHosts(registryOwnerSubjectV1(owner.address, 137), { cacheStore, fetch: down })).toMatchObject({ status: "registered", sequence: 7 });
  const foreign = registryOwnerSubjectV1(privateKeyToAccount(generatePrivateKey()).address);
  await expect(verifyRegistryCacheEntry(foreign, owner.address, saved)).rejects.toThrow();
  await cacheStore.update(owner.address, async (current) => ({ ...current!, responseBody: current!.responseBody.replace("test-node.invalid", "removed-node.invalid") }));
  await expect(resolveOwnerHosts(subject, { cacheStore, fetch: down })).rejects.toThrow("verification failed");
});

test("only a strictly higher sequence replaces bytes or fetched-at metadata", async () => {
  const cacheStore = createInMemoryRegistryCacheStore();
  await resolveOwnerHosts(subject, { cacheStore, fetch: answer(await body(8)) });
  const first = await cacheStore.get(owner.address);
  for (const sequence of [8, 7]) {
    await refreshOwnerRegistry(subject, { cacheStore, fetch: answer(await body(sequence, "read-write", "https://other.invalid")) });
    expect(await cacheStore.get(owner.address)).toEqual(first);
  }
  const upgraded = await body(9, "read-only", "https://new.invalid");
  expect(await refreshOwnerRegistry(subject, { cacheStore, fetch: answer(upgraded) })).toMatchObject({ status: "registered", sequence: 9 });
  expect((await cacheStore.get(owner.address))?.responseBody).toBe(upgraded);
});

test("warm routing does not wait for slow refresh and read-only placement cannot receive writes", async () => {
  const cacheStore = createInMemoryRegistryCacheStore();
  await resolveOwnerHosts(subject, { cacheStore, fetch: answer(await body(11, "read-only")) });
  let release!: (response: Response) => void;
  const stalled = new Promise<Response>((resolve) => { release = resolve; });
  const options = { cacheStore, fetch: (async () => stalled) as typeof fetch };
  const read = await resolveRegistryResource(subject, space, "read", options);
  expect(read.hosts).toEqual([{ nodeDid, urls: ["https://test-node.invalid"], source: "offchain" }]);
  await expect(resolveRegistryResource(subject, space, "write", options)).rejects.toMatchObject({ code: "node_not_found" });
  release(new Response(await body(12)));
  await refreshOwnerRegistry(subject, options);
  expect((await resolveRegistryResource(subject, space, "write", { cacheStore, fetch: down })).hosts[0]?.nodeDid).toBe(nodeDid);
});

test("concurrent clients cannot overwrite a higher persisted sequence with a late response", async () => {
  const backing = createInMemoryRegistryCacheStore();
  const client = (): RegistryCacheStore => ({ get: backing.get, update: backing.update });
  const slow = client(), fast = client();
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  const older = refreshOwnerRegistry(subject, { cacheStore: slow, fetch: (async () => pending) as typeof fetch });
  await refreshOwnerRegistry(subject, { cacheStore: fast, fetch: answer(await body(22)) });
  release(new Response(await body(21)));
  expect(await older).toMatchObject({ status: "registered", sequence: 22 });
  expect((await backing.get(owner.address))?.sequence).toBe(22);
});

test("cold transport compatibility never swallows corruption, invalid records or registration evidence", async () => {
  expect(await resolveOwnerHosts(subject, { cacheStore: createInMemoryRegistryCacheStore(), fetch: down })).toMatchObject({ status: "unregistered", offline: true });
  const sequenceStore = createInMemoryRegistrySequenceStore();
  await sequenceStore.set(owner.address, 30);
  expect(await resolveOwnerHosts(subject, { cacheStore: createInMemoryRegistryCacheStore(), sequenceStore, fetch: down })).toMatchObject({ status: "unavailable", reason: "network-error" });
  const cacheStore = createInMemoryRegistryCacheStore();
  const invalid = (await body(31)).replace("test-node.invalid", "forged-node.invalid");
  expect(await resolveOwnerHosts(subject, { cacheStore, fetch: answer(invalid) })).toMatchObject({ status: "unavailable", reason: "invalid-signature" });
  expect(await resolveOwnerHosts(subject, { cacheStore, fetch: answer("{broken") })).toMatchObject({ status: "unavailable", reason: "malformed-response" });
  await resolveOwnerHosts(subject, { cacheStore, fetch: answer(await body(31)) });
  const missing = (async () => new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 })) as typeof fetch;
  expect(await refreshOwnerRegistry(subject, { cacheStore, sequenceStore, fetch: missing })).toMatchObject({ status: "unavailable", reason: "not-found-after-registered" });
  expect((await resolveOwnerHosts(subject, { cacheStore, fetch: down })).status).toBe("registered");
});

test("a verified v1-only owner stays registered evidence without blocking a later v2 sequence zero", async () => {
  const cacheStore = createInMemoryRegistryCacheStore();
  const sequenceStore = createInMemoryRegistrySequenceStore();
  const record = await signLocationRecord({ version: 1, subject, sequence: 7,
    multiaddrs: ["/dns4/test-node.invalid/tcp/443/https"], updated_at: "2026-11-04T00:00:00.000Z",
  }, { type: "did:pkh", signMessage: (message) => owner.signMessage({ message }) });
  const fetchLegacy = (async (url: string | URL | Request) => String(url).includes("/v2/")
    ? new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 }) : Response.json({ record })) as typeof fetch;
  expect(await resolveOwnerHosts(subject, { cacheStore, sequenceStore, fetch: fetchLegacy })).toMatchObject({ status: "unavailable", reason: "unsupported-format" });
  expect(await resolveOwnerHosts(subject, { cacheStore, sequenceStore, fetch: down })).toMatchObject({ status: "unavailable", reason: "network-error" });
  expect(await resolveOwnerHosts(subject, { cacheStore, sequenceStore, fetch: answer(await body(0)) })).toMatchObject({ status: "registered", sequence: 0 });
});

const httpFailure = (status: number): typeof fetch => Object.assign(
  async () => new Response("TEST registry failure", { status }), { preconnect: fetch.preconnect },
);

for (const failure of ["503", "transport", "timeout"] as const) {
  test(`cold ${failure} selects the configured/default node and logs once, not during background lookup`, async () => {
    const cacheStore = createInMemoryRegistryCacheStore();
    const sequenceStore = createInMemoryRegistrySequenceStore();
    const fetchFn = failure === "503" ? httpFailure(503) : failure === "transport" ? down
      : Object.assign(async () => new Promise<Response>(() => {}), { preconnect: fetch.preconnect });
    const options = { cacheStore, sequenceStore, fetch: fetchFn, timeoutMs: 5, autoDiscoverLocalNode: false,
      ...(failure === "transport" ? { newUserHost: "https://configured.invalid" } : {}) };
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await refreshOwnerRegistry(subject, options)).toMatchObject({ status: "unregistered", offline: true });
      expect(warning).not.toHaveBeenCalled();
      for (let selected = 0; selected < 2; selected++) {
        expect((await resolveFailClosedTinyCloudHosts(owner.address, options)).hosts)
          .toEqual([failure === "transport" ? "https://configured.invalid" : DEFAULT_NEW_USER_HOST]);
      }
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith("registry unavailable; using the default node");
      expect(await cacheStore.get(owner.address)).toBeUndefined();
      expect(await sequenceStore.get(owner.address)).toBeUndefined();
    } finally { warning.mockRestore(); }
  });
}

test("warm HTTP503 routes the reverified signed cache without default fallback or warning", async () => {
  const cacheStore = createInMemoryRegistryCacheStore();
  const sequenceStore = createInMemoryRegistrySequenceStore();
  await resolveOwnerHosts(subject, { cacheStore, sequenceStore, fetch: answer(await body(44)) });
  const before = await cacheStore.get(owner.address);
  const warnings: string[] = [];
  const options = { cacheStore, sequenceStore, fetch: httpFailure(503), newUserHost: "https://unlisted.invalid",
    autoDiscoverLocalNode: false, onRegistryFallback: (reason: string) => { warnings.push(reason); } };
  expect((await resolveFailClosedTinyCloudHosts(owner.address, options)).hosts).toEqual(["https://test-node.invalid"]);
  await refreshOwnerRegistry(subject, options);
  expect((await resolveFailClosedTinyCloudHosts(owner.address, options)).hosts).toEqual(["https://test-node.invalid"]);
  expect(await cacheStore.get(owner.address)).toEqual(before);
  expect(warnings).toEqual([]);
});

test("cold HTTP failures do not forget known registration or turn 4xx into default routing", async () => {
  const warnings: string[] = [];
  const options = { cacheStore: createInMemoryRegistryCacheStore(), autoDiscoverLocalNode: false,
    onRegistryFallback: (reason: string) => { warnings.push(reason); } };
  for (const status of [401, 403, 429]) {
    await expect(resolveFailClosedTinyCloudHosts(owner.address, { ...options, fetch: httpFailure(status) }))
      .rejects.toMatchObject({ code: "registry_unavailable", verdict: { reason: "http-status" } });
  }
  const sequenceStore = createInMemoryRegistrySequenceStore();
  await sequenceStore.set(owner.address, 0); // Also the retained marker for known v1-only registration.
  await expect(resolveFailClosedTinyCloudHosts(owner.address, { ...options, sequenceStore, fetch: httpFailure(503) }))
    .rejects.toMatchObject({ code: "registry_unavailable", verdict: { reason: "http-status" } });
  await expect(resolveFailClosedTinyCloudHosts(owner.address, { ...options, fetch: httpFailure(503), newUserHost: null }))
    .rejects.toMatchObject({ code: "node_not_found" });
  expect(warnings).toEqual([]);
});

test("cold v2 outage still refuses a verified v1 record or a v1 HTTP4xx refusal", async () => {
  const cacheStore = createInMemoryRegistryCacheStore();
  const sequenceStore = createInMemoryRegistrySequenceStore();
  const record = await signLocationRecord({ version: 1, subject, sequence: 2,
    multiaddrs: ["/dns4/test-node.invalid/tcp/443/https"], updated_at: "2026-11-04T00:00:00.000Z",
  }, { type: "did:pkh", signMessage: (message) => owner.signMessage({ message }) });
  const fetchLegacy = Object.assign(async (url: string | URL | Request) => String(url).includes("/v2/")
    ? new Response("down", { status: 503 }) : Response.json({ record }), { preconnect: fetch.preconnect });
  const warnings: string[] = [];
  const options = { cacheStore, sequenceStore, fetch: fetchLegacy, autoDiscoverLocalNode: false,
    onRegistryFallback: (reason: string) => { warnings.push(reason); } };
  await expect(resolveFailClosedTinyCloudHosts(owner.address, options))
    .rejects.toMatchObject({ code: "registry_unavailable", verdict: { reason: "unsupported-format" } });
  expect(await sequenceStore.get(owner.address)).toBe(0);
  const v1Refusal = Object.assign(async (url: string | URL | Request) =>
    new Response("refused", { status: String(url).includes("/v2/") ? 503 : 403 }), { preconnect: fetch.preconnect });
  await expect(resolveFailClosedTinyCloudHosts(owner.address, {
    cacheStore: createInMemoryRegistryCacheStore(), fetch: v1Refusal, autoDiscoverLocalNode: false,
    onRegistryFallback: options.onRegistryFallback,
  })).rejects.toMatchObject({ code: "registry_unavailable", verdict: { reason: "http-status" } });
  expect(warnings).toEqual([]);
});

test("refresh rejects a noncanonical owner before cache or network access", async () => {
  let cacheReads = 0, requests = 0;
  const cacheStore: RegistryCacheStore = {
    get: async () => { cacheReads++; return undefined; },
    update: async () => { throw new Error("Invalid owner must not update storage"); },
  };
  const fetchFn = Object.assign(async () => { requests++; throw new Error("Invalid owner must not reach the network"); },
    { preconnect: fetch.preconnect });
  await expect(refreshOwnerRegistry("not-an-owner", { cacheStore, fetch: fetchFn })).rejects.toBeInstanceOf(RegistryLookupInputError);
  expect({ cacheReads, requests }).toEqual({ cacheReads: 0, requests: 0 });
});

test("a restored verified cache establishes highwater before later cache loss and registry outage", async () => {
  const persisted = createInMemoryRegistryCacheStore();
  await resolveOwnerHosts(subject, { cacheStore: persisted, fetch: answer(await body(63)) });
  let visible = true;
  const cacheStore: RegistryCacheStore = {
    get: (key) => visible ? persisted.get(key) : Promise.resolve(undefined),
    update: persisted.update,
  };
  const sequenceStore = createInMemoryRegistrySequenceStore();
  const warnings: string[] = [];
  const options = { cacheStore, sequenceStore, fetch: httpFailure(503), autoDiscoverLocalNode: false,
    newUserHost: "https://unlisted.invalid", onRegistryFallback: (reason: string) => { warnings.push(reason); } };
  expect((await resolveFailClosedTinyCloudHosts(owner.address, options)).hosts).toEqual(["https://test-node.invalid"]);
  await refreshOwnerRegistry(subject, options);
  visible = false;
  await expect(resolveFailClosedTinyCloudHosts(owner.address, options))
    .rejects.toMatchObject({ code: "registry_unavailable", verdict: { reason: "http-status" } });
  expect(await sequenceStore.get(owner.address)).toBe(63);
  expect(warnings).toEqual([]);
});

test("fresh Core callers without a cache adapter receive the same outage policy and known-owner guard", async () => {
  for (const failure of [500, 503, 599, "transport", "timeout"] as const) {
    const sequenceStore = createInMemoryRegistrySequenceStore();
    const warnings: string[] = [];
    const fetchFn = typeof failure === "number" ? httpFailure(failure) : failure === "transport" ? down
      : Object.assign(async () => new Promise<Response>(() => {}), { preconnect: fetch.preconnect });
    const options = { sequenceStore, fetch: fetchFn, timeoutMs: 5, autoDiscoverLocalNode: false,
      newUserHost: "https://configured.invalid", onRegistryFallback: (reason: string) => { warnings.push(reason); } };
    expect((await resolveFailClosedTinyCloudHosts(owner.address, options)).hosts).toEqual(["https://configured.invalid"]);
    expect(warnings).toEqual(["registry unavailable; using the default node"]);
    expect(await sequenceStore.get(owner.address)).toBeUndefined();
    await sequenceStore.set(owner.address, 0);
    await expect(resolveFailClosedTinyCloudHosts(owner.address, options)).rejects.toMatchObject({ code: "registry_unavailable" });
    expect(warnings).toHaveLength(1);
  }
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await resolveFailClosedTinyCloudHosts(owner.address, { fetch: httpFailure(502), autoDiscoverLocalNode: false })).hosts)
      .toEqual([DEFAULT_NEW_USER_HOST]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("registry unavailable; using the default node");
  } finally { warning.mockRestore(); }
});

test("a known-zero caller cannot inherit an older cold refresh's default authorization", async () => {
  const cacheStore = createInMemoryRegistryCacheStore(), sequenceStore = createInMemoryRegistrySequenceStore();
  const started = Promise.withResolvers<void>(), outage = Promise.withResolvers<Response>(), knownRead = Promise.withResolvers<void>();
  let watching = false, requests = 0;
  const observedSequence = {
    set: sequenceStore.set,
    async get(key: string) {
      const sequence = await sequenceStore.get(key);
      if (watching && sequence === 0) knownRead.resolve();
      return sequence;
    },
  };
  const fetchFn = Object.assign(async (input: string | URL | Request) => {
    requests++;
    if (String(input).includes("/v2/")) { started.resolve(); return outage.promise; }
    return new Response("TEST outage", { status: 503 });
  }, { preconnect: fetch.preconnect });
  const warnings: string[] = [];
  const options = { cacheStore, sequenceStore: observedSequence, fetch: fetchFn, autoDiscoverLocalNode: false,
    newUserHost: "https://unlisted.invalid", onRegistryFallback: (reason: string) => { warnings.push(reason); } };
  const first = refreshOwnerRegistry(subject, options);
  await started.promise;
  expect(await resolveOwnerHosts(subject, { sequenceStore, fetch: answer(await body(0)) }))
    .toMatchObject({ status: "registered", sequence: 0 });
  expect(await sequenceStore.get(owner.address)).toBe(0);
  watching = true;
  const second = resolveFailClosedTinyCloudHosts(owner.address, options);
  const outcome = second.then(() => undefined, (error: unknown) => error);
  await knownRead.promise;
  outage.resolve(new Response("TEST outage", { status: 503 }));
  expect(await outcome).toMatchObject({ code: "registry_unavailable" });
  expect((await first).status).toBe("unavailable");
  expect(requests).toBe(2);
  expect(warnings).toEqual([]);
  expect(await cacheStore.get(owner.address)).toBeUndefined();
  const freshWarnings: string[] = [];
  expect((await resolveFailClosedTinyCloudHosts(owner.address, {
    cacheStore: createInMemoryRegistryCacheStore(), sequenceStore: createInMemoryRegistrySequenceStore(),
    fetch: httpFailure(503), autoDiscoverLocalNode: false, newUserHost: "https://configured.invalid",
    onRegistryFallback: (reason) => { freshWarnings.push(reason); },
  })).hosts).toEqual(["https://configured.invalid"]);
  expect(freshWarnings).toEqual(["registry unavailable; using the default node"]);
});

test("direct refresh repairs restored highwater before outage I/O and later cache absence", async () => {
  const persisted = createInMemoryRegistryCacheStore();
  await resolveOwnerHosts(subject, { cacheStore: persisted, fetch: answer(await body(73)) });
  let visible = true;
  const cacheStore: RegistryCacheStore = {
    get: (key) => visible ? persisted.get(key) : Promise.resolve(undefined),
    update: persisted.update,
  };
  const sequenceStore = createInMemoryRegistrySequenceStore();
  const observedAtFetch: Array<number | undefined> = [], warnings: string[] = [];
  const options = { cacheStore, sequenceStore, autoDiscoverLocalNode: false, newUserHost: "https://unlisted.invalid",
    fetch: Object.assign(async () => {
      observedAtFetch.push(await sequenceStore.get(owner.address));
      return new Response("TEST outage", { status: 503 });
    }, { preconnect: fetch.preconnect }),
    onRegistryFallback: (reason: string) => { warnings.push(reason); } };
  expect(await sequenceStore.get(owner.address)).toBeUndefined();
  expect(await refreshOwnerRegistry(subject, options)).toMatchObject({ status: "unavailable", reason: "http-status" });
  expect(observedAtFetch).toEqual([73]);
  expect(await sequenceStore.get(owner.address)).toBe(73);
  visible = false;
  await expect(resolveFailClosedTinyCloudHosts(owner.address, options)).rejects.toMatchObject({ code: "registry_unavailable" });
  expect(warnings).toEqual([]);
});

test("the shared browser sequence lock retains every owner's zero and maximum across cache loss", async () => {
  const platform = installTestWebLocks();
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const held = platform.locks.request(DEFAULT_REGISTRY_SEQUENCE_STORAGE_KEY, async () => { entered.resolve(); await release.promise; });
  const pending: Promise<void>[] = [];
  try {
    await entered.promise;
    const first = createLocalStorageRegistrySequenceStore(storage), second = createLocalStorageRegistrySequenceStore(storage);
    for (const [store, key, sequence] of [[first, owner.address, 0], [second, other, 0], [second, owner.address, 9], [first, owner.address, 4]] as const) {
      pending.push(Promise.resolve(store.set(key, sequence)));
    }
    await Promise.resolve();
    expect(storage.getItem(DEFAULT_REGISTRY_SEQUENCE_STORAGE_KEY)).toBeNull();
    release.resolve(); await held; await Promise.all(pending);
    const reloaded = createLocalStorageRegistrySequenceStore(storage);
    expect(await reloaded.get(owner.address)).toBe(9);
    expect(await reloaded.get(other)).toBe(0);
    const warnings: string[] = [];
    for (const address of [owner.address, other]) {
      await expect(resolveFailClosedTinyCloudHosts(address, {
        cacheStore: createInMemoryRegistryCacheStore(), sequenceStore: reloaded, fetch: httpFailure(503), autoDiscoverLocalNode: false,
        newUserHost: "https://unlisted.invalid", onRegistryFallback: (reason) => { warnings.push(reason); },
      })).rejects.toMatchObject({ code: "registry_unavailable" });
    }
    expect(warnings).toEqual([]);
  } finally {
    release.resolve(); await held; await Promise.allSettled(pending); platform.restore();
  }
});
