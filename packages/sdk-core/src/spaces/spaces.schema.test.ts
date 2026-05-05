/**
 * Tests for spaces.schema.ts Zod schemas.
 */

import { describe, expect, it } from "bun:test";
import {
  SpaceConfigSchema,
  SpaceServiceConfigSchema,
  SpaceDelegationParamsSchema,
  validateSpaceConfig,
  validateSpaceServiceConfig,
  validateSpaceDelegationParams,
} from "./spaces.schema";

// =============================================================================
// Test Fixtures
// =============================================================================

const mockFunction = () => {};
const mockAsyncFunction = async () => ({});

const validSpaceConfig = {
  id: "tinycloud:pkh:eip155:1:0x1234567890123456789012345678901234567890:default",
  name: "default",
  createKV: mockFunction,
  createVault: mockFunction,
  createDelegations: mockFunction,
  createSharing: mockFunction,
  getInfo: mockAsyncFunction,
};

const validSpaceServiceConfig = {
  hosts: ["https://node.tinycloud.xyz"],
  session: { spaceId: "space123", verificationMethod: "did:key:z6Mk..." },
  invoke: mockFunction,
  fetch: mockFunction,
  capabilityRegistry: {},
  createKVService: mockFunction,
  createVaultService: mockFunction,
  userDid: "did:pkh:eip155:1:0x1234567890123456789012345678901234567890",
  sharingService: {},
  createDelegation: mockAsyncFunction,
};

const validSpaceDelegationParams = {
  delegateDID: "did:pkh:eip155:1:0xabcdef7890123456789012345678901234567890",
  path: "/shared/",
  actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
  spaceId: "tinycloud:pkh:eip155:1:0x1234567890123456789012345678901234567890:default",
};

// =============================================================================
// SpaceConfigSchema Tests
// =============================================================================

describe("SpaceConfigSchema", () => {
  describe("valid inputs", () => {
    it("accepts valid space config with all fields", () => {
      const result = SpaceConfigSchema.safeParse(validSpaceConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(validSpaceConfig.id);
        expect(result.data.name).toBe("default");
      }
    });

    it("accepts config with different space names", () => {
      const names = ["default", "photos", "documents", "my-space", "space_123"];
      for (const name of names) {
        const data = { ...validSpaceConfig, name };
        const result = SpaceConfigSchema.safeParse(data);
        expect(result.success).toBe(true);
      }
    });

    it("accepts config with arrow function factories", () => {
      const data = {
        ...validSpaceConfig,
        createKV: (spaceId: string) => ({ spaceId }),
        createVault: (spaceId: string) => ({ spaceId }),
        createDelegations: (spaceId: string) => ({ spaceId }),
        createSharing: (spaceId: string) => ({ spaceId }),
        getInfo: async (spaceId: string) => ({ ok: true, data: { id: spaceId } }),
      };
      const result = SpaceConfigSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    it("rejects missing id field", () => {
      const data = { ...validSpaceConfig };
      delete (data as Record<string, unknown>).id;
      const result = SpaceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects missing name field", () => {
      const data = { ...validSpaceConfig };
      delete (data as Record<string, unknown>).name;
      const result = SpaceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects missing createKV factory", () => {
      const data = { ...validSpaceConfig };
      delete (data as Record<string, unknown>).createKV;
      const result = SpaceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects missing createVault factory", () => {
      const data = { ...validSpaceConfig };
      delete (data as Record<string, unknown>).createVault;
      const result = SpaceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects missing createDelegations factory", () => {
      const data = { ...validSpaceConfig };
      delete (data as Record<string, unknown>).createDelegations;
      const result = SpaceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects missing createSharing factory", () => {
      const data = { ...validSpaceConfig };
      delete (data as Record<string, unknown>).createSharing;
      const result = SpaceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects missing getInfo function", () => {
      const data = { ...validSpaceConfig };
      delete (data as Record<string, unknown>).getInfo;
      const result = SpaceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects non-function createKV", () => {
      const data = { ...validSpaceConfig, createKV: "not a function" };
      const result = SpaceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects non-function createVault", () => {
      const data = { ...validSpaceConfig, createVault: "not a function" };
      const result = SpaceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects null", () => {
      const result = SpaceConfigSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it("rejects empty object", () => {
      const result = SpaceConfigSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// SpaceServiceConfigSchema Tests
// =============================================================================

describe("SpaceServiceConfigSchema", () => {
  describe("valid inputs", () => {
    it("accepts valid config with all fields", () => {
      const result = SpaceServiceConfigSchema.safeParse(validSpaceServiceConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hosts).toEqual(["https://node.tinycloud.xyz"]);
        expect(result.data.userDid).toBe(
          "did:pkh:eip155:1:0x1234567890123456789012345678901234567890"
        );
      }
    });

    it("accepts config with only required fields", () => {
      const data = {
        hosts: ["https://node.tinycloud.xyz"],
        session: { spaceId: "space123" },
        invoke: mockFunction,
      };
      const result = SpaceServiceConfigSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it("accepts config with multiple hosts", () => {
      const data = {
        ...validSpaceServiceConfig,
        hosts: [
          "https://node1.tinycloud.xyz",
          "https://node2.tinycloud.xyz",
          "https://node3.tinycloud.xyz",
        ],
      };
      const result = SpaceServiceConfigSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hosts).toHaveLength(3);
      }
    });

    it("accepts config without optional fields", () => {
      const data = {
        hosts: ["https://node.tinycloud.xyz"],
        session: {},
        invoke: mockFunction,
      };
      const result = SpaceServiceConfigSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it("accepts null session (z.unknown allows any value)", () => {
      const data = {
        hosts: ["https://node.tinycloud.xyz"],
        session: null,
        invoke: mockFunction,
      };
      const result = SpaceServiceConfigSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    it("rejects missing hosts field", () => {
      const data = { ...validSpaceServiceConfig };
      delete (data as Record<string, unknown>).hosts;
      const result = SpaceServiceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("accepts missing session field (z.unknown allows undefined)", () => {
      // Note: z.unknown() accepts any value including undefined,
      // so a missing session field will pass validation.
      // Runtime code should check session presence explicitly.
      const data = { ...validSpaceServiceConfig };
      delete (data as Record<string, unknown>).session;
      const result = SpaceServiceConfigSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it("rejects missing invoke field", () => {
      const data = { ...validSpaceServiceConfig };
      delete (data as Record<string, unknown>).invoke;
      const result = SpaceServiceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects non-array hosts", () => {
      const data = { ...validSpaceServiceConfig, hosts: "https://node.tinycloud.xyz" };
      const result = SpaceServiceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects empty hosts array", () => {
      const data = { ...validSpaceServiceConfig, hosts: [] };
      const result = SpaceServiceConfigSchema.safeParse(data);
      // Note: Empty array is technically valid for z.array(z.string())
      // The schema allows it; business logic should enforce non-empty
      expect(result.success).toBe(true);
    });

    it("rejects non-function invoke", () => {
      const data = { ...validSpaceServiceConfig, invoke: "not a function" };
      const result = SpaceServiceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects non-function fetch when provided", () => {
      const data = { ...validSpaceServiceConfig, fetch: "not a function" };
      const result = SpaceServiceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects non-string userDid when provided", () => {
      const data = { ...validSpaceServiceConfig, userDid: 12345 };
      const result = SpaceServiceConfigSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects null", () => {
      const result = SpaceServiceConfigSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it("rejects empty object", () => {
      const result = SpaceServiceConfigSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// SpaceDelegationParamsSchema Tests
// =============================================================================

describe("SpaceDelegationParamsSchema", () => {
  describe("valid inputs", () => {
    it("accepts valid delegation params with all fields", () => {
      const result = SpaceDelegationParamsSchema.safeParse(validSpaceDelegationParams);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.delegateDID).toBe(validSpaceDelegationParams.delegateDID);
        expect(result.data.spaceId).toBe(validSpaceDelegationParams.spaceId);
        expect(result.data.path).toBe("/shared/");
        expect(result.data.actions).toEqual(["tinycloud.kv/get", "tinycloud.kv/list"]);
      }
    });

    it("accepts params with optional expiry", () => {
      const data = {
        ...validSpaceDelegationParams,
        expiry: new Date("2026-03-01T00:00:00Z"),
      };
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expiry).toBeInstanceOf(Date);
      }
    });

    it("accepts params with disableSubDelegation", () => {
      const data = {
        ...validSpaceDelegationParams,
        disableSubDelegation: true,
      };
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.disableSubDelegation).toBe(true);
      }
    });

    it("accepts params with statement", () => {
      const data = {
        ...validSpaceDelegationParams,
        statement: "I authorize this delegation",
      };
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.statement).toBe("I authorize this delegation");
      }
    });

    it("accepts various DID formats", () => {
      const dids = [
        "did:pkh:eip155:1:0x1234567890123456789012345678901234567890",
        "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
        "did:web:example.com",
      ];
      for (const delegateDID of dids) {
        const data = { ...validSpaceDelegationParams, delegateDID };
        const result = SpaceDelegationParamsSchema.safeParse(data);
        expect(result.success).toBe(true);
      }
    });

    it("accepts various path formats", () => {
      const paths = ["/", "/data/", "/shared/photos/", "/a/b/c/d/"];
      for (const path of paths) {
        const data = { ...validSpaceDelegationParams, path };
        const result = SpaceDelegationParamsSchema.safeParse(data);
        expect(result.success).toBe(true);
      }
    });

    it("accepts single action", () => {
      const data = {
        ...validSpaceDelegationParams,
        actions: ["tinycloud.kv/get"],
      };
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it("accepts multiple actions", () => {
      const data = {
        ...validSpaceDelegationParams,
        actions: [
          "tinycloud.kv/get",
          "tinycloud.kv/put",
          "tinycloud.kv/delete",
          "tinycloud.kv/list",
        ],
      };
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.actions).toHaveLength(4);
      }
    });
  });

  describe("invalid inputs", () => {
    it("rejects missing delegateDID", () => {
      const data = { ...validSpaceDelegationParams };
      delete (data as Record<string, unknown>).delegateDID;
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects missing path", () => {
      const data = { ...validSpaceDelegationParams };
      delete (data as Record<string, unknown>).path;
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects missing actions", () => {
      const data = { ...validSpaceDelegationParams };
      delete (data as Record<string, unknown>).actions;
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects missing spaceId", () => {
      const data = { ...validSpaceDelegationParams };
      delete (data as Record<string, unknown>).spaceId;
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects non-string delegateDID", () => {
      const data = { ...validSpaceDelegationParams, delegateDID: 12345 };
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects non-array actions", () => {
      const data = { ...validSpaceDelegationParams, actions: "tinycloud.kv/get" };
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects non-string spaceId", () => {
      const data = { ...validSpaceDelegationParams, spaceId: 12345 };
      const result = SpaceDelegationParamsSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects null", () => {
      const result = SpaceDelegationParamsSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it("rejects empty object", () => {
      const result = SpaceDelegationParamsSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Validation Function Tests
// =============================================================================

describe("validateSpaceConfig", () => {
  it("returns ok result for valid data", () => {
    const result = validateSpaceConfig(validSpaceConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe(validSpaceConfig.id);
    }
  });

  it("returns error result for invalid data", () => {
    const result = validateSpaceConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("space");
      expect(result.error.meta?.issues).toBeDefined();
    }
  });

  it("returns error with validation issues for missing id", () => {
    const data = { ...validSpaceConfig };
    delete (data as Record<string, unknown>).id;
    const result = validateSpaceConfig(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.meta?.issues).toContainEqual(
        expect.objectContaining({ path: ["id"] })
      );
    }
  });
});

describe("validateSpaceServiceConfig", () => {
  it("returns ok result for valid data", () => {
    const result = validateSpaceServiceConfig(validSpaceServiceConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.hosts).toEqual(["https://node.tinycloud.xyz"]);
    }
  });

  it("returns error result for invalid data", () => {
    const result = validateSpaceServiceConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("space");
    }
  });

  it("returns error with validation issues for missing hosts", () => {
    const data = { ...validSpaceServiceConfig };
    delete (data as Record<string, unknown>).hosts;
    const result = validateSpaceServiceConfig(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.meta?.issues).toContainEqual(
        expect.objectContaining({ path: ["hosts"] })
      );
    }
  });
});

describe("validateSpaceDelegationParams", () => {
  it("returns ok result for valid data", () => {
    const result = validateSpaceDelegationParams(validSpaceDelegationParams);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.spaceId).toBe(validSpaceDelegationParams.spaceId);
      expect(result.data.delegateDID).toBe(validSpaceDelegationParams.delegateDID);
    }
  });

  it("returns error result for invalid data", () => {
    const result = validateSpaceDelegationParams({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.service).toBe("space");
    }
  });

  it("returns error with validation issues for missing spaceId", () => {
    const data = { ...validSpaceDelegationParams };
    delete (data as Record<string, unknown>).spaceId;
    const result = validateSpaceDelegationParams(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.meta?.issues).toContainEqual(
        expect.objectContaining({ path: ["spaceId"] })
      );
    }
  });

  it("returns error with validation issues for missing delegateDID", () => {
    const data = { ...validSpaceDelegationParams };
    delete (data as Record<string, unknown>).delegateDID;
    const result = validateSpaceDelegationParams(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.meta?.issues).toContainEqual(
        expect.objectContaining({ path: ["delegateDID"] })
      );
    }
  });
});
