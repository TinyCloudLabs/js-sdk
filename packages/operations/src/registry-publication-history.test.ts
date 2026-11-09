import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { registryOwnerSubjectV1, resolveOwnerHosts, signLocationRecord, signLocationRecordV2, validateLocationRecordV2, verifyLocationRecordV2, type LocationRecordV2 } from "@tinycloud/sdk-core";
import { publishLocationRecordV2 } from "@tinycloud/sdk-core/registry-publication";
import { createProfileRegistryCacheStore, createProfileRegistrySequenceStore, profileConfigPath, profileStorePath, withTinyCloudStateRoot, writeJsonAtomic } from "./state.js";

const nodeDid = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32).fill(43))))}`;

async function nativeFixture() {
  const owner = privateKeyToAccount(generatePrivateKey());
  const subject = registryOwnerSubjectV1(owner.address);
  const space = `tinycloud:pkh:eip155:1:${owner.address.toLowerCase()}:history`;
  const signer = { type: "did:pkh" as const, signMessage: (message: string) => owner.signMessage({ message }) };
  const storage = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return new URL(request.url).pathname === "/info"
      ? Response.json({ nodeId: nodeDid }) : Response.json({ nodeDid });
  } });
  const legacy = await signLocationRecord({
    version: 1, subject, multiaddrs: [`/ip4/127.0.0.1/tcp/${storage.url.port}/http`],
    updated_at: new Date().toISOString(), sequence: 12,
  }, signer);
  let current: LocationRecordV2 | null = null;
  let writes = 0;
  let signatures = 0;
  const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === `/v1/locations/${encodeURIComponent(subject)}`) return Response.json({ record: legacy });
    if (path !== `/v2/locations/${owner.address}`) return Response.json({ error: "location record not found" }, { status: 404 });
    if (request.method === "GET") return current
      ? Response.json({ record: current }) : Response.json({ error: "location record not found" }, { status: 404 });
    if (request.method !== "PUT") return new Response(null, { status: 405 });
    const record = validateLocationRecordV2(await request.json());
    if (!(await verifyLocationRecordV2(record))) return new Response(null, { status: 401 });
    writes++;
    current = record;
    return Response.json({ record, status: "created" }, { status: 201 });
  } });
  return {
    ownerKey: owner.address, subject, space,
    registryUrl: registry.url.origin,
    publication: {
      registryUrl: registry.url.origin, subject,
      signer: { type: "did:pkh" as const, signMessage: (message: string) => { signatures++; return signer.signMessage(message); } },
      memberships: [{ space, node: { did: nodeDid, url: storage.url.origin }, mode: "read-write" as const }],
    },
    signedZero: () => signLocationRecordV2({
      version: 2, subject, sequence: 0, updated_at: new Date().toISOString(),
      nodes: [{ did: nodeDid, url: storage.url.origin }],
      spaces: [{ space, nodes: [{ did: nodeDid, mode: "read-write" }] }], encryptionNode: null,
    }, signer),
    replace: (record: LocationRecordV2 | null) => { current = record; },
    writes: () => writes,
    signatures: () => signatures,
    close: async () => { await registry.stop(true); await storage.stop(true); },
  };
}

async function isolatedProfile(run: (profile: string, fixture: Awaited<ReturnType<typeof nativeFixture>>) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "tc2657-history-"));
  const fixture = await nativeFixture();
  try {
    await withTinyCloudStateRoot(home, async () => {
      const profile = "TEST-publication-history";
      await writeJsonAtomic(profileConfigPath(profile), { name: profile });
      await run(profile, fixture);
    });
  } finally {
    await fixture.close();
    await rm(home, { recursive: true, force: true });
  }
}

const stores = (profile: string) => ({
  cacheStore: createProfileRegistryCacheStore(profile),
  sequenceStore: createProfileRegistrySequenceStore(profile),
});

test("a reloaded profile with verified v1-only history can explicitly publish its first v2 record", async () => {
  await isolatedProfile(async (profile, fixture) => {
    expect(await resolveOwnerHosts(fixture.subject, { registryUrl: fixture.registryUrl, ...stores(profile) }))
      .toMatchObject({ status: "unavailable", reason: "unsupported-format", hosts: [] });
    expect(fixture.writes()).toBe(0);
    const record = await publishLocationRecordV2({ ...fixture.publication, ...stores(profile) });
    expect(record.sequence).toBe(0);
    expect(await verifyLocationRecordV2(record)).toBe(true);
    expect(record.spaces.map(({ space }) => space)).toEqual([fixture.space]);
    expect(fixture.writes()).toBe(1);
  });
});

test("signed v2 zero permanently promotes a legacy profile before its cache can be lost", async () => {
  await isolatedProfile(async (profile, fixture) => {
    await resolveOwnerHosts(fixture.subject, { registryUrl: fixture.registryUrl, ...stores(profile) });
    fixture.replace(await fixture.signedZero());
    expect(await resolveOwnerHosts(fixture.subject, { registryUrl: fixture.registryUrl, ...stores(profile) }))
      .toMatchObject({ status: "registered", sequence: 0 });
    await rm(profileStorePath(profile, "registry-cache"));
    fixture.replace(null);
    await expect(publishLocationRecordV2({ ...fixture.publication, ...stores(profile) })).rejects.toBeInstanceOf(Error);
    expect(fixture.signatures()).toBe(0);
    expect(fixture.writes()).toBe(0);
    expect(await createProfileRegistrySequenceStore(profile).get(fixture.ownerKey)).toBe(0);
  });
});

test("a failed legacy-to-v2 history promotion refuses the verified v2 result", async () => {
  await isolatedProfile(async (profile, fixture) => {
    await resolveOwnerHosts(fixture.subject, { registryUrl: fixture.registryUrl, ...stores(profile) });
    fixture.replace(await fixture.signedZero());
    const history = createProfileRegistrySequenceStore(profile);
    await expect(resolveOwnerHosts(fixture.subject, {
      registryUrl: fixture.registryUrl,
      cacheStore: createProfileRegistryCacheStore(profile),
      sequenceStore: { ...history, set: async () => { throw new Error("TEST history persistence failure"); } },
    })).rejects.toBeInstanceOf(Error);
    expect(fixture.signatures()).toBe(0);
    expect(fixture.writes()).toBe(0);
  });
});

test("an old untyped profile zero is preserved and cannot be recreated as v1-only history", async () => {
  await isolatedProfile(async (profile, fixture) => {
    const path = profileStorePath(profile, "registry-sequences");
    await writeJsonAtomic(path, [{ ownerKey: fixture.ownerKey, sequence: 0 }]);
    const before = await readFile(path, "utf8");
    await expect(publishLocationRecordV2({ ...fixture.publication, ...stores(profile) })).rejects.toBeInstanceOf(Error);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await createProfileRegistrySequenceStore(profile).get(fixture.ownerKey)).toBe(0);
    expect(fixture.signatures()).toBe(0);
    expect(fixture.writes()).toBe(0);
  });
});
