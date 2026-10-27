import { describe, expect, test } from "bun:test";
import { pkhDid } from "@tinycloud/bootstrap";
import { encryptionResourceContains, formatKeyResource, formatPrefixResource } from "@tinycloud/sdk-services/encryption/resource";
import {
  ManifestValidationError,
  expandDelegationPermissionEntries,
  expandPermissionEntries,
  type PermissionEntry,
} from "./manifest";
import { isCapabilitySubset } from "./capabilities";

const owner = pkhDid("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", 1);
const network = `urn:tinycloud:encryption:${owner}:default`;
const key = formatKeyResource(network, "apps/chat.tinycloud.tinychat/connectors/fireflies");
const prefix = formatPrefixResource(network, "apps/chat.tinycloud.tinychat/connectors");
const entry = (path: string, actions = ["decrypt"]): PermissionEntry => ({
  service: "tinycloud.encryption", path, actions,
});

describe("exact named-key delegation expansion", () => {
  test("emits the same canonical resource as the named-key client", () => {
    expect(expandDelegationPermissionEntries([entry(key)])).toEqual([{
      service: "tinycloud.encryption", space: "encryption", path: key,
      actions: ["tinycloud.encryption/decrypt"], skipPrefix: true,
    }]);
    expect(key).toContain(owner);
  });

  test("a signed prefix or exact grant covers the key; a bare network does not", () => {
    const requested = expandDelegationPermissionEntries([entry(key)]);
    for (const grant of [prefix, key]) {
      expect(isCapabilitySubset(requested, [{ ...requested[0]!, path: grant }]).subset).toBe(true);
      expect(encryptionResourceContains(grant, key)).toBe(true);
    }
    expect(isCapabilitySubset(requested, [{ ...requested[0]!, path: network }]).subset).toBe(false);
    expect(isCapabilitySubset(requested, [{ ...requested[0]!, path: prefix, actions: ["tinycloud.encryption/*"] }]).subset).toBe(false);
    const sibling = formatKeyResource(network, "apps/chat.tinycloud.tinychat/connectors2/fireflies");
    expect(isCapabilitySubset(expandDelegationPermissionEntries([entry(sibling)]), [{ ...requested[0]!, path: prefix }]).subset).toBe(false);
  });

  test("rejects child prefixes, create, and non-canonical owners", () => {
    for (const invalid of [entry(prefix), entry(key, ["key.create"]), entry(key, ["decrypt", "key.create"]), entry(key.replace(owner, owner.toLowerCase()))]) {
      expect(() => expandDelegationPermissionEntries([invalid])).toThrow(ManifestValidationError);
    }
  });

  test("manifest expansion still rejects named-key permission entries", () => {
    expect(() => expandPermissionEntries([entry(key)])).toThrow("named keys go in manifest.keys");
  });
});
