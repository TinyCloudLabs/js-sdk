import { describe, expect, it } from "bun:test";
import {
  MANIFEST_OWNER_PLACEHOLDER,
  ManifestValidationError,
  manifestUsesOwnerPlaceholder,
  resolveManifestOwner,
  type Manifest,
} from "./manifest";

// The shared TC-3714 vector: the OpenKey side asserts the same template, owner and resolved list.
const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const template = {
  manifest_version: 1,
  app_id: "xyz.tinycloud.example.vector",
  name: "Vector App",
  permissions: [
    { service: "tinycloud.kv", space: "applications", path: "/", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
    { service: "tinycloud.encryption", path: "urn:tinycloud:encryption:{owner}:default", actions: ["tinycloud.encryption/decrypt"], skipPrefix: true },
    { service: "tinycloud.encryption", path: "urn:tinycloud:encryption:{owner}:default/share/", actions: ["tinycloud.encryption/decrypt"] },
  ],
} satisfies Manifest;

describe("resolveManifestOwner", () => {
  it("replaces the token in every permission path and leaves the template untouched", () => {
    const before = JSON.stringify(template);
    const resolved = resolveManifestOwner(template, OWNER);
    expect(resolved.permissions?.map((entry) => entry.path)).toEqual([
      "/",
      `urn:tinycloud:encryption:${OWNER}:default`,
      `urn:tinycloud:encryption:${OWNER}:default/share/`,
    ]);
    expect(JSON.stringify(template)).toBe(before);
    expect(manifestUsesOwnerPlaceholder(template)).toBe(true);
    expect(manifestUsesOwnerPlaceholder(resolved)).toBe(false);
  });

  it("returns a manifest without the token as the same object", () => {
    const fixed: Manifest = { app_id: "xyz.tinycloud.example.fixed", name: "Fixed", permissions: [{ service: "tinycloud.kv", path: "/", actions: ["tinycloud.kv/get"] }] };
    expect(resolveManifestOwner(fixed, OWNER)).toBe(fixed);
  });

  it("refuses the token outside permissions[].path", () => {
    const message = `${MANIFEST_OWNER_PLACEHOLDER} is only allowed in permissions[].path`;
    const bad: Manifest[] = [
      { ...template, name: "{owner}" },
      { ...template, description: "for {owner}" },
      { ...template, permissions: [{ ...template.permissions[0]!, space: "{owner}" }] },
      { ...template, permissions: [{ ...template.permissions[1]!, description: "{owner}" }] },
      { ...template, additionalDelegates: { "did:key:z6Mk": { permissions: [{ service: "tinycloud.kv", path: "{owner}", actions: ["tinycloud.kv/get"] }] } } } as Manifest,
      { ...template, "{owner}": "x" } as Manifest,
    ];
    for (const manifest of bad) {
      expect(() => resolveManifestOwner(manifest, OWNER)).toThrow(ManifestValidationError);
      expect(() => resolveManifestOwner(manifest, OWNER)).toThrow(message);
    }
  });
});
