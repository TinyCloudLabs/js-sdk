import { describe, expect, it } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { LookupOwnerRegistryVerdictOptions } from "./registry-policy";
import * as policyModule from "./registry-policy";
import * as locationModule from "./location";
import type { RegistryVerdict } from "./registry-verdict";

const vectors = await Bun.file(
  `${import.meta.dir}/../test-vectors/registry-v2/registry-v2.json`,
).json() as {
  publicTestIdentities: { owner: string; ownerKey: string; box: string; hosted: string; secrets: string; apps: string };
  records: Array<{ id: string; record: Record<string, unknown>; canonicalPayload: string; expected: Record<string, unknown> }>;
  lookupCases: Array<{ id: string; responses: Array<{ namespace: "v2" | "v1"; status: number; body: string }>; rememberedSequence: number | null; verdict: string }>;
};
const v2 = vectors.records.find(({ id }) => id === "split-data-and-encryption")!;
const owner = privateKeyToAccount(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);

const response = (status: number, body: string): Response => new Response(body, { status });
function responseQueue(answers: Response[], requests: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    requests.push(String(input));
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request: ${String(input)}`);
    return next;
  }) as typeof fetch;
}

interface V2LocationApi {
  validateLocationRecordV2Payload(input: unknown): Record<string, unknown>;
  validateLocationRecordV2(input: unknown): Record<string, unknown>;
  canonicalLocationPayloadV2(payload: Record<string, unknown>): string;
  verifyLocationRecordV2(record: Record<string, unknown>): Promise<boolean>;
  signLocationRecordV2(payload: Record<string, unknown>, signer: unknown): Promise<Record<string, unknown>>;
}

const location = locationModule as typeof locationModule & Partial<V2LocationApi>;
const policy = policyModule as typeof policyModule & {
  resolveRegistryResource?: (
    subject: string,
    resource: string,
    access: "read" | "write" | "host" | "encryption",
    options: LookupOwnerRegistryVerdictOptions,
  ) => Promise<{ verdict: RegistryVerdict; hosts: Array<{ nodeDid?: string; urls: readonly string[] }> }>;
};

function requireV2Api(): asserts location is V2LocationApi {
  expect(typeof location.validateLocationRecordV2Payload).toBe("function");
  expect(typeof location.validateLocationRecordV2).toBe("function");
  expect(typeof location.canonicalLocationPayloadV2).toBe("function");
  expect(typeof location.verifyLocationRecordV2).toBe("function");
  expect(typeof location.signLocationRecordV2).toBe("function");
}

function recordsResponse(record: Record<string, unknown>): Response {
  return Response.json({ record });
}

function v2NotFound(): Response {
  return response(404, '{"error":"location record not found"}');
}

const v2LookupUrl = `${"https://registry.test"}/v2/locations/${encodeURIComponent(vectors.publicTestIdentities.ownerKey)}`;


describe("signed location record v2 vectors", () => {
  it("matches the frozen canonical bytes and schema/signature decisions", async () => {
    requireV2Api();
    for (const vector of vectors.records) {
      if (vector.expected.schemaValid === false) {
        expect(() => location.validateLocationRecordV2(vector.record)).toThrow();
        continue;
      }
      const validated = location.validateLocationRecordV2(vector.record);
      expect(location.canonicalLocationPayloadV2(validated)).toBe(vector.canonicalPayload);
      expect(await location.verifyLocationRecordV2(validated)).toBe(vector.expected.signatureValid);
    }
  });
  it("validates unsigned payloads and rejects unknown root fields", () => {
    requireV2Api();
    const payload = structuredClone(v2.record) as Record<string, unknown>;
    delete payload.signature;
    expect(location.validateLocationRecordV2Payload(payload)).toEqual(payload);
    expect(() => location.validateLocationRecordV2Payload({ ...payload, primaryNode: vectors.publicTestIdentities.box })).toThrow();
  });

  it("rejects malformed or non-normalized space URI names for both owner methods", () => {
    for (const id of ["split-data-and-encryption", "ed25519-owner-listed-space"]) {
      const fixture = vectors.records.find((record) => record.id === id)!;
      const { signature: _signature, ...payload } = locationModule.validateLocationRecordV2(fixture.record);
      const membership = payload.spaces[0]!;
      const prefix = membership.space.slice(0, membership.space.lastIndexOf(":") + 1);
      for (const name of ["bad%", "bad%0", "%73ecrets", "secrets%41", "secrets%3a", "bad%GG", "secrets[1]", "secrets\\child", "secrets:child", "secrets\u0000"]) {
        expect(() => locationModule.validateLocationRecordV2Payload({
          ...payload,
          spaces: [{ ...membership, space: prefix + name }],
        })).toThrow(locationModule.LocationRecordValidationError);
      }
    }
  });

  it("preserves canonical reserved and non-ASCII percent octets in signed space strings", () => {
    for (const id of ["split-data-and-encryption", "ed25519-owner-listed-space"]) {
      const fixture = vectors.records.find((record) => record.id === id)!;
      const { signature: _signature, ...payload } = locationModule.validateLocationRecordV2(fixture.record);
      const membership = payload.spaces[0]!;
      const prefix = membership.space.slice(0, membership.space.lastIndexOf(":") + 1);
      for (const name of ["secrets%2Farchive", "key%3Aalias", "%C3%A9", "app!$&'()*+,;=@._~-"]) {
        const space = prefix + name;
        const supplied = { ...payload, spaces: [{ ...membership, space }] };
        const validated = locationModule.validateLocationRecordV2Payload(supplied);
        expect(validated.spaces[0]!.space).toBe(space);
        expect(locationModule.canonicalLocationPayloadV2(validated)).toContain(`"space":${JSON.stringify(space)}`);
        expect(supplied.spaces[0]!.space).toBe(space);
      }
    }
  });

  it("treats an unrecoverable canonical EOA signature as invalid rather than rejecting verification", async () => {
    // x=5 has no secp256k1 curve point; r/s are still positive, in-range and low-s.
    const signature = `0x${"5".padStart(64, "0")}${"1".padStart(64, "0")}1b`;
    const record = locationModule.validateLocationRecordV2({ ...v2.record, signature });
    await expect(locationModule.verifyLocationRecordV2(record)).resolves.toBe(false);
    const verdict = await policyModule.resolveOwnerHosts(record.subject, {
      registryUrl: "https://registry.test",
      fetch: responseQueue([recordsResponse(record)]),
    });
    expect(verdict).toMatchObject({ status: "unavailable", reason: "invalid-signature" });
  });


  it("accepts owner-bounded did:key spaces and rejects another did:key owner", () => {
    requireV2Api();
    const owned = vectors.records.find(({ id }) => id === "ed25519-owner-listed-space")!.record;
    const foreign = vectors.records.find(({ id }) => id === "ed25519-owner-foreign-key-space")!.record;
    expect(location.validateLocationRecordV2(owned).spaces).toHaveLength(1);
    expect(() => location.validateLocationRecordV2(foreign)).toThrow();
  });

  it("rejects EOA spaces that differ only by address checksum casing", () => {
    requireV2Api();
    const payload = structuredClone(v2.record) as Record<string, unknown> & {
      signature?: string;
      spaces: Array<{ space: string; nodes: unknown[] }>;
    };
    delete payload.signature;
    const firstSpace = payload.spaces[0]!;
    const duplicateSpace = firstSpace.space.replace(
      /(tinycloud:pkh:eip155:[0-9]+:)0x[a-fA-F0-9]{40}(:.+)/,
      `$1${vectors.publicTestIdentities.ownerKey}$2`,
    );
    expect(duplicateSpace).not.toBe(firstSpace.space);
    payload.spaces.push({ ...firstSpace, space: duplicateSpace });
    expect(() => location.validateLocationRecordV2Payload(payload)).toThrow();
  });

  it("signs and verifies a v2 payload without mutating caller arrays", async () => {
    requireV2Api();
    const payload = structuredClone(v2.record) as Record<string, unknown>;
    delete payload.signature;
    const before = structuredClone(payload);
    const signed = await location.signLocationRecordV2(payload, {
      type: "did:pkh",
      signMessage: (message: string) => owner.signMessage({ message }),
    });
    expect(payload).toEqual(before);
    expect(await location.verifyLocationRecordV2(signed)).toBe(true);
  });
});

describe("v2-first owner lookup", () => {
  it("uses the EIP-55 address key across caller chain IDs and remembers sequence by that key", async () => {
    const requests: string[] = [];
    const store = policy.createInMemoryRegistrySequenceStore();
    const subject = `did:pkh:eip155:137:${vectors.publicTestIdentities.ownerKey}`;
    const result = await policy.resolveOwnerHosts(subject, {
      registryUrl: "https://registry.test",
      sequenceStore: store,
      fetch: responseQueue([recordsResponse(v2.record)], requests),
    });
    expect(result).toMatchObject({ status: "registered", sequence: 7, record: v2.record });
    expect(requests).toEqual([v2LookupUrl]);
    expect(await store.get(vectors.publicTestIdentities.ownerKey)).toBe(7);
  });


  it.each(vectors.lookupCases.filter(({ id }) => id !== "service-unavailable" && id !== "v1-service-unavailable"))("applies frozen lookup context $id", async (vector) => {
    const requests: string[] = [];
    const store = policy.createInMemoryRegistrySequenceStore();
    if (vector.rememberedSequence !== null) {
      await store.set(vectors.publicTestIdentities.ownerKey, vector.rememberedSequence);
    }
    const result = await policy.resolveOwnerHosts(vectors.publicTestIdentities.owner, {
      registryUrl: "https://registry.test",
      sequenceStore: store,
      fetch: responseQueue(vector.responses.map(({ status, body }) => response(status, body)), requests),
    });
    expect(result.status).toBe(vector.verdict);
    expect(requests.map((url) => new URL(url).pathname)).toEqual(vector.responses.map(({ namespace }) =>
      namespace === "v2"
        ? `/v2/locations/${encodeURIComponent(vectors.publicTestIdentities.ownerKey)}`
        : `/v1/locations/${encodeURIComponent(vectors.publicTestIdentities.owner)}`,
    ));
    if (vector.id === "v1-only-registered-owner") {
      expect(result).toMatchObject({ status: "unavailable", reason: "unsupported-format", hosts: [] });
    }
    if (vector.id === "absent-after-registration") {
      expect(result).toMatchObject({ status: "unavailable", reason: "not-found-after-registered" });
    }
  });

  it.each(["service-unavailable", "v1-service-unavailable"])("distinguishes cold policy from raw outage vector %s and known-owner refusal", async (id) => {
    const vector = vectors.lookupCases.find((entry) => entry.id === id)!;
    const requests: string[] = [];
    const answers = vector.responses.map(({ status, body }) => response(status, body));
    // Cold v2 outage still probes v1 before allowing onboarding.
    if (id === "service-unavailable") answers.push(v2NotFound());
    const result = await policy.resolveOwnerHosts(vectors.publicTestIdentities.owner, {
      registryUrl: "https://registry.test", fetch: responseQueue(answers, requests),
    });
    expect(result).toMatchObject({ status: "unregistered", offline: true, hosts: [] });
    expect(requests).toEqual([v2LookupUrl, `https://registry.test/v1/locations/${encodeURIComponent(vectors.publicTestIdentities.owner)}`]);
    const sequenceStore = policy.createInMemoryRegistrySequenceStore();
    await sequenceStore.set(vectors.publicTestIdentities.ownerKey, 0);
    const knownRequests: string[] = [];
    expect(await policy.resolveOwnerHosts(vectors.publicTestIdentities.owner, {
      registryUrl: "https://registry.test", sequenceStore,
      fetch: responseQueue([response(503, "")], knownRequests),
    })).toMatchObject({ status: "unavailable", reason: "http-status" });
    expect(knownRequests).toEqual([v2LookupUrl]);
    expect(await sequenceStore.get(vectors.publicTestIdentities.ownerKey)).toBe(0);
  });

  it("rejects duplicate JSON keys as malformed v2 without probing v1", async () => {
    const requests: string[] = [];
    const result = await policy.resolveOwnerHosts(vectors.publicTestIdentities.owner, {
      registryUrl: "https://registry.test",
      fetch: responseQueue([
        response(200, '{"record":{"version":2,"version":2}}'),
      ], requests),
    });
    expect(result).toMatchObject({ status: "unavailable", reason: "malformed-response" });
    expect(requests).toEqual([v2LookupUrl]);
  });

  it("does not downgrade v2 errors or a remembered v2 registration", async () => {
    const requests: string[] = [];
    const store = policy.createInMemoryRegistrySequenceStore();
    await store.set(vectors.publicTestIdentities.ownerKey, 7);
    const absent = await policy.resolveOwnerHosts(vectors.publicTestIdentities.owner, {
      registryUrl: "https://registry.test",
      sequenceStore: store,
      fetch: responseQueue([v2NotFound()], requests),
    });
    expect(absent).toMatchObject({ status: "unavailable", reason: "not-found-after-registered" });
    expect(requests).toEqual([v2LookupUrl]);
  });
});

describe("signed resource routing", () => {
  async function route(resource: string, access: "read" | "write" | "host" | "encryption") {
    if (!policy.resolveRegistryResource) throw new Error("resolveRegistryResource export is missing");
    return policy.resolveRegistryResource(vectors.publicTestIdentities.owner, resource, access, {
      registryUrl: "https://registry.test",
      fetch: responseQueue([recordsResponse(v2.record)]),
    });
  }

  it("routes reads, writes, hosts, and encryption to their distinct signed targets", async () => {
    const read = await route(vectors.publicTestIdentities.secrets, "read");
    const write = await route(vectors.publicTestIdentities.secrets, "write");
    const host = await route(vectors.publicTestIdentities.secrets, "host");
    const encryption = await route(vectors.publicTestIdentities.secrets, "encryption");
    expect(read.hosts.map(({ nodeDid }) => nodeDid)).toEqual([vectors.publicTestIdentities.box]);
    expect(write.hosts.map(({ nodeDid }) => nodeDid)).toEqual([vectors.publicTestIdentities.box]);
    expect(host.hosts.map(({ nodeDid }) => nodeDid)).toEqual([vectors.publicTestIdentities.box]);
    expect(encryption.hosts.map(({ nodeDid }) => nodeDid)).toEqual([vectors.publicTestIdentities.hosted]);
  });

  it("registers read-only space replicas without granting them ordinary writes", async () => {
    const read = await route(vectors.publicTestIdentities.apps, "read");
    const write = await route(vectors.publicTestIdentities.apps, "write");
    const host = await route(vectors.publicTestIdentities.apps, "host");
    expect(read.hosts.map(({ nodeDid }) => nodeDid)).toEqual([vectors.publicTestIdentities.box, vectors.publicTestIdentities.hosted]);
    expect(write.hosts.map(({ nodeDid }) => nodeDid)).toEqual([vectors.publicTestIdentities.hosted]);
    expect(host.hosts.map(({ nodeDid }) => nodeDid)).toEqual([vectors.publicTestIdentities.box, vectors.publicTestIdentities.hosted]);
    expect(() => policy.assertSpaceCreationAllowed(host.verdict, "https://tc2481-box.tinycloud.link", vectors.publicTestIdentities.apps)).not.toThrow();
  });

  it("matches a checksummed EOA request to its lower-case signed space URI", async () => {
    const checksummedResource = vectors.publicTestIdentities.secrets.replace(
      vectors.publicTestIdentities.ownerKey.toLowerCase(),
      vectors.publicTestIdentities.ownerKey,
    );
    const checksummed = await route(checksummedResource, "read");
    expect(checksummed.hosts.map(({ nodeDid }) => nodeDid)).toEqual([vectors.publicTestIdentities.box]);
  });

  it("refuses resources with no signed target and returns empty hosts only for genuine absence", async () => {
    if (!policy.resolveRegistryResource) throw new Error("resolveRegistryResource export is missing");
    for (const access of ["read", "write", "host"] as const) {
      await expect(policy.resolveRegistryResource(vectors.publicTestIdentities.owner, "tinycloud:pkh:eip155:1:0xfcad0b19bb29d4674531d6f115237e16afce377c:missing", access, {
        registryUrl: "https://registry.test",
        fetch: responseQueue([recordsResponse(v2.record)]),
      })).rejects.toBeInstanceOf(policy.NodeNotFoundError);
    }
    const noEntry = await policy.resolveRegistryResource(vectors.publicTestIdentities.owner, vectors.publicTestIdentities.secrets, "read", {
      registryUrl: "https://registry.test",
      fetch: responseQueue([v2NotFound(), v2NotFound()]),
    });
    expect(noEntry).toMatchObject({ verdict: { status: "unregistered" }, hosts: [] });
  });
});

describe("v2 fail-closed host policy", () => {
  it("does not let discovery override a registered record", async () => {
    const requests: string[] = [];
    const result = await policy.resolveFailClosedTinyCloudHosts(vectors.publicTestIdentities.ownerKey, {
      registryUrl: "https://registry.test",
      localNodeUrl: "http://127.0.0.1:8000",
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url.startsWith("https://registry.test/")) return recordsResponse(v2.record);
        if (url.endsWith("/healthz")) return new Response("ok");
        return Response.json({ nodeId: vectors.publicTestIdentities.box });
      }) as typeof fetch,
    });
    expect(result.hosts).toEqual(["https://tc2481-box.tinycloud.link", "https://tc2481-encryption.tinycloud.link"]);
    expect(requests.some((url) => url.startsWith("http://127.0.0.1:8000"))).toBe(false);
  });

  it("does not let a known owner's unavailable registry be overridden by onNodeNotFound", async () => {
    const sequenceStore = policy.createInMemoryRegistrySequenceStore();
    await sequenceStore.set(vectors.publicTestIdentities.ownerKey, 0);
    const result = policy.resolveFailClosedTinyCloudHosts(vectors.publicTestIdentities.ownerKey, {
      registryUrl: "https://registry.test", sequenceStore,
      fetch: responseQueue([response(503, "down")]),
      onNodeNotFound: () => ({ action: "use-host", host: "https://override.example" }),
    });
    await expect(result).rejects.toBeInstanceOf(policy.RegistryUnavailableError);
  });

  it("checks v2 space membership, not just whether any signed node lists the host", async () => {
    const record = await policy.resolveOwnerHosts(vectors.publicTestIdentities.owner, {
      registryUrl: "https://registry.test",
      fetch: responseQueue([recordsResponse(v2.record)]),
    });
    expect(record.status).toBe("registered");
    if (record.status !== "registered") return;
    expect(() => policy.assertSpaceCreationAllowed(record, "https://tc2481-box.tinycloud.link", vectors.publicTestIdentities.secrets)).not.toThrow();
    expect(() => policy.assertSpaceCreationAllowed(record, "https://tc2481-encryption.tinycloud.link", vectors.publicTestIdentities.secrets)).toThrow(policy.NodeRegistryEntryExistsError);
  });
});
