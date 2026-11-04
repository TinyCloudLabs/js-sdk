import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { refreshOwnerRegistry, registryOwnerSubjectV1, resolveOwnerHosts, signLocationRecordV2 } from "@tinycloud/sdk-core";
import type { RegistryCacheEntry, RegistryCacheStore } from "@tinycloud/sdk-core";
import { createProfileRegistryCacheStore, createProfileRegistrySequenceStore, profileConfigPath, profilePath, profileStorePath, withProfileLock, withTinyCloudStateRoot, writeJsonAtomic } from "./state.js";
import { waitForProfileLockProtocol } from "./test-support/profile-lock-protocol.js";

const nodeKey = ed25519.getPublicKey(new Uint8Array(32).fill(93));
const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 1, ...nodeKey]))}`;

test("profile cache atomically retains the highest signed response against a late process and separates owners", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2481-profile-cache-"));
  const first = privateKeyToAccount(generatePrivateKey()), second = privateKeyToAccount(generatePrivateKey());
  const subject = registryOwnerSubjectV1(first.address);
  const profile = "TEST-cache";
  const body = async (sequence: number, owner = first) => ` {"record":${JSON.stringify(await signLocationRecordV2({
    version: 2, subject: registryOwnerSubjectV1(owner.address), sequence, updated_at: new Date().toISOString(), nodes: [{ did: nodeDid, url: "https://test-node.invalid" }], spaces: [], encryptionNode: nodeDid,
  }, { type: "did:pkh", signMessage: (message) => owner.signMessage({ message }) }))}}\n`;
  try {
    await withTinyCloudStateRoot(home, async () => {
      await writeJsonAtomic(profileConfigPath(profile), { name: profile });
      const responsePath = join(home, "signed-TEST-response.json");
      await writeFile(responsePath, await body(20));
      const env = { ...process.env, TC_HOME: home };
      const child = Bun.spawn([process.execPath, "--no-env-file", new URL("../test-support/registry-cache-writer.ts", import.meta.url).pathname, profile, subject, responsePath], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      try {
        const reader = child.stdout.getReader();
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
        const raw = await body(21);
        const options = { cacheStore: createProfileRegistryCacheStore(profile), sequenceStore: createProfileRegistrySequenceStore(profile),
          fetch: Object.assign(async () => new Response(raw), { preconnect: fetch.preconnect }) };
        await refreshOwnerRegistry(subject, options);
        child.stdin.write("release\n"); child.stdin.end();
        expect(await child.exited).toBe(0);
        expect(await new Response(child.stderr).text()).toBe("");
        const reloaded = createProfileRegistryCacheStore(profile);
        expect((await reloaded.get(first.address))?.responseBody).toBe(raw);
        expect(await createProfileRegistrySequenceStore(profile).get(first.address)).toBe(21);
        const otherRaw = await body(4, second);
        await refreshOwnerRegistry(registryOwnerSubjectV1(second.address), { ...options, fetch: Object.assign(async () => new Response(otherRaw), { preconnect: fetch.preconnect }) });
        expect((await reloaded.get(second.address))?.responseBody).toBe(otherRaw);
        expect((await reloaded.get(first.address))?.responseBody).toBe(raw);
        const cachePath = profileStorePath(profile, "registry-cache");
        expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
        expect((await stat(profilePath(profile))).mode & 0o777).toBe(0o700);
        await rm(cachePath);
        expect(await resolveOwnerHosts(subject, { ...options, fetch: Object.assign(async () => { throw new Error("TEST client unreachable"); }, { preconnect: fetch.preconnect }) })).toMatchObject({ status: "unavailable", reason: "network-error" });
        await writeFile(cachePath, "null");
        await expect(reloaded.get(first.address)).rejects.toThrow();
        await rm(cachePath);
        const elsewhere = join(home, "unrelated-cache.json");
        await writeFile(elsewhere, "[]");
        await symlink(elsewhere, cachePath);
        await expect(reloaded.get(first.address)).rejects.toThrow();
        expect(await readFile(elsewhere, "utf8")).toBe("[]");
      } finally { child.kill(); await child.exited; }
    });
  } finally { await rm(home, { recursive: true, force: true }); }
}, 15_000);

test("profile sequence adapter retains known highwater after a failed write without masking corrupt storage", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2481-sequence-memory-"));
  const ownerKey = privateKeyToAccount(generatePrivateKey()).address;
  const profile = "TEST-sequence-memory";
  try {
    await withTinyCloudStateRoot(home, async () => {
      await writeJsonAtomic(profileConfigPath(profile), { name: profile });
      const sequencePath = profileStorePath(profile, "registry-sequences");
      const untouched = join(home, "unrelated-sequence.json");
      await writeFile(untouched, "[]");
      await symlink(untouched, sequencePath);
      const store = createProfileRegistrySequenceStore(profile);
      await expect(store.set(ownerKey, 71)).rejects.toThrow();
      await expect(store.get(ownerKey)).rejects.toThrow();
      await rm(sequencePath); // Only the owned symlink; never its target.
      expect(await store.get(ownerKey)).toBe(71);
      await store.set(ownerKey, 70);
      expect(await createProfileRegistrySequenceStore(profile).get(ownerKey)).toBe(71);
      expect(await readFile(untouched, "utf8")).toBe("[]");
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

async function signedCacheFixture(sequence: number) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const subject = registryOwnerSubjectV1(owner.address);
  const responseBody = ` {"record":${JSON.stringify(await signLocationRecordV2({
    version: 2, subject, sequence, updated_at: new Date().toISOString(),
    nodes: [{ did: nodeDid, url: "https://test-node.invalid" }], spaces: [], encryptionNode: nodeDid,
  }, { type: "did:pkh", signMessage: (message) => owner.signMessage({ message }) }))}}\n`;
  const entry: RegistryCacheEntry = { ownerKey: owner.address, responseBody, sequence, fetchedAt: Date.now() };
  return { subject, entry };
}

test("held profile registry siblings retain both real Core refreshes across adapter instances", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2481-held-registry-"));
  const fixtures = await Promise.all([signedCacheFixture(3), signedCacheFixture(4)]);
  const profile = "TEST-held-registry";
  const firstEntered = Promise.withResolvers<void>(), releaseFirst = Promise.withResolvers<void>();
  let active = 0, maximum = 0;
  const pending: Promise<unknown>[] = [];
  try {
    await withTinyCloudStateRoot(home, async () => {
      await writeJsonAtomic(profileConfigPath(profile), { name: profile });
      const options = (fixture: typeof fixtures[number], index: number) => {
        const backing = createProfileRegistryCacheStore(profile);
        const cacheStore: RegistryCacheStore = {
          get: backing.get,
          update: (key, update) => {
            const result = backing.update(key, async (current) => {
              active++; maximum = Math.max(maximum, active);
              try {
                if (index === 0) { firstEntered.resolve(); await releaseFirst.promise; }
                return await update(current);
              } finally { active--; }
            });
            if (index === 1) releaseFirst.resolve();
            return result;
          },
        };
        return { cacheStore, sequenceStore: createProfileRegistrySequenceStore(profile),
          fetch: Object.assign(async () => new Response(fixture.entry.responseBody), { preconnect: fetch.preconnect }) };
      };
      const verdicts = await withProfileLock(profile, async () => {
        const first = refreshOwnerRegistry(fixtures[0]!.subject, options(fixtures[0]!, 0));
        pending.push(first);
        await Promise.race([firstEntered.promise, first]);
        const second = refreshOwnerRegistry(fixtures[1]!.subject, options(fixtures[1]!, 1));
        pending.push(second);
        void second.catch(() => releaseFirst.resolve());
        return Promise.all([first, second]);
      });
      expect(verdicts.map((verdict) => verdict.status)).toEqual(["registered", "registered"]);
      expect(maximum).toBe(1);
      const reloaded = createProfileRegistryCacheStore(profile), sequences = createProfileRegistrySequenceStore(profile);
      for (const fixture of fixtures) {
        expect((await reloaded.get(fixture.entry.ownerKey))?.responseBody).toBe(fixture.entry.responseBody);
        expect(await sequences.get(fixture.entry.ownerKey)).toBe(fixture.entry.sequence);
      }
    });
  } finally {
    releaseFirst.resolve(); await Promise.allSettled(pending);
    await rm(home, { recursive: true, force: true });
  }
});

test("held profile registry sequence maxima and zero survive nested cross-store callbacks", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2481-held-maxima-"));
  const fixture = await signedCacheFixture(9);
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const profile = "TEST-held-maxima";
  try {
    await withTinyCloudStateRoot(home, async () => {
      await writeJsonAtomic(profileConfigPath(profile), { name: profile });
      await withProfileLock(profile, () => Promise.all([
        createProfileRegistryCacheStore(profile).update(fixture.entry.ownerKey, async () => {
          await createProfileRegistrySequenceStore(profile).set(fixture.entry.ownerKey, 9);
          return fixture.entry;
        }),
        createProfileRegistrySequenceStore(profile).set(fixture.entry.ownerKey, 4),
        createProfileRegistrySequenceStore(profile).set(other, 0),
      ]));
      const sequences = createProfileRegistrySequenceStore(profile);
      expect(await sequences.get(fixture.entry.ownerKey)).toBe(9);
      expect(await sequences.get(other)).toBe(0);
      expect(await createProfileRegistryCacheStore(profile).get(fixture.entry.ownerKey)).toEqual(fixture.entry);
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("held profile registry writer finishes before an already-contending outside writer", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2481-registry-order-"));
  const fixtures = await Promise.all([signedCacheFixture(1), signedCacheFixture(2)]);
  const profile = "TEST-registry-order";
  const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>();
  const previousSignal = process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
  const signal = join(process.env.TC_HOME!, `${basename(home)}-contended`);
  let held: Promise<void> | undefined, outside: Promise<RegistryCacheEntry> | undefined;
  try {
    await withTinyCloudStateRoot(home, async () => {
      await writeJsonAtomic(profileConfigPath(profile), { name: profile });
      held = withProfileLock(profile, async () => {
        entered.resolve(); await proceed.promise;
        await createProfileRegistryCacheStore(profile).update(fixtures[0]!.entry.ownerKey, async () => fixtures[0]!.entry);
      });
      await entered.promise;
      process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = signal;
      outside = createProfileRegistryCacheStore(profile).update(fixtures[1]!.entry.ownerKey, async () => fixtures[1]!.entry);
      await waitForProfileLockProtocol(signal, "the outside registry writer to contend", 5_000);
      proceed.resolve();
      await Promise.all([held, outside]);
      const reloaded = createProfileRegistryCacheStore(profile);
      for (const fixture of fixtures) expect(await reloaded.get(fixture.entry.ownerKey)).toEqual(fixture.entry);
    });
  } finally {
    proceed.resolve(); await Promise.allSettled([held, outside]);
    if (previousSignal === undefined) delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
    else process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = previousSignal;
    await rm(signal, { force: true });
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);

test("registry queues separate same-named profiles and recover from a rejected callback", async () => {
  const homes = await Promise.all([mkdtemp(join(tmpdir(), "tc2481-registry-root-a-")), mkdtemp(join(tmpdir(), "tc2481-registry-root-b-"))]);
  const fixture = await signedCacheFixture(2);
  const profile = "TEST-same-name";
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const failure = new Error("TEST rejected registry callback");
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
    for (const home of homes) await withTinyCloudStateRoot(home, () => writeJsonAtomic(profileConfigPath(profile), { name: profile }));
    first = withTinyCloudStateRoot(homes[0]!, () => withProfileLock(profile, async () => {
      const rejected = createProfileRegistryCacheStore(profile).update(fixture.entry.ownerKey, async () => {
        entered.resolve(); await release.promise; throw failure;
      }).catch((error: unknown) => error);
      await entered.promise;
      const follower = createProfileRegistryCacheStore(profile).update(fixture.entry.ownerKey, async () => fixture.entry);
      const result = await rejected;
      await follower;
      return result;
    }));
    await entered.promise;
    const completed = join(homes[1]!, "other-root-completed");
    second = withTinyCloudStateRoot(homes[1]!, async () => {
      await createProfileRegistryCacheStore(profile).update(fixture.entry.ownerKey, async () => fixture.entry);
      await writeFile(completed, "ready\n");
    });
    await waitForProfileLockProtocol(completed, "the independent same-named profile writer", 5_000);
    release.resolve();
    expect(await first).toBe(failure);
    await second;
    for (const home of homes) await withTinyCloudStateRoot(home, async () => {
      expect(await createProfileRegistryCacheStore(profile).get(fixture.entry.ownerKey)).toEqual(fixture.entry);
    });
  } finally {
    release.resolve(); await Promise.allSettled([first, second]);
    await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  }
}, 15_000);
