import { describe, expect, test } from "bun:test";
import { KV } from "@tinycloud/sdk-core";
import {
  REPLICATION_CONSENT_WINDOW_MS,
  replicationConsentAnchorMs,
  replicationConsentExpired,
  replicationRestoreAccepted,
  replicationPermissionsFor,
  requiredReplicationPrefixes,
} from "../src/modules/replicationReconsent";
import { CONSENT_WINDOW_MS } from "../../sdk-services/src/kv/replication/contractConstants";

// Tests may read sdk-services source; the web-sdk bundle may not. The relative
// path reads the leaf constants module directly, so CI needs no sdk-services build.
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ANCHOR_ISO = "2025-01-01T00:00:00.000Z";
const ANCHOR_MS = Date.parse(ANCHOR_ISO);

function siwe(issuedAt: string): string {
  return [
    "localhost wants you to sign in with your Ethereum account:",
    "0x0000000000000000000000000000000000000001",
    "",
    `Issued At: ${issuedAt}`,
    "Expiration Time: 2099-01-01T00:00:00.000Z",
  ].join("\n");
}

describe("consent anchor", () => {
  test("reads the SIWE Issued At line", () => {
    expect(replicationConsentAnchorMs(siwe(ANCHOR_ISO))).toBe(ANCHOR_MS);
  });

  test("returns null when Issued At is absent or unparseable", () => {
    expect(replicationConsentAnchorMs("no issued line here")).toBeNull();
    expect(replicationConsentAnchorMs(siwe("not-a-date"))).toBeNull();
  });
});

describe("consent deadline", () => {
  test("window is 7 days", () => {
    expect(REPLICATION_CONSENT_WINDOW_MS).toBe(SEVEN_DAYS_MS);
  });

  test("expires at the anchor plus 7 days, inclusive of the boundary", () => {
    const message = siwe(ANCHOR_ISO);
    expect(replicationConsentExpired(message, ANCHOR_MS + SEVEN_DAYS_MS - 1)).toBe(false);
    expect(replicationConsentExpired(message, ANCHOR_MS + SEVEN_DAYS_MS)).toBe(true);
  });

  test("without an anchor the deadline fails closed (fresh sign-in, never a fail-open restore)", () => {
    expect(replicationConsentExpired("no issued line", ANCHOR_MS)).toBe(true);
    expect(replicationConsentExpired(siwe("not-a-date"), ANCHOR_MS)).toBe(true);
  });
});

describe("restore acceptance", () => {
  const ADDR = "0x00000000000000000000000000000000000000aA";
  const NOW = ANCHOR_MS + SEVEN_DAYS_MS - 1000;
  const ok = {
    siwe: siwe(ANCHOR_ISO),
    now: NOW,
    stampValid: true,
    sessionAddress: ADDR,
    sessionChainId: 1,
    walletAddress: ADDR.toLowerCase(),
    walletChainId: 1,
    resolvedSpace: "space-1",
    configuredSpace: "space-1",
    coversRequired: true,
  };

  test("accepts only when every check passes", () => {
    expect(replicationRestoreAccepted(ok)).toBe(true);
  });

  test("rejects an invalid or missing stamp", () => {
    expect(replicationRestoreAccepted({ ...ok, stampValid: false })).toBe(false);
  });

  test("rejects expired or unanchored consent, online or offline alike", () => {
    expect(replicationRestoreAccepted({ ...ok, now: ANCHOR_MS + SEVEN_DAYS_MS })).toBe(false);
    expect(replicationRestoreAccepted({ ...ok, siwe: "no issued line" })).toBe(false);
  });

  test("rejects an unknown or different primary space", () => {
    expect(replicationRestoreAccepted({ ...ok, resolvedSpace: undefined })).toBe(false);
    expect(replicationRestoreAccepted({ ...ok, resolvedSpace: "space-2" })).toBe(false);
  });

  test("rejects uncovered get+sync prefixes", () => {
    expect(replicationRestoreAccepted({ ...ok, coversRequired: false })).toBe(false);
  });

  test("rejects when no wallet is connected", () => {
    expect(replicationRestoreAccepted({ ...ok, walletAddress: undefined, walletChainId: undefined })).toBe(false);
  });

  test("rejects a connected wallet whose address or chain differs from restored A", () => {
    expect(replicationRestoreAccepted({ ...ok, walletAddress: "0x0000000000000000000000000000000000000bbb" })).toBe(false);
    expect(replicationRestoreAccepted({ ...ok, walletChainId: 10 })).toBe(false);
  });
 });
 
 describe("replication coverage", () => {
});

describe("replication coverage", () => {
  test("requests get and sync on each required prefix in the primary space", () => {
    expect(replicationPermissionsFor("space-1", ["notes/"])).toEqual([
      { service: "tinycloud.kv", space: "space-1", path: "notes/", actions: [KV.GET, KV.SYNC] },
    ]);
  });

  test("the root prefix maps to the empty path", () => {
    expect(replicationPermissionsFor("space-1", ["/"])[0]?.path).toBe("");
  });

  test("root and vault prefixes are excluded without allowSecrets", () => {
    expect(requiredReplicationPrefixes(["vault/key", "notes/"], "space-1", false)).toEqual(["notes/"]);
    expect(requiredReplicationPrefixes(["/", "notes/"], "space-1", false)).toEqual(["notes/"]);
    expect(requiredReplicationPrefixes(["/", "notes/"], "space-1", true)).toEqual(["/", "notes/"]);
  });

  test("secrets spaces require opt-in for every prefix", () => {
    expect(requiredReplicationPrefixes(["notes/"], "secrets", false)).toEqual([]);
    expect(requiredReplicationPrefixes(["notes/"], "tinycloud:secrets", false)).toEqual([]);
    expect(requiredReplicationPrefixes(["notes/"], "tinycloud:secrets", true)).toEqual(["notes/"]);
  });
});

describe("consent window constant", () => {
  test("equals the sdk-services contract CONSENT_WINDOW_MS", () => {
    expect(REPLICATION_CONSENT_WINDOW_MS).toBe(CONSENT_WINDOW_MS);
  });
});
