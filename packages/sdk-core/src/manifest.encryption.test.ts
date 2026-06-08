/**
 * Manifest tests for the tinycloud.encryption service.
 *
 * Encryption permissions:
 * - Use the networkId URN as the resource (not a space-shaped path).
 * - Are exempt from manifest prefix application — networkIds are
 *   top-level owner-scoped resources.
 * - Expand "decrypt" → "tinycloud.encryption/decrypt".
 */

import { describe, expect, it } from "bun:test";

import {
  ENCRYPTION_MANIFEST_SPACE,
  ENCRYPTION_PERMISSION_SERVICE,
  ManifestValidationError,
  SERVICE_LONG_TO_SHORT,
  SERVICE_SHORT_TO_LONG,
  composeManifestRequest,
  expandPermissionEntries,
  resolveManifest,
  resourceCapabilitiesToAbilitiesMap,
  resourceCapabilitiesToSpaceAbilitiesMap,
  type Manifest,
  type PermissionEntry,
  type ResourceCapability,
} from "./manifest";

const NETWORK_ID = "urn:tinycloud:encryption:did:key:z6MkPrincipal:default";

describe("manifest tinycloud.encryption mapping", () => {
  it("registers the short/long service mapping", () => {
    expect(SERVICE_SHORT_TO_LONG.encryption).toBe("tinycloud.encryption");
    expect(SERVICE_LONG_TO_SHORT["tinycloud.encryption"]).toBe("encryption");
  });
});

describe("expandPermissionEntries (encryption)", () => {
  it("expands `decrypt` into the full URN action", () => {
    expect(
      expandPermissionEntries([
        {
          service: ENCRYPTION_PERMISSION_SERVICE,
          path: NETWORK_ID,
          actions: ["decrypt"],
        },
      ]),
    ).toEqual([
      {
        service: ENCRYPTION_PERMISSION_SERVICE,
        space: ENCRYPTION_MANIFEST_SPACE,
        path: NETWORK_ID,
        actions: ["tinycloud.encryption/decrypt"],
        skipPrefix: true,
      },
    ]);
  });

  it("rejects non-networkId paths", () => {
    expect(() =>
      expandPermissionEntries([
        {
          service: ENCRYPTION_PERMISSION_SERVICE,
          path: "applications/com.example/data",
          actions: ["decrypt"],
        },
      ]),
    ).toThrow(ManifestValidationError);
  });

  it("rejects unknown encryption actions", () => {
    expect(() =>
      expandPermissionEntries([
        {
          service: ENCRYPTION_PERMISSION_SERVICE,
          path: NETWORK_ID,
          actions: ["sign"],
        },
      ]),
    ).toThrow(ManifestValidationError);
  });

  it("passes through already-expanded actions", () => {
    const result = expandPermissionEntries([
      {
        service: ENCRYPTION_PERMISSION_SERVICE,
        path: NETWORK_ID,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].actions).toEqual(["tinycloud.encryption/decrypt"]);
  });
});

describe("resolveManifest (encryption)", () => {
  it("skips manifest prefix application on networkId paths", () => {
    const manifest: Manifest = {
      manifest_version: 1,
      app_id: "com.example.app",
      name: "Example",
      defaults: false,
      permissions: [
        {
          service: ENCRYPTION_PERMISSION_SERVICE,
          path: NETWORK_ID,
          actions: ["decrypt"],
        },
      ],
    };

    const resolved = resolveManifest(manifest);
    const encryptionResources = resolved.resources.filter(
      (r) => r.service === ENCRYPTION_PERMISSION_SERVICE,
    );
    expect(encryptionResources).toHaveLength(1);
    expect(encryptionResources[0].path).toBe(NETWORK_ID);
    expect(encryptionResources[0].space).toBe(ENCRYPTION_MANIFEST_SPACE);
    expect(encryptionResources[0].actions).toEqual([
      "tinycloud.encryption/decrypt",
    ]);
    expect(
      resolved.resources.some(
        (r) =>
          r.service === "tinycloud.capabilities" &&
          r.space === ENCRYPTION_MANIFEST_SPACE,
      ),
    ).toBe(false);
  });

  it("does NOT collapse the networkId URN into the app's default space", () => {
    const manifest: Manifest = {
      manifest_version: 1,
      app_id: "com.example.app",
      name: "Example",
      defaults: false,
      space: "applications",
      permissions: [
        {
          service: ENCRYPTION_PERMISSION_SERVICE,
          path: NETWORK_ID,
          actions: ["decrypt"],
        },
      ],
    };
    const resolved = resolveManifest(manifest);
    const encryption = resolved.resources.find(
      (r) => r.service === ENCRYPTION_PERMISSION_SERVICE,
    );
    expect(encryption?.space).toBe(ENCRYPTION_MANIFEST_SPACE);
  });
});

describe("resourceCapabilitiesToAbilitiesMap (encryption)", () => {
  it("uses the networkId URN as the resource key under the encryption short service", () => {
    const resources: ResourceCapability[] = [
      {
        service: ENCRYPTION_PERMISSION_SERVICE,
        space: ENCRYPTION_MANIFEST_SPACE,
        path: NETWORK_ID,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ];
    const abilities = resourceCapabilitiesToAbilitiesMap(resources);
    expect(abilities).toEqual({
      encryption: {
        [NETWORK_ID]: ["tinycloud.encryption/decrypt"],
      },
    });
  });

  it("groups encryption resources under their synthetic 'encryption' space", () => {
    const resources: ResourceCapability[] = [
      {
        service: ENCRYPTION_PERMISSION_SERVICE,
        space: ENCRYPTION_MANIFEST_SPACE,
        path: NETWORK_ID,
        actions: ["tinycloud.encryption/decrypt"],
      },
      {
        service: "tinycloud.kv",
        space: "applications",
        path: "com.example.app/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const spaceAbilities = resourceCapabilitiesToSpaceAbilitiesMap(resources);
    expect(spaceAbilities[ENCRYPTION_MANIFEST_SPACE]).toEqual({
      encryption: {
        [NETWORK_ID]: ["tinycloud.encryption/decrypt"],
      },
    });
    expect(spaceAbilities.applications).toEqual({
      kv: {
        "com.example.app/": ["tinycloud.kv/get"],
      },
    });
  });
});

describe("composeManifestRequest (encryption + KV bundle)", () => {
  it("bundles network decrypt + KV read in one composed request", () => {
    const manifest: Manifest = {
      manifest_version: 1,
      app_id: "com.example.secrets",
      name: "Secrets",
      defaults: false,
      space: "applications",
      permissions: [
        {
          service: "tinycloud.kv",
          space: "applications",
          path: "secrets/",
          actions: ["get", "list"],
          skipPrefix: true,
        },
        {
          service: ENCRYPTION_PERMISSION_SERVICE,
          path: NETWORK_ID,
          actions: ["decrypt"],
        },
      ],
    };
    const composed = composeManifestRequest([manifest], {
      includeAccountRegistryPermissions: false,
    });
    const services = new Set(composed.resources.map((r) => r.service));
    expect(services.has("tinycloud.kv")).toBe(true);
    expect(services.has(ENCRYPTION_PERMISSION_SERVICE)).toBe(true);
    const encryption = composed.resources.find(
      (r) => r.service === ENCRYPTION_PERMISSION_SERVICE,
    );
    expect(encryption?.path).toBe(NETWORK_ID);
    expect(encryption?.actions).toEqual(["tinycloud.encryption/decrypt"]);
  });
});
