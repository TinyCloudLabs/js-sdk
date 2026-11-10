import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { privateKeyToAccount } from "viem/accounts";
import {
  LocationRecordValidationError,
  signLocationRecord,
  signLocationRecordV2,
  validateLocationRecordV2,
  verifyLocationRecordV2,
  type LocationRecordV2,
} from "./location";
import { publishLocationRecordV2, type PublishLocationRecordV2Options } from "./registry-publication";
import { createInMemoryRegistryCacheStore } from "./registry-cache";
import { createInMemoryRegistrySequenceStore, createLocalStorageRegistrySequenceStore, registryOwnerSubjectV1, resolveOwnerHosts } from "./registry-policy";
import { installTestWebLocks } from "./test-support/web-locks";

const REGISTRY = "https://registry.example";
const SERVER = "https://storage.example";
const OTHER_SERVER = "https://other-storage.example";
const owner = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const otherOwner = privateKeyToAccount("0x1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const SUBJECT = `did:pkh:eip155:1:${owner.address}`;
const space = (name: string) => `tinycloud:pkh:eip155:1:${owner.address.toLowerCase()}:${name}`;
const nodeDid = (seed: number) => `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32).fill(seed))))}`;
const NODE = nodeDid(7);
const OTHER_NODE = nodeDid(9);
const NOW = new Date("2026-11-09T10:00:00.000Z");
const signer = { type: "did:pkh" as const, signMessage: (message: string) => owner.signMessage({ message }) };

type Seen = { method: string; url: string; authorization: boolean; redirect?: RequestRedirect; body?: string };

async function existing(sequence = 4) {
  return signLocationRecordV2({
    version: 2, subject: SUBJECT,
    nodes: [{ did: OTHER_NODE, url: OTHER_SERVER }],
    spaces: [{ space: space("preserved"), nodes: [{ did: OTHER_NODE, mode: "read-only" }] }],
    encryptionNode: OTHER_NODE, sequence, updated_at: "2026-11-08T10:00:00.000Z",
  }, signer);
}

function fixture(initial: LocationRecordV2 | null = null) {
  let current = initial;
  let lookupStatus: number | undefined;
  let lookupBody: unknown;
  let liveNodeDid = NODE;
  let putStatus = 201;
  let echo: ((record: LocationRecordV2) => unknown) | undefined;
  const seen: Seen[] = [];
  const fetchFn: NonNullable<PublishLocationRecordV2Options["fetch"]> = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    seen.push({ method, url, authorization: headers.has("authorization"), redirect: init?.redirect,
      ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url === `${SERVER}/info`) return Response.json({ nodeId: liveNodeDid });
    if (url === `${SERVER}/.well-known/tinycloud/node-keys`) return Response.json({ nodeDid: liveNodeDid });
    if (url !== `${REGISTRY}/v2/locations/${owner.address}`) throw new Error("Unexpected synthetic publication endpoint");
    if (method === "GET") {
      if (lookupStatus !== undefined) return typeof lookupBody === "string"
        ? new Response(lookupBody, { status: lookupStatus }) : Response.json(lookupBody, { status: lookupStatus });
      return current ? Response.json({ record: current }) : Response.json({ error: "location record not found" }, { status: 404 });
    }
    if (method !== "PUT") throw new Error("Unexpected publication method");
    if (putStatus !== 200 && putStatus !== 201) return Response.json({ error: "stale record sequence" }, { status: putStatus });
    const record = validateLocationRecordV2(JSON.parse(String(init?.body)));
    current = record;
    return Response.json(echo ? echo(record) : { record, status: initial ? "updated" : "created" }, { status: putStatus });
  };
  const options: PublishLocationRecordV2Options = {
    registryUrl: REGISTRY, subject: SUBJECT, signer, fetch: fetchFn, now: () => NOW,
    memberships: [{ space: space("secrets"), node: { did: NODE, url: SERVER }, mode: "read-write" }],
  };
  return { options, seen, current: () => current,
    replace: (record: LocationRecordV2) => { current = record; },
    lookup: (status: number, body: unknown) => { lookupStatus = status; lookupBody = body; },
    identity: (did: string) => { liveNodeDid = did; },
    rejectPut: (status: number) => { putStatus = status; },
    echo: (transform: (record: LocationRecordV2) => unknown) => { echo = transform; },
  };
}

const writes = (f: ReturnType<typeof fixture>) => f.seen.filter(({ method }) => method === "PUT");

describe("explicit signed-v2 publication", () => {
  test("publishes only the explicitly selected membership with a real owner signature", async () => {
    const f = fixture();
    const record = await publishLocationRecordV2(f.options);
    expect(await verifyLocationRecordV2(record)).toBe(true);
    expect(record).toMatchObject({ subject: SUBJECT, sequence: 0, updated_at: NOW.toISOString(), encryptionNode: null,
      nodes: [{ did: NODE, url: SERVER }],
      spaces: [{ space: space("secrets"), nodes: [{ did: NODE, mode: "read-write" }] }],
    });
    expect(writes(f)).toHaveLength(1);
    expect(f.seen.every(({ redirect, authorization }) => redirect === "error" && !authorization)).toBe(true);
  });

  test("v1 recognition still permits explicit first-v2 publication without granting a legacy route", async () => {
    const f = fixture();
    const sequenceStore = createInMemoryRegistrySequenceStore();
    const cacheStore = createInMemoryRegistryCacheStore();
    const legacy = await signLocationRecord({
      version: 1, subject: registryOwnerSubjectV1(owner.address),
      multiaddrs: ["/dns4/storage.example/tcp/443/https"],
      updated_at: NOW.toISOString(), sequence: 17,
    }, signer);
    const fetchFn: NonNullable<PublishLocationRecordV2Options["fetch"]> = (input, init) =>
      String(input) === `${REGISTRY}/v1/locations/${encodeURIComponent(legacy.subject)}`
        ? Promise.resolve(Response.json({ record: legacy })) : f.options.fetch!(input, init);

    const verdict = await resolveOwnerHosts(SUBJECT, {
      registryUrl: REGISTRY, fetch: fetchFn, sequenceStore, cacheStore,
    });
    expect(verdict).toMatchObject({ status: "unavailable", reason: "unsupported-format", hosts: [] });
    expect(writes(f)).toEqual([]);

    const record = await publishLocationRecordV2({ ...f.options, fetch: fetchFn, sequenceStore, cacheStore });
    expect(record.sequence).toBe(0);
    expect(await verifyLocationRecordV2(record)).toBe(true);
    expect(record.spaces).toEqual([{ space: space("secrets"), nodes: [{ did: NODE, mode: "read-write" }] }]);
    expect(writes(f)).toHaveLength(1);
  });

  test("accepted signed-v2 sequence zero survives cache loss and forbids recreation", async () => {
    const before = await existing(0);
    const f = fixture(before);
    const sequenceStore = createInMemoryRegistrySequenceStore();
    const cacheStore = createInMemoryRegistryCacheStore();
    const verdict = await resolveOwnerHosts(SUBJECT, {
      registryUrl: REGISTRY, fetch: f.options.fetch, sequenceStore, cacheStore,
    });
    expect(verdict).toMatchObject({ status: "registered", sequence: 0 });
    f.lookup(404, { error: "location record not found" });
    let signed = false;
    await expect(publishLocationRecordV2({
      ...f.options, sequenceStore, cacheStore: createInMemoryRegistryCacheStore(),
      signer: { type: "did:pkh", signMessage: async (message) => {
        signed = true;
        return signer.signMessage(message);
      } },
    })).rejects.toBeInstanceOf(LocationRecordValidationError);
    expect(signed).toBe(false);
    expect(writes(f)).toEqual([]);
  });

  test("an untyped zero history is not guessed to be legacy-only", async () => {
    const f = fixture();
    let signed = false;
    await expect(publishLocationRecordV2({
      ...f.options, sequenceStore: { get: () => 0 },
      signer: { type: "did:pkh", signMessage: async (message) => {
        signed = true;
        return signer.signMessage(message);
      } },
    })).rejects.toBeInstanceOf(LocationRecordValidationError);
    expect(signed).toBe(false);
    expect(writes(f)).toEqual([]);
  });

  test("a signed-v2 zero observed while the owner signs retires first-publication authority", async () => {
    const f = fixture();
    const sequenceStore = createInMemoryRegistrySequenceStore();
    sequenceStore.set(owner.address, 0, "legacy-v1");
    let signed = false;
    await expect(publishLocationRecordV2({
      ...f.options, sequenceStore,
      signer: { type: "did:pkh", signMessage: async (message) => {
        const observed = fixture(await existing(0));
        await resolveOwnerHosts(SUBJECT, { registryUrl: REGISTRY, fetch: observed.options.fetch, sequenceStore });
        signed = true;
        return signer.signMessage(message);
      } },
    })).rejects.toMatchObject({ status: 409 });
    expect(signed).toBe(true);
    expect(writes(f)).toEqual([]);
  });

  test("browser history preserves legacy-only evidence and permanently promotes signed-v2 zero", async () => {
    const platform = installTestWebLocks();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    try {
      const f = fixture();
      const legacy = await signLocationRecord({
        version: 1, subject: registryOwnerSubjectV1(owner.address),
        multiaddrs: ["/dns4/storage.example/tcp/443/https"],
        updated_at: NOW.toISOString(), sequence: 9,
      }, signer);
      const fetchFn: NonNullable<PublishLocationRecordV2Options["fetch"]> = (input, init) =>
        String(input) === `${REGISTRY}/v1/locations/${encodeURIComponent(legacy.subject)}`
          ? Promise.resolve(Response.json({ record: legacy })) : f.options.fetch!(input, init);
      await resolveOwnerHosts(SUBJECT, {
        registryUrl: REGISTRY, fetch: fetchFn, sequenceStore: createLocalStorageRegistrySequenceStore(storage),
      });
      const record = await publishLocationRecordV2({
        ...f.options, sequenceStore: createLocalStorageRegistrySequenceStore(storage),
      });
      expect(record.sequence).toBe(0);
      expect(await verifyLocationRecordV2(record)).toBe(true);
      await resolveOwnerHosts(SUBJECT, {
        registryUrl: REGISTRY, fetch: f.options.fetch, sequenceStore: createLocalStorageRegistrySequenceStore(storage),
      });
      f.lookup(404, { error: "location record not found" });
      await expect(publishLocationRecordV2({
        ...f.options, sequenceStore: createLocalStorageRegistrySequenceStore(storage),
      })).rejects.toBeInstanceOf(LocationRecordValidationError);
      expect(writes(f)).toHaveLength(1);
    } finally { platform.restore(); }
  });

  test("preserves unrelated spaces, nodes and the decryption service while advancing sequence", async () => {
    const before = await existing();
    const f = fixture(before);
    const record = await publishLocationRecordV2(f.options);
    expect(record.sequence).toBe(before.sequence + 1);
    expect(record.spaces.find(({ space: id }) => id === space("preserved"))).toEqual(before.spaces[0]);
    expect(record.nodes).toContainEqual(before.nodes[0]);
    expect(record.spaces.find(({ space: id }) => id === space("secrets"))?.nodes).toEqual([{ did: NODE, mode: "read-write" }]);
    expect(record.encryptionNode).toBe(OTHER_NODE);
    expect(await verifyLocationRecordV2(record)).toBe(true);
  });

  test("keeps a semantic no-op idempotent without signing or writing again", async () => {
    const first = fixture();
    const before = await publishLocationRecordV2(first.options);
    const f = fixture(before);
    let signed = false;
    const record = await publishLocationRecordV2({ ...f.options, signer: { type: "did:pkh", signMessage: async (message) => {
      signed = true;
      return signer.signMessage(message);
    } } });
    expect(record).toEqual(before);
    expect(signed).toBe(false);
    expect(writes(f)).toEqual([]);
  });

  test("a declined complete preview performs no signature or write", async () => {
    const before = await existing();
    const f = fixture(before);
    let preview: unknown;
    let signed = false;
    await expect(publishLocationRecordV2({ ...f.options,
      signer: { type: "did:pkh", signMessage: async (message) => { signed = true; return signer.signMessage(message); } },
      onPrepared: (payload) => { preview = payload; return false; },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(preview).toMatchObject({ subject: SUBJECT, sequence: before.sequence + 1,
      encryptionNode: OTHER_NODE,
      spaces: expect.arrayContaining([before.spaces[0], { space: space("secrets"), nodes: [{ did: NODE, mode: "read-write" }] }]),
    });
    expect(signed).toBe(false);
    expect(writes(f)).toEqual([]);
  });

  test("refuses a changed remote record after preview rather than overwriting or retrying", async () => {
    const f = fixture(await existing());
    const concurrent = await existing(5);
    await expect(publishLocationRecordV2({ ...f.options, onPrepared: () => { f.replace(concurrent); return true; } }))
      .rejects.toMatchObject({ status: 409 });
    expect(f.current()).toEqual(concurrent);
    expect(writes(f)).toEqual([]);
  });

  test("a server conflict is returned after exactly one publication attempt", async () => {
    const f = fixture();
    f.rejectPut(409);
    await expect(publishLocationRecordV2(f.options)).rejects.toMatchObject({ status: 409 });
    expect(writes(f)).toHaveLength(1);
    expect(f.current()).toBeNull();
  });

  for (const [status, body] of [[404, "404 Not Found"], [404, { error: "unrelated not found" }], [503, { error: "unavailable" }]] as const) {
    test(`noncanonical absence or HTTP${status} cannot authorize an initial write: ${typeof body === "string" ? "text" : body.error}`, async () => {
      const f = fixture();
      f.lookup(status, body);
      await expect(publishLocationRecordV2(f.options)).rejects.toBeInstanceOf(Error);
      expect(writes(f)).toEqual([]);
    });
  }

  test("refuses a record below remembered sequence without dropping its memberships", async () => {
    const before = await existing(4);
    const f = fixture(before);
    await expect(publishLocationRecordV2({ ...f.options, sequenceStore: { get: async () => 5 } }))
      .rejects.toBeInstanceOf(LocationRecordValidationError);
    expect(writes(f)).toEqual([]);
    expect(f.current()).toEqual(before);
  });

  test("remembered registration cannot be recreated from a later not-found", async () => {
    const f = fixture();
    await expect(publishLocationRecordV2({ ...f.options, sequenceStore: { get: async () => 4 } }))
      .rejects.toBeInstanceOf(LocationRecordValidationError);
    expect(writes(f)).toEqual([]);
  });

  test("checks the selected destination identity before owner signing", async () => {
    const f = fixture();
    f.identity(OTHER_NODE);
    let signed = false;
    await expect(publishLocationRecordV2({ ...f.options, signer: { type: "did:pkh", signMessage: async (message) => {
      signed = true; return signer.signMessage(message);
    } } })).rejects.toBeInstanceOf(Error);
    expect(signed).toBe(false);
    expect(writes(f)).toEqual([]);
  });

  test("an agent or other owner's signature cannot publish the selected owner's record", async () => {
    const f = fixture();
    await expect(publishLocationRecordV2({ ...f.options, signer: { type: "did:pkh", signMessage: (message) => otherOwner.signMessage({ message }) } }))
      .rejects.toBeInstanceOf(LocationRecordValidationError);
    expect(writes(f)).toEqual([]);
  });

  test("refuses to move an existing shared node mapping while adding a selected space", async () => {
    const before = await existing();
    const f = fixture(before);
    await expect(publishLocationRecordV2({ ...f.options,
      memberships: [{ space: space("secrets"), node: { did: OTHER_NODE, url: SERVER }, mode: "read-write" }],
    })).rejects.toBeInstanceOf(LocationRecordValidationError);
    expect(f.current()).toEqual(before);
    expect(writes(f)).toEqual([]);
  });

  test("refuses sequence overflow without publishing a different or wrapped sequence", async () => {
    const before = await existing(Number.MAX_SAFE_INTEGER);
    const f = fixture(before);
    await expect(publishLocationRecordV2(f.options)).rejects.toBeInstanceOf(LocationRecordValidationError);
    expect(writes(f)).toEqual([]);
  });

  test("does not accept a mismatched registry success echo as a successful publication", async () => {
    const f = fixture();
    f.echo((record) => ({ record: { ...record, sequence: record.sequence + 1 }, status: "created" }));
    await expect(publishLocationRecordV2(f.options)).rejects.toBeInstanceOf(LocationRecordValidationError);
    expect(writes(f)).toHaveLength(1);
    expect(await verifyLocationRecordV2(f.current()!)).toBe(true);
  });
});

test("a durable known-owner tombstone cannot be treated as initial absence", async () => {
  const cache = createInMemoryRegistryCacheStore();
  await cache.delete(owner.address);
  const f = fixture();
  await expect(publishLocationRecordV2({ ...f.options, cacheStore: cache })).rejects.toBeInstanceOf(LocationRecordValidationError);
  expect(writes(f)).toEqual([]);
});

test("a verified cached equal-sequence payload cannot be replaced by a different signed payload", async () => {
  const before = await existing();
  const cache = createInMemoryRegistryCacheStore();
  await cache.update(owner.address, async () => ({
    ownerKey: owner.address, responseBody: JSON.stringify({ record: before }), fetchedAt: NOW.getTime(), sequence: before.sequence,
  }));
  const { signature: _signature, ...payload } = before;
  const fork = await signLocationRecordV2({ ...payload, encryptionNode: null }, signer);
  const f = fixture(fork);
  await expect(publishLocationRecordV2({ ...f.options, cacheStore: cache })).rejects.toBeInstanceOf(LocationRecordValidationError);
  expect(writes(f)).toEqual([]);
});

test("cancellation while the owner signs cannot send the signed record", async () => {
  const f = fixture();
  const controller = new AbortController();
  let signed = false;
  await expect(publishLocationRecordV2({ ...f.options, signal: controller.signal,
    signer: { type: "did:pkh", signMessage: async (message) => {
      const signature = await signer.signMessage(message);
      signed = true;
      controller.abort();
      return signature;
    } },
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(signed).toBe(true);
  expect(writes(f)).toEqual([]);
});

test("an invalid existing signature cannot authorize a merged publication", async () => {
  const before = await existing();
  const f = fixture({ ...before, sequence: before.sequence + 1 });
  let signed = false;
  await expect(publishLocationRecordV2({ ...f.options, signer: { type: "did:pkh", signMessage: async (message) => {
    signed = true;
    return signer.signMessage(message);
  } } })).rejects.toBeInstanceOf(LocationRecordValidationError);
  expect(signed).toBe(false);
  expect(writes(f)).toEqual([]);
});

test("preserves the existing record subject and memberships for the same owner on another chain", async () => {
  const { signature: _signature, ...initial } = await existing();
  const before = await signLocationRecordV2({ ...initial, subject: `did:pkh:eip155:10:${owner.address}` }, signer);
  const f = fixture(before);
  const result = await publishLocationRecordV2(f.options);
  expect(result.subject).toBe(before.subject);
  expect(result.sequence).toBe(before.sequence + 1);
  expect(result.spaces).toContainEqual(before.spaces[0]);
  expect(await verifyLocationRecordV2(result)).toBe(true);
});

describe("native publication redirect boundaries", () => {
  for (const redirectStage of ["lookup", "identity", "publish"] as const) {
    test(`${redirectStage} refuses a native 307 instead of forwarding to another origin`, async () => {
      let forwarded = 0;
      let signatures = 0;
      let publications = 0;
      const observer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        forwarded++;
        return Response.json({});
      } });
      const redirect = () => new Response(null, { status: 307, headers: { location: `${observer.url.origin}/capture` } });
      const storage = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (redirectStage === "identity") return redirect();
        return new URL(request.url).pathname === "/info"
          ? Response.json({ nodeId: NODE }) : Response.json({ nodeDid: NODE });
      } });
      const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (request.method === "PUT") { publications++; return redirect(); }
        return redirectStage === "lookup" ? redirect()
          : Response.json({ error: "location record not found" }, { status: 404 });
      } });
      try {
        await expect(publishLocationRecordV2({
          registryUrl: registry.url.origin, subject: SUBJECT,
          signer: { type: "did:pkh", signMessage: (message) => { signatures++; return signer.signMessage(message); } },
          memberships: [{ space: space("native"), node: { did: NODE, url: storage.url.origin }, mode: "read-write" }],
          fetch: globalThis.fetch.bind(globalThis), now: () => NOW,
        })).rejects.toBeInstanceOf(Error);
        expect(forwarded).toBe(0);
        expect(signatures).toBe(redirectStage === "publish" ? 1 : 0);
        expect(publications).toBe(redirectStage === "publish" ? 1 : 0);
      } finally {
        await registry.stop(true);
        await storage.stop(true);
        await observer.stop(true);
      }
    });
  }
});
