/**
 * TC-2970: the opt-in registry verdict cache. One lookup per registry URL and
 * owner DID while a verdict is fresh; failures, outages and route denials are
 * never served from it.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

import { signLocationRecordV2, type LocationRecordV2Payload } from "./location";
import { createInMemoryRegistryCacheStore } from "./registry-cache";
import {
  createInMemoryRegistrySequenceStore,
  lookupOwnerRegistryVerdict,
  registryOwnerSubjectV1,
  resolveFailClosedTinyCloudHosts,
  resolveRegistryResource,
} from "./registry-policy";
import {
  REGISTRY_VERDICT_CACHE_MAX_ENTRIES,
  REGISTRY_VERDICT_REGISTERED_TTL_MS,
  REGISTRY_VERDICT_UNREGISTERED_TTL_MS,
  createRegistryVerdictCache,
} from "./registry-verdict-cache";
import { REGISTRY_NOT_FOUND_BODY, type RegistryVerdict } from "./registry-verdict";

const REGISTRY = "https://registry.test";
// Test-only keys; never real owners.
const owner = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const other = privateKeyToAccount("0x1111111111111111111111111111111111111111111111111111111111111111");
const SUBJECT = registryOwnerSubjectV1(owner.address);
const OTHER_SUBJECT = registryOwnerSubjectV1(other.address);
const SPACE = `tinycloud:pkh:eip155:1:${owner.address}:courier`;
const NODE_DID = "did:key:z6MkixsGj3MVGKMug2VMC2JbtzX3UjaAcfRs7G1RjbSnZJaH";
const NODE_URL = "https://node.test";

async function recordBody(spaces: string[] = [SPACE], sequence = 1): Promise<string> {
  const payload: LocationRecordV2Payload = {
    version: 2,
    subject: SUBJECT,
    nodes: [{ did: NODE_DID, url: NODE_URL }],
    spaces: spaces.map((space) => ({ space, nodes: [{ did: NODE_DID, mode: "read-write" as const }] })),
    encryptionNode: NODE_DID,
    updated_at: "2026-11-13T00:00:00.000Z",
    sequence,
  };
  const record = await signLocationRecordV2(payload, { type: "did:pkh", signMessage: (message) => owner.signMessage({ message }) });
  return JSON.stringify({ record });
}

type Answer = (url: string) => Response | Promise<Response>;

/** A registry answering every request with `answer`; every requested URL is recorded. */
function registry(answer: Answer) {
  const requests: string[] = [];
  const state = { answer };
  const fetchFn = Object.assign(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    return state.answer(url);
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  return { requests, fetch: fetchFn, set(next: Answer) { state.answer = next; } };
}

const notFound = () => new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
const v2 = (url: string) => url.includes("/v2/locations/");
const v1 = (url: string) => url.includes("/v1/locations/");

function clock(start = 1_000_000) {
  const state = { now: start };
  return { now: () => state.now, advance(ms: number) { state.now += ms; } };
}

describe("registry verdict cache (TC-2970)", () => {
  it("serves N lookups of a registered owner from one v2 request; v1 is never called", async () => {
    const body = await recordBody();
    const r = registry(() => new Response(body));
    const verdictCache = createRegistryVerdictCache();
    for (let i = 0; i < 20; i++) {
      const route = await resolveRegistryResource(SUBJECT, SPACE, "write", { registryUrl: REGISTRY, fetch: r.fetch, verdictCache });
      expect(route.hosts[0]?.nodeDid).toBe(NODE_DID);
    }
    expect(r.requests.filter(v2)).toHaveLength(1);
    expect(r.requests.filter(v1)).toHaveLength(0);
  });

  it("serves N lookups of a confirmed unregistered owner (v2 404, v1 404) from one v2 and one v1 request", async () => {
    const r = registry(notFound);
    const verdictCache = createRegistryVerdictCache();
    for (let i = 0; i < 20; i++) {
      const route = await resolveRegistryResource(SUBJECT, SPACE, "read", { registryUrl: REGISTRY, fetch: r.fetch, verdictCache });
      expect(route.verdict.status).toBe("unregistered");
    }
    expect(r.requests.filter(v2)).toHaveLength(1);
    expect(r.requests.filter(v1)).toHaveLength(1);
  });

  it("concurrent callers share one in-flight lookup", async () => {
    const body = await recordBody();
    const reply = Promise.withResolvers<Response>();
    const r = registry(() => reply.promise);
    const verdictCache = createRegistryVerdictCache();
    const pending = Array.from({ length: 10 }, () =>
      resolveRegistryResource(SUBJECT, SPACE, "read", { registryUrl: REGISTRY, fetch: r.fetch, verdictCache }));
    await Promise.resolve();
    reply.resolve(new Response(body));
    const routes = await Promise.all(pending);
    expect(routes.every((route) => route.hosts[0]?.nodeDid === NODE_DID)).toBe(true);
    expect(r.requests).toHaveLength(1);
  });

  it("a different owner DID or a different registry URL gets its own lookup", async () => {
    const r = registry(notFound);
    const verdictCache = createRegistryVerdictCache();
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, verdictCache });
    await lookupOwnerRegistryVerdict(OTHER_SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, verdictCache });
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: "https://registry-two.test", fetch: r.fetch, verdictCache });
    expect(r.requests.filter(v2).map((url) => new URL(url).origin + decodeURIComponent(new URL(url).pathname))).toEqual([
      `${REGISTRY}/v2/locations/${owner.address}`,
      `${REGISTRY}/v2/locations/${other.address}`,
      `https://registry-two.test/v2/locations/${owner.address}`,
    ]);
  });

  it("a failed lookup is not cached: the next call asks the registry again", async () => {
    const r = registry(() => { throw new TypeError("fetch failed"); });
    const verdictCache = createRegistryVerdictCache();
    await expect(lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, verdictCache }))
      .rejects.toMatchObject({ code: "registry_unavailable" });
    const failed = r.requests.length;
    r.set(notFound);
    expect((await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, verdictCache })).status).toBe("unregistered");
    expect(r.requests.length).toBeGreaterThan(failed);
  });

  it("an unavailable verdict (5xx) is not cached", async () => {
    const body = await recordBody();
    const sequenceStore = createInMemoryRegistrySequenceStore();
    const verdictCache = createRegistryVerdictCache();
    const r = registry(() => new Response(body));
    // Known owner, so a 5xx is an unavailable verdict rather than a cold outage.
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, sequenceStore });
    r.set(() => new Response("down", { status: 503 }));
    expect((await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, sequenceStore, verdictCache })).status).toBe("unavailable");
    r.set(() => new Response(body));
    expect((await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, sequenceStore, verdictCache })).status).toBe("registered");
    expect(r.requests).toHaveLength(3);
  });

  it("a cached-settings fallback during an outage is not cached", async () => {
    const body = await recordBody();
    const cacheStore = createInMemoryRegistryCacheStore();
    const sequenceStore = createInMemoryRegistrySequenceStore();
    const verdictCache = createRegistryVerdictCache();
    const r = registry(() => new Response(body));
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, cacheStore, sequenceStore });
    r.set(() => new Response("down", { status: 503 }));
    const fallback = await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, cacheStore, sequenceStore, verdictCache });
    expect(fallback).toMatchObject({ status: "registered", offline: true });
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, cacheStore, sequenceStore, verdictCache });
    expect(r.requests).toHaveLength(3);
  });

  it("a registered record is reused for 5 minutes, then looked up again", async () => {
    expect(REGISTRY_VERDICT_REGISTERED_TTL_MS).toBe(300_000);
    const body = await recordBody();
    const r = registry(() => new Response(body));
    const time = clock();
    const verdictCache = createRegistryVerdictCache({ now: time.now });
    const lookup = () => lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, verdictCache });
    await lookup();
    time.advance(299_999);
    await lookup();
    expect(r.requests).toHaveLength(1);
    time.advance(1);
    await lookup();
    expect(r.requests).toHaveLength(2);
  });

  it("a confirmed unregistered verdict is reused for 60 s, then looked up again", async () => {
    expect(REGISTRY_VERDICT_UNREGISTERED_TTL_MS).toBe(60_000);
    const r = registry(notFound);
    const time = clock();
    const verdictCache = createRegistryVerdictCache({ now: time.now });
    const lookup = () => lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, verdictCache });
    await lookup();
    time.advance(59_999);
    await lookup();
    expect(r.requests).toHaveLength(2);
    time.advance(1);
    await lookup();
    expect(r.requests).toHaveLength(4);
  });

  it("a refresh that gets 404 drops the cached registered record", async () => {
    const body = await recordBody();
    const cacheStore = createInMemoryRegistryCacheStore();
    const sequenceStore = createInMemoryRegistrySequenceStore();
    const r = registry(() => new Response(body));
    const time = clock();
    const verdictCache = createRegistryVerdictCache({ now: time.now });
    const options = { registryUrl: REGISTRY, fetch: r.fetch, cacheStore, sequenceStore, verdictCache };
    expect((await lookupOwnerRegistryVerdict(SUBJECT, options)).status).toBe("registered");
    time.advance(REGISTRY_VERDICT_REGISTERED_TTL_MS);
    r.set(notFound);
    // A known owner whose record disappeared is never routed by the old record.
    expect((await lookupOwnerRegistryVerdict(SUBJECT, options)).status).toBe("unavailable");
    const after404 = r.requests.length;
    await lookupOwnerRegistryVerdict(SUBJECT, options);
    expect(r.requests.length).toBeGreaterThan(after404);
  });

  it("a route denial drops the entry at once", async () => {
    const body = await recordBody([]);
    const r = registry(() => new Response(body));
    const verdictCache = createRegistryVerdictCache();
    const options = { registryUrl: REGISTRY, fetch: r.fetch, verdictCache };
    await expect(resolveRegistryResource(SUBJECT, SPACE, "read", options)).rejects.toMatchObject({ code: "node_not_found" });
    await expect(resolveRegistryResource(SUBJECT, SPACE, "read", options)).rejects.toMatchObject({ code: "node_not_found" });
    expect(r.requests).toHaveLength(2);
  });

  it("invalidate() drops the owner's entry for that registry only", async () => {
    const r = registry(notFound);
    const verdictCache = createRegistryVerdictCache();
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, verdictCache });
    await lookupOwnerRegistryVerdict(OTHER_SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, verdictCache });
    verdictCache.invalidate(REGISTRY, SUBJECT);
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, verdictCache });
    await lookupOwnerRegistryVerdict(OTHER_SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, verdictCache });
    expect(r.requests.filter(v2).map((url) => decodeURIComponent(new URL(url).pathname))).toEqual([
      `/v2/locations/${owner.address}`, `/v2/locations/${other.address}`, `/v2/locations/${owner.address}`,
    ]);
  });

  it("without a verdict cache every lookup still asks the registry (default unchanged)", async () => {
    const r = registry(notFound);
    for (let i = 0; i < 3; i++) await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch });
    expect(r.requests).toHaveLength(6);
  });
});

/** One client's own fail-closed state, as each TinyCloudNode has by default. */
const clientStores = () => ({ cacheStore: createInMemoryRegistryCacheStore(), sequenceStore: createInMemoryRegistrySequenceStore() });
const unregistered = (subject: string) => ({ status: "unregistered", subject, source: "offchain", hosts: [] }) as RegistryVerdict;
const registered = (subject: string) => ({ status: "registered", subject, source: "offchain", hosts: [], sequence: 1 }) as unknown as RegistryVerdict;

describe("a shared verdict never overrides the reading client's own state (TC-2970 review F1)", () => {
  it("a client that knew the owner as registered fails closed when another client cached the owner's absence", async () => {
    const r = registry(async () => new Response(await recordBody([SPACE], 2)));
    const time = clock();
    const verdictCache = createRegistryVerdictCache({ now: time.now });
    const A = clientStores();
    const B = clientStores();
    expect((await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, ...B, verdictCache })).status).toBe("registered");
    time.advance(REGISTRY_VERDICT_REGISTERED_TTL_MS);
    r.set(notFound);
    expect((await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, ...A, verdictCache })).status).toBe("unregistered");
    await expect(resolveRegistryResource(SUBJECT, SPACE, "write", { registryUrl: REGISTRY, fetch: r.fetch, ...B, verdictCache }))
      .rejects.toMatchObject({ code: "registry_unavailable" });
  });

  it("a client that remembers a higher sequence is not served another client's rolled-back record", async () => {
    const [second, first] = [await recordBody([SPACE], 2), await recordBody([SPACE], 1)];
    const r = registry(() => new Response(second));
    const time = clock();
    const verdictCache = createRegistryVerdictCache({ now: time.now });
    const A = clientStores();
    const B = clientStores();
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, ...B, verdictCache });
    time.advance(REGISTRY_VERDICT_REGISTERED_TTL_MS);
    r.set(() => new Response(first));
    expect(await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, ...A, verdictCache })).toMatchObject({ status: "registered", sequence: 1 });
    expect(await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, ...B, verdictCache })).toMatchObject({ status: "unavailable", reason: "rollback" });
  });

  it("a client whose saved settings lack the record does its own lookup, which saves them", async () => {
    const body = await recordBody();
    const r = registry(() => new Response(body));
    const verdictCache = createRegistryVerdictCache();
    const X = clientStores();
    const Y = clientStores();
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, ...X, verdictCache });
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, ...Y, verdictCache });
    expect(r.requests).toHaveLength(2);
    expect(await Y.cacheStore.get(owner.address)).toMatchObject({ sequence: 1 });
    // Clients sharing their stores share the lookup.
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, ...Y, verdictCache });
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, ...X, verdictCache });
    expect(r.requests).toHaveLength(2);
  });
});

describe("registry verdict cache bounds and keys (TC-2970 review F2-F4)", () => {
  it("a sign-in route denial drops the owner's entry at once", async () => {
    // A record that routes nothing: sign-in finds no host for the owner.
    const empty = await signLocationRecordV2({
      version: 2, subject: SUBJECT, nodes: [], spaces: [], encryptionNode: null, updated_at: "2026-11-13T00:00:00.000Z", sequence: 1,
    }, { type: "did:pkh", signMessage: (message) => owner.signMessage({ message }) });
    const r = registry(() => new Response(JSON.stringify({ record: empty })));
    const options = { registryUrl: REGISTRY, fetch: r.fetch, verdictCache: createRegistryVerdictCache(), ...clientStores() };
    await expect(resolveFailClosedTinyCloudHosts(owner.address, options)).rejects.toMatchObject({ code: "node_not_found" });
    await expect(resolveFailClosedTinyCloudHosts(owner.address, options)).rejects.toMatchObject({ code: "node_not_found" });
    expect(r.requests).toHaveLength(2);
  });

  it("the default clock is monotonic: a wall-clock step back does not extend a verdict", async () => {
    let monotonic = 5_000;
    const performanceNow = spyOn(performance, "now").mockImplementation(() => monotonic);
    const dateNow = spyOn(Date, "now").mockImplementation(() => 0);
    try {
      const verdictCache = createRegistryVerdictCache();
      let lookups = 0;
      const get = () => verdictCache.get({ registryUrl: REGISTRY, subject: SUBJECT }, async () => { lookups++; return unregistered(SUBJECT); });
      await get();
      monotonic += REGISTRY_VERDICT_UNREGISTERED_TTL_MS;
      await get();
      expect(lookups).toBe(2);
    } finally {
      performanceNow.mockRestore();
      dateNow.mockRestore();
    }
  });

  it("holds at most 256 owners, dropping the oldest", async () => {
    expect(REGISTRY_VERDICT_CACHE_MAX_ENTRIES).toBe(256);
    const verdictCache = createRegistryVerdictCache({ now: clock().now });
    const looked: string[] = [];
    const get = (subject: string) => verdictCache.get({ registryUrl: REGISTRY, subject }, async () => { looked.push(subject); return unregistered(subject); });
    for (let i = 0; i <= 256; i++) await get(`did:key:z${i}`);
    await get("did:key:z256");
    await get("did:key:z1");
    await get("did:key:z0");
    expect(looked.slice(257)).toEqual(["did:key:z0"]);
  });

  it("drops expired entries before a live one when it is full", async () => {
    const time = clock();
    const verdictCache = createRegistryVerdictCache({ now: time.now });
    let lookups = 0;
    await verdictCache.get({ registryUrl: REGISTRY, subject: "did:key:zLive" }, async () => { lookups++; return registered("did:key:zLive"); });
    for (let i = 0; i < 255; i++) await verdictCache.get({ registryUrl: REGISTRY, subject: `did:key:z${i}` }, async () => unregistered(`did:key:z${i}`));
    time.advance(REGISTRY_VERDICT_UNREGISTERED_TTL_MS);
    await verdictCache.get({ registryUrl: REGISTRY, subject: "did:key:zNew" }, async () => unregistered("did:key:zNew"));
    await verdictCache.get({ registryUrl: REGISTRY, subject: "did:key:zLive" }, async () => { lookups++; return registered("did:key:zLive"); });
    expect(lookups).toBe(1);
  });

  it("one registry spelled differently is one entry, and invalidating any spelling drops it", async () => {
    const r = registry(notFound);
    const verdictCache = createRegistryVerdictCache();
    for (const url of ["https://registry.test", "https://registry.test/", "https://REGISTRY.test", "https://registry.test:443", "https://registry.test//"]) {
      await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: url, fetch: r.fetch, verdictCache });
    }
    expect(r.requests.filter(v2)).toHaveLength(1);
    verdictCache.invalidate("https://Registry.test:443/", SUBJECT);
    await lookupOwnerRegistryVerdict(SUBJECT, { registryUrl: REGISTRY, fetch: r.fetch, verdictCache });
    expect(r.requests.filter(v2)).toHaveLength(2);
  });

  it("keys are structured: no registry URL and subject pair stands for another", async () => {
    const verdictCache = createRegistryVerdictCache();
    let lookups = 0;
    await verdictCache.get({ registryUrl: "a\nb", subject: "c" }, async () => { lookups++; return unregistered("c"); });
    await verdictCache.get({ registryUrl: "a", subject: "b\nc" }, async () => { lookups++; return unregistered("b\nc"); });
    expect(lookups).toBe(2);
  });
});
