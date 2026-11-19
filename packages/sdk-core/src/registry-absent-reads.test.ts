import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { signLocationRecordV2 } from "./location";
import { lookupOwnerRegistryVerdict, resolveFailClosedTinyCloudHosts, resolveRegistryResource } from "./registry-policy";
import { createRegistryVerdictCache } from "./registry-verdict-cache";
import { REGISTRY_NOT_FOUND_BODY, type RegistryVerdict } from "./registry-verdict";

const owner = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const subject = `did:pkh:eip155:1:${owner.address}`;
const space = `tinycloud:pkh:eip155:1:${owner.address}:default`;
const nodeDid = "did:key:z6MkixsGj3MVGKMug2VMC2JbtzX3UjaAcfRs7G1RjbSnZJaH";
async function record(sequence: number, url: string | null) {
  return JSON.stringify({ record: await signLocationRecordV2({
    version: 2, subject, sequence, updated_at: "2026-11-13T00:00:00.000Z",
    nodes: url ? [{ did: nodeDid, url }] : [],
    spaces: url ? [{ space, nodes: [{ did: nodeDid, mode: "read-write" }] }] : [],
    encryptionNode: null,
  }, { type: "did:pkh", signMessage: message => owner.signMessage({ message }) }) });
}
function fixture() {
  let body: string | undefined;
  let now = 0;
  let requests = 0;
  const fetchFn = Object.assign(async () => {
    requests++;
    return body === undefined ? new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 }) : new Response(body);
  }, { preconnect() {} });
  const options = { registryUrl: "https://registry.test", fetch: fetchFn, dataRead: true,
    verdictCache: createRegistryVerdictCache({ now: () => now, mode: "absent-reads" }) };
  return { options, set(value: string) { body = value; }, at(value: number) { now = value; }, count: () => requests };
}

test("absent-only data reads observe a signed node removal on the next operation", async () => {
  const f = fixture();
  f.set(await record(0, "https://old-node.test"));
  expect((await resolveRegistryResource(subject, space, "read", f.options)).hosts[0]?.urls[0]).toBe("https://old-node.test");
  f.set(await record(1, null));
  await expect(resolveRegistryResource(subject, space, "read", f.options)).rejects.toThrow();
  expect(f.count()).toBe(2);
});

test("a newly registered owner gains a route at the absent TTL, with no signed route before it", async () => {
  const f = fixture();
  expect((await resolveRegistryResource(subject, space, "read", f.options)).hosts).toEqual([]);
  f.set(await record(0, "https://new-node.test"));
  f.at(59_999);
  const held = await resolveRegistryResource(subject, space, "read", f.options);
  expect(held.verdict.status).toBe("unregistered");
  expect(held.hosts).toEqual([]);
  expect(f.count()).toBe(2);
  f.at(60_000);
  expect((await resolveRegistryResource(subject, space, "read", f.options)).hosts[0]?.urls[0]).toBe("https://new-node.test");
  expect(f.count()).toBe(3);
});

for (const access of ["write", "host", "encryption"] as const) {
  test(`a cached absence cannot hide a new registered destination from ${access}`, async () => {
    const f = fixture();
    await resolveRegistryResource(subject, space, "read", f.options);
    f.set(await record(0, "https://new-node.test"));
    const resource = access === "encryption" ? "urn:tinycloud:encryption:eip155:1:unused/default" : space;
    if (access === "encryption") {
      await expect(resolveRegistryResource(subject, resource, access, f.options)).rejects.toThrow();
    } else {
      expect((await resolveRegistryResource(subject, resource, access, f.options)).hosts[0]?.urls[0]).toBe("https://new-node.test");
    }
    expect(f.count()).toBe(3);
  });
}

test("a registered in-flight result is not reused by the next reader", async () => {
  const cache = createRegistryVerdictCache({ mode: "absent-reads" });
  const pending = Promise.withResolvers<RegistryVerdict>();
  const scope = { registryUrl: "https://registry.test", subject, dataRead: true };
  let calls = 0;
  const first = cache.get(scope, () => { calls++; return pending.promise; });
  const second = cache.get(scope, async () => { calls++; return { status: "unavailable", subject, reason: "network-error", source: "offchain", message: "unavailable", hosts: [] }; });
  pending.resolve({ status: "registered", subject, source: "offchain", sequence: 0, hosts: [{ urls: ["https://old-node.test"], source: "offchain" }] });
  expect((await first).status).toBe("registered");
  expect((await second).status).toBe("unavailable");
  expect(calls).toBe(2);
});

test("a lookup not marked as a data read never uses a cached absence, even when it routes as a read", async () => {
  const f = fixture();
  expect((await resolveRegistryResource(subject, space, "read", f.options)).hosts).toEqual([]);
  const absent = f.count();
  f.set(await record(0, "https://new-node.test"));
  const { dataRead: _, ...unmarked } = f.options;
  expect((await resolveRegistryResource(subject, space, "read", unmarked)).hosts[0]?.urls[0]).toBe("https://new-node.test");
  expect((await lookupOwnerRegistryVerdict(subject, unmarked)).status).toBe("registered");
  expect((await resolveFailClosedTinyCloudHosts(owner.address, { ...unmarked, autoDiscoverLocalNode: false, newUserHost: "https://default.test" })).hosts)
    .toEqual(["https://new-node.test"]);
  expect(f.count()).toBe(absent + 3);
});

test("an unmarked lookup drops an in-flight absence, so a store-less data reader looks up again", async () => {
  const f = fixture();
  const pending = Promise.withResolvers<RegistryVerdict>();
  const read = f.options.verdictCache.get({ registryUrl: "https://registry.test", subject, dataRead: true }, () => pending.promise);
  f.set(await record(0, "https://new-node.test"));
  const { dataRead: _, ...unmarked } = f.options;
  expect((await resolveRegistryResource(subject, space, "read", unmarked)).hosts[0]?.urls[0]).toBe("https://new-node.test");
  pending.resolve({ status: "unregistered", subject, source: "offchain", hosts: [] } as unknown as RegistryVerdict);
  expect((await read).status).toBe("unregistered");
  const before = f.count();
  expect((await resolveRegistryResource(subject, space, "read", f.options)).hosts[0]?.urls[0]).toBe("https://new-node.test");
  expect(f.count()).toBe(before + 1);
});
