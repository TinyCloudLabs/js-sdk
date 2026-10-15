import { describe, expect, test } from "bun:test";
import { KV } from "@tinycloud/sdk-core";
import {
  REPLICATION_CONSENT_WINDOW_MS,
  replicationConsentAnchorMs,
  replicationConsentExpired,
  replicationPermissionsFor,
  requiredReplicationPrefixes,
} from "../src/modules/replicationReconsent";

// Values pinned to sdk-services/src/kv/replication/contractConstants.ts (CONSENT_WINDOW_MS = 7 d)
// and scope.ts (requiresSecretsOptIn). sdk-services is not imported into web-sdk.
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

  test("without an anchor the web layer does not expire; storage enforces the deadline locally", () => {
    expect(replicationConsentExpired("no issued line", ANCHOR_MS + 10 * SEVEN_DAYS_MS)).toBe(false);
  });
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
