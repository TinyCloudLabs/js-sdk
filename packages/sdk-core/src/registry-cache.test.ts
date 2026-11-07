import { expect, spyOn, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { signLocationRecord, signLocationRecordV2 } from "./location";
import type { LocationRecordV2Payload } from "./location";
import { createInMemoryRegistryCacheStore, createLocalStorageRegistryCacheStore, verifyRegistryCacheEntry } from "./registry-cache";
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

test("equal online sequence renews freshness without replacing signed bytes; rollback never renews", async () => {
  const cacheStore = createInMemoryRegistryCacheStore();
  const raw = await body(8);
  await resolveOwnerHosts(subject, { cacheStore, fetch: answer(raw) });
  await cacheStore.update(owner.address, async (current) => ({ ...current!, fetchedAt: 1 }));
  const clock = spyOn(Date, "now").mockReturnValue(10_000_000);
  try {
    await refreshOwnerRegistry(subject, { cacheStore, fetch: answer(await body(8, "read-write", "https://other.invalid")) });
    const renewed = (await cacheStore.get(owner.address))!;
    expect(renewed.responseBody).toBe(raw);
    expect(renewed.fetchedAt).toBe(10_000_000);
    expect(await refreshOwnerRegistry(subject, { cacheStore, fetch: answer(await body(7)) }))
      .toMatchObject({ status: "unavailable", reason: "rollback" });
    expect(await cacheStore.get(owner.address)).toEqual(renewed);
    const upgraded = await body(9, "read-only", "https://new.invalid");
    expect(await refreshOwnerRegistry(subject, { cacheStore, fetch: answer(upgraded) })).toMatchObject({ status: "registered", sequence: 9 });
    expect((await cacheStore.get(owner.address))?.responseBody).toBe(upgraded);
  } finally { clock.mockRestore(); }
});

test("each warm routing decision awaits a coalesced refresh and immediately applies changed membership", async () => {
  const cacheStore = createInMemoryRegistryCacheStore();
  await resolveOwnerHosts(subject, { cacheStore, fetch: answer(await body(11)) });
  const started = Promise.withResolvers<void>(), reply = Promise.withResolvers<Response>();
  let requests = 0, settled = 0;
  const options = { cacheStore, fetch: Object.assign(async () => {
    requests++; started.resolve(); return reply.promise;
  }, { preconnect: fetch.preconnect }) };
  const read = resolveRegistryResource(subject, space, "read", options).finally(() => { settled++; });
  const write = resolveRegistryResource(subject, space, "write", options).then(() => undefined, (error: unknown) => error);
  await started.promise;
  await Promise.resolve();
  expect(settled).toBe(0);
  reply.resolve(new Response(await body(12, "read-only")));
  expect((await read).hosts).toEqual([{ nodeDid, urls: ["https://test-node.invalid"], source: "offchain" }]);
  expect(await write).toMatchObject({ code: "node_not_found" });
  expect(requests).toBe(1);
  let nextRequests = 0;
  expect((await resolveRegistryResource(subject, space, "write", { cacheStore, fetch: Object.assign(async () => {
    nextRequests++; return new Response(await body(13));
  }, { preconnect: fetch.preconnect }) })).hosts[0]?.nodeDid).toBe(nodeDid);
  expect(nextRequests).toBe(1);
});

test("concurrent clients cannot overwrite a higher persisted sequence with a late response", async () => {
  const backing = createInMemoryRegistryCacheStore();
  const client = (): RegistryCacheStore => ({ get: backing.get, update: backing.update, delete: backing.delete });
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
  expect((await resolveOwnerHosts(subject, { cacheStore, fetch: down })).status).toBe("unavailable");
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

for (const failure of [502, 503, 504, "transport", "timeout"] as const) {
  test(`warm ${failure} uses only under-one-hour signed cache and emits one semantic warning`, async () => {
    const cacheStore = createInMemoryRegistryCacheStore(), sequenceStore = createInMemoryRegistrySequenceStore();
    await resolveOwnerHosts(subject, { cacheStore, sequenceStore, fetch: answer(await body(44)) });
    const now = 10_000_000;
    await cacheStore.update(owner.address, async (current) => ({ ...current!, fetchedAt: now - 3_600_000 + 1 }));
    const before = await cacheStore.get(owner.address);
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const warnings: unknown[][] = [];
    const fetchFn = typeof failure === "number" ? httpFailure(failure) : failure === "transport" ? down
      : Object.assign(async () => new Promise<Response>(() => {}), { preconnect: fetch.preconnect });
    const options = { cacheStore, sequenceStore, fetch: fetchFn, timeoutMs: 5, newUserHost: "https://unlisted.invalid",
      autoDiscoverLocalNode: false, onRegistryFallback: (...args: unknown[]) => { warnings.push(args); } };
    try {
      for (let selected = 0; selected < 2; selected++) {
        expect((await resolveFailClosedTinyCloudHosts(owner.address, options)).hosts).toEqual(["https://test-node.invalid"]);
      }
      expect(warnings).toEqual([["Storage settings are unreachable; using cached settings checked less than 1 hour ago.", "using_cached_settings"]]);
      expect(await cacheStore.get(owner.address)).toEqual(before);
      expect(await sequenceStore.get(owner.address)).toBe(44);
      for (const age of [3_600_000, 3_600_001, -1]) {
        await cacheStore.update(owner.address, async (current) => ({ ...current!, fetchedAt: now - age }));
        await expect(resolveFailClosedTinyCloudHosts(owner.address, options)).rejects.toMatchObject({ code: "registry_unavailable" });
        expect(warnings).toHaveLength(1);
      }
    } finally { clock.mockRestore(); }
  });
}

test("warm HTTP500, other statuses, invalid signatures and rollback fail closed without renewing cache", async () => {
  const cacheStore = createInMemoryRegistryCacheStore(), sequenceStore = createInMemoryRegistrySequenceStore();
  await resolveOwnerHosts(subject, { cacheStore, sequenceStore, fetch: answer(await body(0)) });
  const before = await cacheStore.get(owner.address), warnings: string[] = [];
  const options = { cacheStore, sequenceStore, autoDiscoverLocalNode: false, newUserHost: "https://unlisted.invalid",
    onRegistryFallback: (reason: string) => { warnings.push(reason); } };
  for (const status of [500, 501, 505, 599]) {
    await expect(resolveFailClosedTinyCloudHosts(owner.address, { ...options, fetch: httpFailure(status) }))
      .rejects.toMatchObject({ code: "registry_unavailable", verdict: { reason: "http-status" } });
  }
  const invalid = (await body(1)).replace("test-node.invalid", "forged-node.invalid");
  await expect(resolveFailClosedTinyCloudHosts(owner.address, { ...options, fetch: answer(invalid) }))
    .rejects.toMatchObject({ code: "registry_unavailable", verdict: { reason: "invalid-signature" } });
  expect(await cacheStore.get(owner.address)).toEqual(before);
  expect(await sequenceStore.get(owner.address)).toBe(0);
  await sequenceStore.set(owner.address, 1);
  await expect(resolveFailClosedTinyCloudHosts(owner.address, { ...options, fetch: down }))
    .rejects.toMatchObject({ code: "registry_unavailable" });
  expect(warnings).toEqual([]);
});

for (const authoritative of [401, 403, 404, 410, 429, "missing-space", "read-only"] as const) {
  test(`authoritative ${authoritative} drops warm cache and a later outage cannot resurrect it`, async () => {
    const cacheStore = createInMemoryRegistryCacheStore(), sequenceStore = createInMemoryRegistrySequenceStore();
    await resolveOwnerHosts(subject, { cacheStore, sequenceStore, fetch: answer(await body(0)) });
    const warnings: string[] = [];
    const options = { cacheStore, sequenceStore, autoDiscoverLocalNode: false, newUserHost: "https://unlisted.invalid",
      onRegistryFallback: (reason: string) => { warnings.push(reason); } };
    let fetchFn: typeof fetch;
    if (typeof authoritative === "number") fetchFn = httpFailure(authoritative);
    else {
      const { signature: _, ...payload } = JSON.parse(await body(1, "read-only")).record;
      if (authoritative === "missing-space") payload.spaces = [];
      const record = await signLocationRecordV2(payload, { type: "did:pkh", signMessage: (message) => owner.signMessage({ message }) });
      fetchFn = answer(JSON.stringify({ record }));
    }
    await expect(resolveRegistryResource(subject, space, "write", { ...options, fetch: fetchFn })).rejects.toMatchObject({
      code: typeof authoritative === "number" ? "registry_unavailable" : "node_not_found",
    });
    expect(await cacheStore.get(owner.address)).toBeUndefined();
    expect(await sequenceStore.get(owner.address)).toBe(typeof authoritative === "number" ? 0 : 1);
    await expect(resolveFailClosedTinyCloudHosts(owner.address, { ...options, fetch: httpFailure(503) }))
      .rejects.toMatchObject({ code: "registry_unavailable" });
    expect(warnings).toEqual([]);
  });
}

test("authoritative deletion retains known-owner evidence without an optional sequence adapter", async () => {
  const cacheStore = createInMemoryRegistryCacheStore();
  await resolveOwnerHosts(subject, { cacheStore, fetch: answer(await body(0)) });
  await expect(resolveRegistryResource(subject, space, "read", { cacheStore, fetch: httpFailure(403) }))
    .rejects.toMatchObject({ code: "registry_unavailable" });
  expect(await cacheStore.get(owner.address)).toBeUndefined();
  await expect(resolveFailClosedTinyCloudHosts(owner.address, {
    cacheStore, fetch: httpFailure(502), autoDiscoverLocalNode: false,
  })).rejects.toMatchObject({ code: "registry_unavailable" });
});

for (const failure of ["marker", "delete"] as const) {
  test(`authoritative ${failure} storage failure refuses now and blocks later cached fallback`, async () => {
    const backing = createInMemoryRegistryCacheStore(), sequences = createInMemoryRegistrySequenceStore();
    const cacheStore: RegistryCacheStore = {
      get: backing.get, update: backing.update,
      delete: async (key) => {
        if (failure === "delete") throw new Error("TEST deletion unavailable");
        await backing.delete(key);
      },
    };
    await resolveOwnerHosts(subject, { cacheStore, sequenceStore: sequences, fetch: answer(await body(0)) });
    const sequenceStore = { get: sequences.get, set: async () => { throw new Error("TEST marker unavailable"); } };
    const options = { cacheStore, sequenceStore: failure === "marker" ? sequenceStore : sequences };
    await expect(resolveRegistryResource(subject, space, "write", { ...options, fetch: httpFailure(403) }))
      .rejects.toMatchObject({ code: "registry_unavailable" });
    expect((await backing.get(owner.address))?.sequence).toBe(0);
    await expect(resolveFailClosedTinyCloudHosts(owner.address, { ...options, fetch: httpFailure(503), autoDiscoverLocalNode: false }))
      .rejects.toMatchObject({ code: "registry_unavailable" });
  });
}

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
    delete: async () => { throw new Error("Invalid owner must not delete storage"); },
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
    delete: persisted.delete,
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
  expect(warnings).toEqual(["Storage settings are unreachable; using cached settings checked less than 1 hour ago."]);
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

test("a shared registered refresh respects independent caller highwaters and remembers each accepted result", async () => {
  const backing = createInMemoryRegistryCacheStore();
  const firstSequence = createInMemoryRegistrySequenceStore(), knownSequence = createInMemoryRegistrySequenceStore();
  const freshSequence = createInMemoryRegistrySequenceStore();
  const latest = await body(7, "read-write", "https://current.TEST-node.invalid");
  const retired = await body(0, "read-write", "https://retired.TEST-node.invalid");
  expect(await resolveOwnerHosts(subject, { sequenceStore: knownSequence, fetch: answer(latest) }))
    .toMatchObject({ status: "registered", sequence: 7 });
  let onEmptyRead: (() => void) | undefined;
  const cacheStore: RegistryCacheStore = {
    update: backing.update,
    delete: backing.delete,
    async get(key) {
      const current = await backing.get(key);
      // The awaiting caller resumes before the test gate, so it joins before I/O is released.
      if (current === undefined && onEmptyRead) queueMicrotask(onEmptyRead);
      return current;
    },
  };
  const started = Promise.withResolvers<void>(), reply = Promise.withResolvers<Response>();
  let requests = 0;
  const fetchFn = Object.assign(async () => { requests++; started.resolve(); return reply.promise; }, { preconnect: fetch.preconnect });
  const first = refreshOwnerRegistry(subject, { cacheStore, sequenceStore: firstSequence, fetch: fetchFn });
  const pending: Promise<unknown>[] = [first];
  try {
    await started.promise;
    expect(await knownSequence.get(owner.address)).toBe(7);
    const knownRead = Promise.withResolvers<void>(), warnings: string[] = [];
    onEmptyRead = knownRead.resolve;
    const joined = resolveFailClosedTinyCloudHosts(owner.address, {
      cacheStore, sequenceStore: knownSequence, fetch: fetchFn, autoDiscoverLocalNode: false,
      newUserHost: "https://unlisted.invalid", onRegistryFallback: (reason) => { warnings.push(reason); },
    });
    pending.push(joined);
    const outcome = joined.then(() => undefined, (error: unknown) => error);
    await knownRead.promise;
    const freshRead = Promise.withResolvers<void>();
    onEmptyRead = freshRead.resolve;
    const fresh = resolveOwnerHosts(subject, { cacheStore, sequenceStore: freshSequence, fetch: fetchFn });
    pending.push(fresh);
    await freshRead.promise;
    onEmptyRead = undefined;
    reply.resolve(new Response(retired));
    expect(await first).toMatchObject({ status: "registered", sequence: 0 });
    expect(await outcome).toMatchObject({ code: "registry_unavailable" });
    expect(await fresh).toMatchObject({ status: "registered", sequence: 0 });
    expect(await firstSequence.get(owner.address)).toBe(0);
    expect(await knownSequence.get(owner.address)).toBe(7);
    expect(await freshSequence.get(owner.address)).toBe(0);
    expect((await cacheStore.get(owner.address))?.responseBody).toBe(retired);
    expect(requests).toBe(1);
    expect(warnings).toEqual([]);
  } finally {
    reply.resolve(new Response(retired));
    await Promise.allSettled(pending);
  }
});

test("direct refresh repairs restored highwater before outage I/O and later cache absence", async () => {
  const persisted = createInMemoryRegistryCacheStore();
  await resolveOwnerHosts(subject, { cacheStore: persisted, fetch: answer(await body(73)) });
  let visible = true;
  const cacheStore: RegistryCacheStore = {
    get: (key) => visible ? persisted.get(key) : Promise.resolve(undefined),
    update: persisted.update,
    delete: persisted.delete,
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
  expect(await refreshOwnerRegistry(subject, options)).toMatchObject({ status: "registered", sequence: 73, offline: true });
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

test("browser deletion and persisted sequence survive a new cache adapter", async () => {
  const platform = installTestWebLocks();
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  try {
    const cacheStore = createLocalStorageRegistryCacheStore(storage), sequenceStore = createLocalStorageRegistrySequenceStore(storage);
    await resolveOwnerHosts(subject, { cacheStore, sequenceStore, fetch: answer(await body(0)) });
    await expect(resolveRegistryResource(subject, space, "read", { cacheStore, sequenceStore, fetch: httpFailure(403) }))
      .rejects.toMatchObject({ code: "registry_unavailable" });
    const reloaded = createLocalStorageRegistryCacheStore(storage), sequences = createLocalStorageRegistrySequenceStore(storage);
    expect(await reloaded.get(owner.address)).toBeUndefined();
    expect(await sequences.get(owner.address)).toBe(0);
    await expect(resolveFailClosedTinyCloudHosts(owner.address, {
      cacheStore: reloaded, sequenceStore: sequences, fetch: httpFailure(502), autoDiscoverLocalNode: false,
    })).rejects.toMatchObject({ code: "registry_unavailable" });
  } finally { platform.restore(); }
});

test("a fresh registered owner without any usable host is dropped before subsequent outage", async () => {
  const cacheStore = createInMemoryRegistryCacheStore(), sequenceStore = createInMemoryRegistrySequenceStore();
  await resolveOwnerHosts(subject, { cacheStore, sequenceStore, fetch: answer(await body(0)) });
  const { signature: _, ...payload } = JSON.parse(await body(1)).record;
  const record = await signLocationRecordV2({ ...payload, nodes: [], spaces: [], encryptionNode: null },
    { type: "did:pkh", signMessage: (message) => owner.signMessage({ message }) });
  const options = { cacheStore, sequenceStore, autoDiscoverLocalNode: false };
  await expect(resolveFailClosedTinyCloudHosts(owner.address, { ...options, fetch: answer(JSON.stringify({ record })) }))
    .rejects.toMatchObject({ code: "node_not_found" });
  expect(await cacheStore.get(owner.address)).toBeUndefined();
  expect(await sequenceStore.get(owner.address)).toBe(1);
  await expect(resolveFailClosedTinyCloudHosts(owner.address, { ...options, fetch: httpFailure(503) }))
    .rejects.toMatchObject({ code: "registry_unavailable" });
});
