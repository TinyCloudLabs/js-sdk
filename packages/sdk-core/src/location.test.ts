import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL,
  canonicalLocationPayload,
  httpUrlToMultiaddr,
  locationPayloadForRecord,
  multiaddrToHttpUrl,
  resolveCloudLocation,
  resolveTinyCloudHosts,
  signLocationRecord,
  validateLocationRecord,
  verifyLocationRecord,
  type LocationRecordPayload,
} from "./location";

describe("location records", () => {
  it("signs and verifies did:pkh records", async () => {
    const account = privateKeyToAccount(
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const payload: LocationRecordPayload = {
      version: 1,
      subject: `did:pkh:eip155:1:${account.address}`,
      multiaddrs: ["/dns4/node.tinycloud.xyz/tcp/443/https"],
      updated_at: "2026-04-28T16:00:00.000Z",
      sequence: 1,
    };

    const record = await signLocationRecord(payload, {
      type: "did:pkh",
      signMessage: (message) => account.signMessage({ message }),
    });

    expect(validateLocationRecord(record)).toEqual(record);
    expect(await verifyLocationRecord(record)).toBe(true);
    expect(
      canonicalLocationPayload(locationPayloadForRecord(record)),
    ).not.toContain("signature");
  });

  it("signs and verifies did:key records", async () => {
    const privateKey = new Uint8Array(32).fill(9);
    const publicKey = ed25519.getPublicKey(privateKey);
    const subject = `did:key:${bases.base58btc.encode(
      Uint8Array.of(0xed, 0x01, ...publicKey),
    )}`;
    const payload: LocationRecordPayload = {
      version: 1,
      subject,
      multiaddrs: ["/dns4/node.tinycloud.xyz/tcp/443/https"],
      updated_at: "2026-04-28T16:00:00.000Z",
      sequence: 1,
    };

    const record = await signLocationRecord(payload, {
      type: "did:key",
      signBytes: async (bytes) => ed25519.sign(bytes, privateKey),
    });

    expect(await verifyLocationRecord(record)).toBe(true);
  });

  it("converts http URLs and multiaddrs", () => {
    const ma = httpUrlToMultiaddr("https://node.tinycloud.xyz/");
    expect(ma).toBe("/dns/node.tinycloud.xyz/tcp/443/tls/http");
    expect(multiaddrToHttpUrl(ma)).toBe("https://node.tinycloud.xyz");
  });
});

describe("resolveTinyCloudHosts", () => {
  it("uses the default registry and hosted node fallback", async () => {
    const subject =
      "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
    const requests: string[] = [];

    const resolved = await resolveTinyCloudHosts(subject, {
      fetch: async (input) => {
        requests.push(String(input));
        return new Response("{}", { status: 404 });
      },
    });

    expect(requests).toEqual([
      `${DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL}/v1/locations/${encodeURIComponent(subject)}`,
    ]);
    expect(resolved.location.source).toBe("fallback");
    expect(resolved.hosts).toEqual([DEFAULT_TINYCLOUD_FALLBACK_HOST]);
  });

  it("lets explicit hosts override registry and fallback defaults", async () => {
    const subject =
      "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
    const resolved = await resolveTinyCloudHosts(subject, {
      explicitHosts: ["https://local.node.test"],
      fetch: async () => new Response("{}", { status: 404 }),
    });

    expect(resolved.location.source).toBe("explicit");
    expect(resolved.hosts).toEqual(["https://local.node.test"]);
  });

  it("allows a custom registry URL", async () => {
    const subject =
      "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
    const registryUrl = "https://registry.example";
    const record = {
      version: 1,
      subject,
      multiaddrs: ["/dns4/registry.node.test/tcp/443/https"],
      updated_at: "2026-04-28T16:00:00.000Z",
      sequence: 1,
      signature: "test-signature",
    };
    const requests: string[] = [];

    const resolved = await resolveTinyCloudHosts(subject, {
      registryUrl,
      verifyRecords: false,
      fetch: async (input) => {
        requests.push(String(input));
        return Response.json({ record });
      },
    });

    expect(requests).toEqual([
      `${registryUrl}/v1/locations/${encodeURIComponent(subject)}`,
    ]);
    expect(resolved.location.source).toBe("centralized");
    expect(resolved.hosts).toEqual(["https://registry.node.test"]);
  });
});

describe("resolveCloudLocation", () => {
  it("queries sources concurrently but ranks explicit first", async () => {
    const subject =
      "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
    const resolved = await resolveCloudLocation(subject, {
      explicitMultiaddrs: ["/dns4/explicit.tinycloud.xyz/tcp/443/https"],
      blockchain: async (requestedSubject) => {
        expect(requestedSubject).toBe(subject);
        return ["/dns4/chain.tinycloud.xyz/tcp/443/https"];
      },
      fallbackMultiaddrs: ["/dns4/fallback.tinycloud.xyz/tcp/443/https"],
    });

    expect(resolved.source).toBe("explicit");
    expect(resolved.multiaddrs).toEqual([
      "/dns4/explicit.tinycloud.xyz/tcp/443/https",
    ]);
    expect(resolved.attempts.map((attempt) => attempt.source)).toEqual([
      "explicit",
      "blockchain",
      "centralized",
      "fallback",
    ]);
  });

  it("falls through when a higher-priority source fails", async () => {
    const subject =
      "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
    const resolved = await resolveCloudLocation(subject, {
      blockchain: async () => {
        throw new Error("chain unavailable");
      },
      fallbackMultiaddrs: ["/dns4/fallback.tinycloud.xyz/tcp/443/https"],
    });

    expect(resolved.source).toBe("fallback");
    expect(resolved.attempts[1].error?.message).toBe("chain unavailable");
  });
});
