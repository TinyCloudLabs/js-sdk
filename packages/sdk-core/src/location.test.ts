import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { privateKeyToAccount } from "viem/accounts";
import {
  canonicalLocationPayload,
  httpUrlToMultiaddr,
  locationPayloadForRecord,
  multiaddrToHttpUrl,
  resolveCloudLocation,
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
    expect(canonicalLocationPayload(locationPayloadForRecord(record))).not.toContain(
      "signature",
    );
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

describe("resolveCloudLocation", () => {
  it("queries sources concurrently but ranks explicit first", async () => {
    const subject = "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
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
    const subject = "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
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
