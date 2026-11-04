import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { refreshOwnerRegistry, registryOwnerSubjectV1, resolveOwnerHosts, signLocationRecordV2 } from "@tinycloud/sdk-core";
import { createProfileRegistryCacheStore, createProfileRegistrySequenceStore, profileConfigPath, profilePath, profileStorePath, withTinyCloudStateRoot, writeJsonAtomic } from "./state.js";

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
