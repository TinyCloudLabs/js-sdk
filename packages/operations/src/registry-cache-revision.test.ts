import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { registryOwnerSubjectV1, resolveRegistryResource, signLocationRecordV2 } from "@tinycloud/sdk-core";
import type { RegistryCacheEntry } from "@tinycloud/sdk-core";
import { registryShowOperationDefinitions } from "./operations/registry-show.js";
import { createProfileRegistryCacheStore, createProfileRegistrySequenceStore, profileConfigPath, profileStorePath, withProfileLock, withTinyCloudStateRoot, writeJsonAtomic } from "./state.js";
import { waitForProfileLockProtocol } from "./test-support/profile-lock-protocol.js";

const publicKey = ed25519.getPublicKey(new Uint8Array(32).fill(79));
const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 1, ...publicKey]))}`;

async function signedRevisionFixture(host = "http://127.0.0.1:1", sequence = 0, owner = privateKeyToAccount(generatePrivateKey())) {
  const subject = registryOwnerSubjectV1(owner.address);
  const space = `tinycloud:pkh:eip155:1:${owner.address.toLowerCase()}:secrets`;
  const record = await signLocationRecordV2({
    version: 2, subject, sequence, updated_at: new Date().toISOString(),
    nodes: [{ did: nodeDid, url: host }],
    spaces: [{ space, nodes: [{ did: nodeDid, mode: "read-write" }] }],
    encryptionNode: nodeDid,
  }, { type: "did:pkh", signMessage: (message) => owner.signMessage({ message }) });
  const entry: RegistryCacheEntry = {
    ownerKey: owner.address, responseBody: ` {"record":${JSON.stringify(record)}}\n`,
    fetchedAt: Date.now(), sequence,
  };
  return { subject, space, entry, owner };
}

test("profile revisions survive legacy zero, empty deletion, fresh adapters and stale conditional deletes without changing signed sequence", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2481-cache-revision-"));
  const profile = "TEST-revision-durability";
  const fixture = await signedRevisionFixture();
  const key = fixture.entry.ownerKey;
  try {
    await withTinyCloudStateRoot(home, async () => {
      await writeJsonAtomic(profileConfigPath(profile), { name: profile });
      const path = profileStorePath(profile, "registry-cache");
      await writeJsonAtomic(path, [fixture.entry]);
      await createProfileRegistrySequenceStore(profile).set(key, 0);
      const legacy = createProfileRegistryCacheStore(profile);
      expect(await legacy.get(key)).toEqual(fixture.entry);
      expect(await legacy.getRevision(key)).toBe(0);

      await legacy.delete(key);
      const deleted = createProfileRegistryCacheStore(profile);
      expect(await deleted.get(key)).toBeUndefined();
      expect(await deleted.getRevision(key)).toBe(1);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual([{ ownerKey: key, revision: 1, invalidated: true }]);
      expect(await createProfileRegistrySequenceStore(profile).get(key)).toBe(0);
      const staleRevision = await deleted.getRevision(key);

      const network = spyOn(globalThis, "fetch");
      try {
        const inspection = await registryShowOperationDefinitions[0]!.execute({
          summary: { profile, host: "http://127.0.0.1:1", posture: "unauthenticated" },
        }, { did: fixture.subject });
        expect(inspection).toMatchObject({ status: "error", error: { code: "REGISTRY_UNAVAILABLE" } });
        expect(network).not.toHaveBeenCalled();
      } finally { network.mockRestore(); }

      await deleted.delete(key);
      const reloaded = createProfileRegistryCacheStore(profile);
      expect(await reloaded.get(key)).toBeUndefined();
      expect(await reloaded.getRevision(key)).toBe(2);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual([{ ownerKey: key, revision: 2, invalidated: true }]);
      await reloaded.update(key, async (current, revision) => {
        expect(current).toBeUndefined();
        expect(revision).toBe(2);
        // A caller cannot poison the store's revision or force its next delete to overflow.
        return { ...fixture.entry, revision: Number.MAX_SAFE_INTEGER };
      });
      const accepted = createProfileRegistryCacheStore(profile);
      const acceptedBytes = await readFile(path, "utf8");
      await expect(deleted.delete(key, staleRevision)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(acceptedBytes);
      expect(await accepted.get(key)).toEqual({ ...fixture.entry, revision: 2 });
      await accepted.delete(key, 2);
      expect(await createProfileRegistryCacheStore(profile).getRevision(key)).toBe(3);
      await expect(accepted.delete(key, 2)).rejects.toThrow();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual([{ ownerKey: key, revision: 3, invalidated: true }]);
      await accepted.delete(key, 3);
      expect(await createProfileRegistryCacheStore(profile).getRevision(key)).toBe(4);
      expect(await createProfileRegistrySequenceStore(profile).get(key)).toBe(0);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual([{ ownerKey: key, revision: 4, invalidated: true }]);
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("profile cache refuses corrupt revisions, duplicate owners, signed tombstones and revision overflow without rewriting evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2481-cache-revision-corrupt-"));
  const profile = "TEST-revision-corruption";
  const { entry } = await signedRevisionFixture();
  const key = entry.ownerKey;
  try {
    await withTinyCloudStateRoot(home, async () => {
      await writeJsonAtomic(profileConfigPath(profile), { name: profile });
      const path = profileStorePath(profile, "registry-cache");
      const corrupt = [
        [{ ...entry, revision: -1 }],
        [{ ...entry, revision: Number.MAX_SAFE_INTEGER + 1 }],
        [{ ...entry, revision: null }],
        [{ ownerKey: key, revision: 0, invalidated: true }],
        [{ ownerKey: key, revision: 1, invalidated: true, responseBody: entry.responseBody }],
        [entry, { ownerKey: key, revision: 1, invalidated: true }],
      ];
      for (const records of corrupt) {
        await writeJsonAtomic(path, records);
        const before = await readFile(path, "utf8");
        const store = createProfileRegistryCacheStore(profile);
        await expect(store.get(key)).rejects.toThrow();
        await expect(store.getRevision(key)).rejects.toThrow();
        await expect(store.delete(key)).rejects.toThrow();
        await expect(store.update(key, async () => entry)).rejects.toThrow();
        expect(await readFile(path, "utf8")).toBe(before);
      }
      await writeJsonAtomic(path, [{ ...entry, revision: Number.MAX_SAFE_INTEGER }]);
      const before = await readFile(path, "utf8");
      const store = createProfileRegistryCacheStore(profile);
      await expect(store.delete(key)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(before);
      expect(await createProfileRegistryCacheStore(profile).get(key)).toEqual({ ...entry, revision: Number.MAX_SAFE_INTEGER });
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("conditional profile invalidation cannot remove a newer signed sequence at the same revision", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2481-cache-sequence-guard-"));
  const profile = "TEST-conditional-sequence";
  const initial = await signedRevisionFixture();
  const newer = await signedRevisionFixture(undefined, 1, initial.owner);
  const key = initial.entry.ownerKey;
  const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const previousSignal = process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
  const signal = join(process.env.TC_HOME!, `${basename(home)}-conditional-delete`);
  let held: Promise<void> | undefined, deletion: Promise<void> | undefined;
  try {
    await withTinyCloudStateRoot(home, async () => {
      await writeJsonAtomic(profileConfigPath(profile), { name: profile });
      const path = profileStorePath(profile, "registry-cache");
      const negative = createProfileRegistryCacheStore(profile);
      await negative.update(key, async () => initial.entry);
      await createProfileRegistrySequenceStore(profile).set(key, 0);
      const capturedRevision = await negative.getRevision(key);
      held = withProfileLock(profile, async () => {
        entered.resolve(); await proceed.promise;
        await createProfileRegistryCacheStore(profile).update(key, async () => newer.entry);
        committed.resolve(); await release.promise;
      });
      await entered.promise;
      process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = signal;
      deletion = negative.delete(key, capturedRevision, initial.entry.sequence);
      const refusal = deletion.catch((error: unknown) => error);
      await waitForProfileLockProtocol(signal, "the old negative lookup to wait before the newer positive commit", 5_000);
      proceed.resolve();
      await committed.promise;
      const before = await readFile(path, "utf8");
      release.resolve(); await held;
      expect(await refusal).toBeInstanceOf(Error);
      expect(await readFile(path, "utf8")).toBe(before);
      expect(await createProfileRegistryCacheStore(profile).get(key)).toEqual({ ...newer.entry, revision: capturedRevision });
      expect(await createProfileRegistryCacheStore(profile).getRevision(key)).toBe(capturedRevision);
      expect(await createProfileRegistrySequenceStore(profile).get(key)).toBe(0);
      for (const invalidBound of [Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(negative.delete(key, capturedRevision, invalidBound)).rejects.toThrow();
        expect(await readFile(path, "utf8")).toBe(before);
      }

      await negative.delete(key, capturedRevision, newer.entry.sequence);
      const deleted = createProfileRegistryCacheStore(profile);
      expect(await deleted.get(key)).toBeUndefined();
      expect(await deleted.getRevision(key)).toBe(capturedRevision + 1);
      const tombstone = await readFile(path, "utf8");
      await expect(deleted.delete(key, capturedRevision + 1, -1)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(tombstone);
      // Empty/tombstone rows have no signed sequence to compare against the valid bound.
      await deleted.delete(key, capturedRevision + 1, 0);
      expect(await createProfileRegistryCacheStore(profile).getRevision(key)).toBe(capturedRevision + 2);
      expect(await createProfileRegistrySequenceStore(profile).get(key)).toBe(0);
    });
  } finally {
    proceed.resolve(); release.resolve();
    await Promise.allSettled([held, deletion]);
    if (previousSignal === undefined) delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
    else process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = previousSignal;
    await rm(signal, { force: true });
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);

for (const warm of [true, false]) {
  test(`profile invalidation fences an older HTTP response from ${warm ? "warm" : "known-empty"} sequence zero and refuses a later outage`, async () => {
    const home = await mkdtemp(join(tmpdir(), "tc2481-cache-revision-flight-"));
    const profile = "TEST-revision-flight";
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    let requests = 0;
    let responseBody = "";
    const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      requests++;
      if (requests === 1) { entered.resolve(); return release.promise; }
      if (requests === 2) return new Response("TEST authoritative denial", { status: 403 });
      if (requests === 3) return new Response("TEST unavailable", { status: 503 });
      return new Response(responseBody, { headers: { "content-type": "application/json" } });
    } });
    const fixture = await signedRevisionFixture(registry.url.origin);
    responseBody = fixture.entry.responseBody;
    const key = fixture.entry.ownerKey;
    let pending: Promise<unknown> | undefined;
    const warnings: string[] = [];
    try {
      await withTinyCloudStateRoot(home, async () => {
        await writeJsonAtomic(profileConfigPath(profile), { name: profile });
        const path = profileStorePath(profile, "registry-cache");
        if (warm) await writeJsonAtomic(path, [fixture.entry]);
        await createProfileRegistrySequenceStore(profile).set(key, 0);
        // Distinct factory instances model independently restored consumers of one profile.
        const options = () => ({
          registryUrl: registry.url.origin,
          cacheStore: createProfileRegistryCacheStore(profile),
          sequenceStore: createProfileRegistrySequenceStore(profile),
          onRegistryFallback: (_reason: string, code?: string) => { warnings.push(code ?? "legacy"); },
        });
        pending = resolveRegistryResource(fixture.subject, fixture.space, "read", options())
          .then((value) => ({ status: "ok", value }), (error: unknown) => ({ status: "error", error }));
        await Promise.race([entered.promise, pending.then((value) => {
          throw new Error(`Deferred registry request was not reached: ${JSON.stringify(value)}`);
        })]);
        await expect(resolveRegistryResource(fixture.subject, fixture.space, "read", options()))
          .rejects.toMatchObject({ code: "registry_unavailable" });
        const denied = createProfileRegistryCacheStore(profile);
        expect(await denied.get(key)).toBeUndefined();
        expect(await denied.getRevision(key)).toBe(1);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual([{ ownerKey: key, revision: 1, invalidated: true }]);
        expect(await createProfileRegistrySequenceStore(profile).get(key)).toBe(0);

        release.resolve(new Response(responseBody, { headers: { "content-type": "application/json" } }));
        expect(await pending).toMatchObject({ status: "error", error: { code: "registry_unavailable" } });
        expect(await createProfileRegistryCacheStore(profile).get(key)).toBeUndefined();
        expect(await createProfileRegistryCacheStore(profile).getRevision(key)).toBe(1);
        await expect(resolveRegistryResource(fixture.subject, fixture.space, "read", options()))
          .rejects.toMatchObject({ code: "registry_unavailable" });
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual([{ ownerKey: key, revision: 1, invalidated: true }]);
        expect(await createProfileRegistrySequenceStore(profile).get(key)).toBe(0);
        expect(warnings).toEqual([]);
        expect(requests).toBe(3);

        // A genuinely new lookup can accept a live seq0 response without resetting the invalidation fence.
        const recovered = await resolveRegistryResource(fixture.subject, fixture.space, "read", options());
        expect(recovered.hosts).toMatchObject([{ nodeDid, urls: [registry.url.origin] }]);
        expect(await createProfileRegistryCacheStore(profile).get(key)).toMatchObject({
          ownerKey: key, responseBody, sequence: 0, revision: 1,
        });
        expect(await createProfileRegistrySequenceStore(profile).get(key)).toBe(0);
        expect(warnings).toEqual([]);
        expect(requests).toBe(4);
      });
    } finally {
      release.resolve(new Response("TEST fixture closed", { status: 503 }));
      await pending;
      registry.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  });
}
