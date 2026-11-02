/*
 * TC-2242. The permission entries `planPathBoundShare` hands a consumer must be exactly what the SDK's runtime request path
 * accepts (`requestPermissions` / `grantRuntimePermissions` expand them with `expandRuntimePermissionEntries`): the exact-key
 * `key.create`, and the decrypt prefix the node's policy registration needs. Checked against the real sdk-core expander.
 */
import { describe, expect, test } from "bun:test";
import { expandPermissionEntries, expandRuntimePermissionEntries, type PermissionEntry } from "@tinycloud/sdk-core";
import { defaultEncryptionNetworkForOwner, planPathBoundShare } from "@tinycloud/share-sdk";

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const SHARE_ID = "pathboundshare00000001";

describe("path-bound plan permissions are valid runtime entries", () => {
  const plan = planPathBoundShare({ shareId: SHARE_ID, encryptionNetwork: defaultEncryptionNetworkForOwner(OWNER.toLowerCase()) });

  test("the entries are assignable to PermissionEntry and expand to the key.create leaf and the decrypt prefix, nothing wider", () => {
    const entries: PermissionEntry[] = [...plan.requiredPermissions, ...plan.registrationPermissions];
    const expanded = expandRuntimePermissionEntries(entries, OWNER.toLowerCase());
    expect(expanded.map((entry) => [entry.path, entry.actions])).toEqual([
      [`${plan.encryptionNetwork}/share/${SHARE_ID}`, ["tinycloud.encryption/key.create"]],
      [`${plan.encryptionNetwork}/share/`, ["tinycloud.encryption/decrypt"]],
    ]);
  });

  test("a lower-cased network is not a valid runtime resource (why the plan refuses it)", () => {
    const lower = plan.requiredPermissions.map((entry) => ({ ...entry, path: entry.path.toLowerCase() }));
    expect(() => expandRuntimePermissionEntries(lower, OWNER)).toThrow();
  });

  test("the plan never asks for the bare network", () => {
    for (const entry of [...plan.requiredPermissions, ...plan.registrationPermissions]) {
      expect(entry.path).not.toBe(plan.encryptionNetwork);
      expect(entry.path.startsWith(`${plan.encryptionNetwork}/share/`)).toBe(true);
    }
  });

  test("sessionPermissions are valid manifest entries (key.create + decrypt on the share prefix), and the runtime route refuses that prefix key.create", () => {
    const entries: PermissionEntry[] = plan.sessionPermissions;
    const expanded = expandPermissionEntries(entries);
    expect(expanded.map((entry) => [entry.path, entry.actions])).toEqual([
      [`${plan.encryptionNetwork}/share/`, ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"]],
    ]);
    expect(() => expandRuntimePermissionEntries(entries, OWNER)).toThrow();
  });
});
