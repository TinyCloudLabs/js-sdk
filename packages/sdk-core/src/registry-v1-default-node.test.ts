import { expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { signLocationRecord, signLocationRecordV2 } from "./location";
import { createInMemoryRegistryCacheStore } from "./registry-cache";
import {
  createInMemoryRegistrySequenceStore,
  registryOwnerSubjectV1,
  resolveFailClosedTinyCloudHosts,
  resolveOwnerHosts,
  resolveRegistryResource,
} from "./registry-policy";
import { REGISTRY_NOT_FOUND_BODY } from "./registry-verdict";

// TC-3168: a verified v1-only record that names only the default node keeps its 3.11 route.
const owner = privateKeyToAccount(generatePrivateKey()); // Ephemeral TEST owner only.
const subject = registryOwnerSubjectV1(owner.address);
const space = `tinycloud:pkh:eip155:1:${owner.address}:default`;
const DEFAULT_NODE = "https://node.tinycloud.xyz";
const signer = { type: "did:pkh" as const, signMessage: (message: string) => owner.signMessage({ message }) };

async function v1Record(multiaddrs: string[]) {
  return signLocationRecord({ version: 1, subject, sequence: 4, multiaddrs, updated_at: "2026-11-04T00:00:00.000Z" }, signer);
}

async function v2Body(sequence: number) {
  const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 1, ...ed25519.getPublicKey(new Uint8Array(32).fill(7))]))}`;
  const record = await signLocationRecordV2({ version: 2, subject, sequence, updated_at: "2026-11-05T00:00:00.000Z",
    nodes: [{ did: nodeDid, url: "https://test-moved.invalid" }], spaces: [{ space, nodes: [{ did: nodeDid, mode: "read-write" }] }],
    encryptionNode: nodeDid }, signer);
  return JSON.stringify({ record });
}

function registry(v1: unknown, v2: Response | (() => Response) = () => new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 })): typeof fetch {
  return Object.assign(async (url: string | URL | Request) => String(url).includes("/v2/")
    ? (typeof v2 === "function" ? v2() : v2.clone())
    : Response.json({ record: v1 }), { preconnect: fetch.preconnect }) as typeof fetch;
}

const down = Object.assign(async () => { throw new Error("TEST registry down"); }, { preconnect: fetch.preconnect }) as typeof fetch;

test("a v1-only owner on the default node routes there for every access, with or without saved-settings stores", async () => {
  const fetchFn = registry(await v1Record(["/dns4/node.tinycloud.xyz/tcp/443/https"]));
  for (const stores of [{}, { cacheStore: createInMemoryRegistryCacheStore(), sequenceStore: createInMemoryRegistrySequenceStore() }]) {
    const verdict = await resolveOwnerHosts(subject, { ...stores, fetch: fetchFn });
    expect(verdict).toMatchObject({ status: "registered", subject, legacy: "v1-default-node", hosts: [{ urls: [DEFAULT_NODE] }] });
    expect(verdict.status === "registered" && verdict.record).toBeUndefined();
    for (const access of ["read", "write", "host", "encryption"] as const) {
      const { hosts } = await resolveRegistryResource(subject, space, access, { ...stores, fetch: fetchFn });
      expect(hosts.flatMap(({ urls }) => urls)).toEqual([DEFAULT_NODE]);
    }
    const resolved = await resolveFailClosedTinyCloudHosts(owner.address, { ...stores, fetch: fetchFn, newUserHost: "https://test-elsewhere.invalid", autoDiscoverLocalNode: false });
    expect(resolved.hosts).toEqual([DEFAULT_NODE]);
  }
});

test("the legacy route never becomes v2 sequence evidence, and a later v2 record of any sequence takes over", async () => {
  const cacheStore = createInMemoryRegistryCacheStore();
  const sequenceStore = createInMemoryRegistrySequenceStore();
  await resolveOwnerHosts(subject, { cacheStore, sequenceStore, fetch: registry(await v1Record(["/dns4/node.tinycloud.xyz/tcp/443/https"])) });
  expect(sequenceStore.getRegistration(owner.address)).toEqual({ kind: "legacy-v1", sequence: 0 });
  expect(await cacheStore.get(owner.address)).toBeUndefined();
  const moved = registry(await v1Record(["/dns4/node.tinycloud.xyz/tcp/443/https"]), new Response(await v2Body(0)));
  const { hosts } = await resolveRegistryResource(subject, space, "write", { cacheStore, sequenceStore, fetch: moved });
  expect(hosts.flatMap(({ urls }) => urls)).toEqual(["https://test-moved.invalid"]);
  expect(sequenceStore.getRegistration(owner.address)).toEqual({ kind: "signed-v2", sequence: 0 });
});

test("any other v1-only record is still refused", async () => {
  for (const multiaddrs of [
    ["/dns4/test-node.invalid/tcp/443/https"],
    ["/dns4/node.tinycloud.xyz/tcp/443/https", "/dns4/test-node.invalid/tcp/443/https"],
    ["/dns4/node.tinycloud.xyz/tcp/80/http"],
    [],
  ]) {
    const fetchFn = registry(await v1Record(multiaddrs));
    expect(await resolveOwnerHosts(subject, { fetch: fetchFn })).toMatchObject({ status: "unavailable", reason: "unsupported-format" });
    await expect(resolveRegistryResource(subject, space, "read", { fetch: fetchFn })).rejects.toMatchObject({ code: "registry_unavailable" });
  }
});

test("without confirmed v2 absence, or after v2 history, a default-node v1 record does not route", async () => {
  const v1 = await v1Record(["/dns4/node.tinycloud.xyz/tcp/443/https"]);
  // A v2 outage could hide a newer v2 record.
  expect(await resolveOwnerHosts(subject, { fetch: registry(v1, () => new Response("down", { status: 503 })) }))
    .toMatchObject({ status: "unavailable", reason: "unsupported-format" });
  // Signed-v2 history outranks a later v1-only answer.
  const sequenceStore = createInMemoryRegistrySequenceStore();
  sequenceStore.set(owner.address, 3, "signed-v2");
  expect((await resolveOwnerHosts(subject, { sequenceStore, fetch: registry(v1) })).status).toBe("unavailable");
  const cacheStore = createInMemoryRegistryCacheStore();
  await resolveOwnerHosts(subject, { cacheStore, fetch: registry(v1, new Response(await v2Body(2))) });
  expect((await resolveOwnerHosts(subject, { cacheStore, fetch: registry(v1) })).status).toBe("unavailable");
  // A known legacy owner offline is refused, not sent to the default node.
  const legacyStore = createInMemoryRegistrySequenceStore();
  await resolveOwnerHosts(subject, { sequenceStore: legacyStore, fetch: registry(v1) });
  await expect(resolveFailClosedTinyCloudHosts(owner.address, { sequenceStore: legacyStore, fetch: down, autoDiscoverLocalNode: false }))
    .rejects.toMatchObject({ code: "registry_unavailable" });
});
