/**
 * Tests for delegation type Zod schemas.
 */

import { describe, it, expect } from "bun:test";
import {
  JWKSchema,
  KeyTypeSchema,
  KeyInfoSchema,
  DelegationErrorSchema,
  DelegationSchema,
  CapabilityEntrySchema,
  DelegationRecordSchema,
  CreateDelegationParamsSchema,
  DelegationChainSchema,
  DelegationChainV2Schema,
  DelegationDirectionSchema,
  DelegationFiltersSchema,
  SpaceOwnershipSchema,
  SpaceInfoSchema,
  ShareSchemaSchema,
  ShareLinkSchema,
  IngestOptionsSchema,
  GenerateShareParamsSchema,
  DelegationApiResponseSchema,
  CreateDelegationWasmParamsSchema,
  CreateDelegationWasmResultSchema,
  validateDelegation,
  validateCreateDelegationParams,
  validateDelegationFilters,
  validateShareLink,
  createValidator,
  DelegationErrorCodes,
} from "./types.schema.js";

// =============================================================================
// Test Data Factories
// =============================================================================

function createValidJWK() {
  return {
    kty: "EC",
    crv: "P-256",
    x: "test-x-coordinate",
    y: "test-y-coordinate",
  };
}

function createValidDelegation() {
  return {
    cid: "bafyrei1234567890",
    delegateDID: "did:key:z6MkTest",
    spaceId: "space-123",
    path: "/kv/test/*",
    actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    expiry: new Date("2025-12-31"),
    isRevoked: false,
  };
}

function createValidKeyInfo() {
  return {
    id: "key-123",
    did: "did:key:z6MkTest",
    type: "session" as const,
    priority: 0,
  };
}

// =============================================================================
// JWK Schema Tests
// =============================================================================

describe("JWKSchema", () => {
  it("should validate a minimal JWK", () => {
    const jwk = { kty: "EC" };
    const result = JWKSchema.safeParse(jwk);
    expect(result.success).toBe(true);
  });

  it("should validate a full EC JWK", () => {
    const jwk = createValidJWK();
    const result = JWKSchema.safeParse(jwk);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kty).toBe("EC");
      expect(result.data.crv).toBe("P-256");
    }
  });

  it("should validate a JWK with all optional fields", () => {
    const jwk = {
      kty: "RSA",
      n: "test-modulus",
      e: "test-exponent",
      kid: "key-id-123",
      alg: "RS256",
      use: "sig",
      key_ops: ["sign", "verify"],
    };
    const result = JWKSchema.safeParse(jwk);
    expect(result.success).toBe(true);
  });

  it("should reject JWK without kty", () => {
    const jwk = { crv: "P-256" };
    const result = JWKSchema.safeParse(jwk);
    expect(result.success).toBe(false);
  });

  it("should reject JWK with invalid kty type", () => {
    const jwk = { kty: 123 };
    const result = JWKSchema.safeParse(jwk);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// KeyType Schema Tests
// =============================================================================

describe("KeyTypeSchema", () => {
  it("should validate 'main'", () => {
    expect(KeyTypeSchema.safeParse("main").success).toBe(true);
  });

  it("should validate 'session'", () => {
    expect(KeyTypeSchema.safeParse("session").success).toBe(true);
  });

  it("should validate 'ingested'", () => {
    expect(KeyTypeSchema.safeParse("ingested").success).toBe(true);
  });

  it("should reject invalid key type", () => {
    expect(KeyTypeSchema.safeParse("invalid").success).toBe(false);
  });

  it("should reject non-string values", () => {
    expect(KeyTypeSchema.safeParse(123).success).toBe(false);
  });
});

// =============================================================================
// KeyInfo Schema Tests
// =============================================================================

describe("KeyInfoSchema", () => {
  it("should validate minimal key info", () => {
    const keyInfo = createValidKeyInfo();
    const result = KeyInfoSchema.safeParse(keyInfo);
    expect(result.success).toBe(true);
  });

  it("should validate key info with JWK", () => {
    const keyInfo = {
      ...createValidKeyInfo(),
      jwk: createValidJWK(),
    };
    const result = KeyInfoSchema.safeParse(keyInfo);
    expect(result.success).toBe(true);
  });

  it("should reject key info without id", () => {
    const { id, ...keyInfo } = createValidKeyInfo();
    const result = KeyInfoSchema.safeParse(keyInfo);
    expect(result.success).toBe(false);
  });

  it("should reject key info with invalid type", () => {
    const keyInfo = { ...createValidKeyInfo(), type: "invalid" };
    const result = KeyInfoSchema.safeParse(keyInfo);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// DelegationError Schema Tests
// =============================================================================

describe("DelegationErrorSchema", () => {
  it("should validate a minimal delegation error", () => {
    const error = {
      code: "AUTH_REQUIRED",
      message: "Authentication required",
      service: "delegation" as const,
    };
    const result = DelegationErrorSchema.safeParse(error);
    expect(result.success).toBe(true);
  });

  it("should validate delegation error with cause and meta", () => {
    const error = {
      code: "NETWORK_ERROR",
      message: "Request failed",
      service: "delegation" as const,
      cause: new Error("Connection timeout"),
      meta: { attempt: 3, url: "https://example.com" },
    };
    const result = DelegationErrorSchema.safeParse(error);
    expect(result.success).toBe(true);
  });

  it("should reject error with wrong service", () => {
    const error = {
      code: "AUTH_REQUIRED",
      message: "Authentication required",
      service: "other",
    };
    const result = DelegationErrorSchema.safeParse(error);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// Delegation Schema Tests
// =============================================================================

describe("DelegationSchema", () => {
  it("should validate a minimal delegation", () => {
    const delegation = createValidDelegation();
    const result = DelegationSchema.safeParse(delegation);
    expect(result.success).toBe(true);
  });

  it("should validate a full delegation", () => {
    const delegation = {
      ...createValidDelegation(),
      delegatorDID: "did:pkh:eip155:1:0x1234",
      createdAt: new Date(),
      parentCid: "bafyrei-parent",
      allowSubDelegation: true,
      authHeader: "Bearer token123",
    };
    const result = DelegationSchema.safeParse(delegation);
    expect(result.success).toBe(true);
  });

  it("should reject delegation without cid", () => {
    const { cid, ...delegation } = createValidDelegation();
    const result = DelegationSchema.safeParse(delegation);
    expect(result.success).toBe(false);
  });

  it("should reject delegation with invalid expiry", () => {
    const delegation = { ...createValidDelegation(), expiry: "not-a-date" };
    const result = DelegationSchema.safeParse(delegation);
    expect(result.success).toBe(false);
  });

  it("should reject delegation with invalid actions type", () => {
    const delegation = { ...createValidDelegation(), actions: "not-an-array" };
    const result = DelegationSchema.safeParse(delegation);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// CapabilityEntry Schema Tests
// =============================================================================

describe("CapabilityEntrySchema", () => {
  it("should validate a capability entry", () => {
    const entry = {
      resource: "tinycloud://space-123/kv/test",
      action: "tinycloud.kv/get",
      keys: [createValidKeyInfo()],
      delegation: createValidDelegation(),
    };
    const result = CapabilityEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it("should validate capability entry with expiresAt", () => {
    const entry = {
      resource: "tinycloud://space-123/kv/test",
      action: "tinycloud.kv/get",
      keys: [],
      delegation: createValidDelegation(),
      expiresAt: new Date("2025-12-31"),
    };
    const result = CapabilityEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// DelegationRecord Schema Tests
// =============================================================================

describe("DelegationRecordSchema", () => {
  it("should validate a delegation record", () => {
    const record = {
      cid: "bafyrei1234567890",
      spaceId: "space-123",
      delegator: "did:pkh:eip155:1:0x1234",
      delegatee: "did:key:z6MkTest",
      path: "/kv/test/*",
      actions: ["tinycloud.kv/get"],
      isRevoked: false,
      createdAt: new Date(),
    };
    const result = DelegationRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });

  it("should validate a full delegation record", () => {
    const record = {
      cid: "bafyrei1234567890",
      spaceId: "space-123",
      delegator: "did:pkh:eip155:1:0x1234",
      delegatee: "did:key:z6MkTest",
      keyId: "key-123",
      path: "/kv/test/*",
      actions: ["tinycloud.kv/get"],
      expiry: new Date("2025-12-31"),
      notBefore: new Date(),
      isRevoked: false,
      createdAt: new Date(),
      parentCid: "bafyrei-parent",
    };
    const result = DelegationRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// CreateDelegationParams Schema Tests
// =============================================================================

describe("CreateDelegationParamsSchema", () => {
  it("should validate minimal params", () => {
    const params = {
      delegateDID: "did:key:z6MkTest",
      path: "/kv/test",
      actions: ["tinycloud.kv/get"],
    };
    const result = CreateDelegationParamsSchema.safeParse(params);
    expect(result.success).toBe(true);
  });

  it("should validate full params", () => {
    const params = {
      delegateDID: "did:key:z6MkTest",
      path: "/kv/test",
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      expiry: new Date("2025-12-31"),
      disableSubDelegation: true,
      statement: "Grant access to test data",
    };
    const result = CreateDelegationParamsSchema.safeParse(params);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// DelegationChain Schema Tests
// =============================================================================

describe("DelegationChainSchema", () => {
  it("should validate an empty chain", () => {
    const result = DelegationChainSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it("should validate a chain with one delegation", () => {
    const chain = [createValidDelegation()];
    const result = DelegationChainSchema.safeParse(chain);
    expect(result.success).toBe(true);
  });

  it("should validate a chain with multiple delegations", () => {
    const chain = [createValidDelegation(), createValidDelegation()];
    const result = DelegationChainSchema.safeParse(chain);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// DelegationChainV2 Schema Tests
// =============================================================================

describe("DelegationChainV2Schema", () => {
  it("should validate a chain v2", () => {
    const chain = {
      root: createValidDelegation(),
      chain: [],
      leaf: createValidDelegation(),
    };
    const result = DelegationChainV2Schema.safeParse(chain);
    expect(result.success).toBe(true);
  });

  it("should validate a chain v2 with intermediates", () => {
    const chain = {
      root: createValidDelegation(),
      chain: [createValidDelegation(), createValidDelegation()],
      leaf: createValidDelegation(),
    };
    const result = DelegationChainV2Schema.safeParse(chain);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Direction and Filter Schema Tests
// =============================================================================

describe("DelegationDirectionSchema", () => {
  it("should validate 'granted'", () => {
    expect(DelegationDirectionSchema.safeParse("granted").success).toBe(true);
  });

  it("should validate 'received'", () => {
    expect(DelegationDirectionSchema.safeParse("received").success).toBe(true);
  });

  it("should validate 'all'", () => {
    expect(DelegationDirectionSchema.safeParse("all").success).toBe(true);
  });

  it("should reject invalid direction", () => {
    expect(DelegationDirectionSchema.safeParse("invalid").success).toBe(false);
  });
});

describe("DelegationFiltersSchema", () => {
  it("should validate empty filters", () => {
    const result = DelegationFiltersSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should validate full filters", () => {
    const filters = {
      direction: "received" as const,
      path: "/kv/shared/*",
      actions: ["tinycloud.kv/get"],
      includeRevoked: false,
      delegator: "did:pkh:eip155:1:0x1234",
      delegatee: "did:key:z6MkTest",
      validAt: new Date(),
      limit: 10,
      cursor: "cursor-123",
    };
    const result = DelegationFiltersSchema.safeParse(filters);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Space Schema Tests
// =============================================================================

describe("SpaceOwnershipSchema", () => {
  it("should validate 'owned'", () => {
    expect(SpaceOwnershipSchema.safeParse("owned").success).toBe(true);
  });

  it("should validate 'delegated'", () => {
    expect(SpaceOwnershipSchema.safeParse("delegated").success).toBe(true);
  });
});

describe("SpaceInfoSchema", () => {
  it("should validate minimal space info", () => {
    const spaceInfo = {
      id: "space-123",
      owner: "did:pkh:eip155:1:0x1234",
      type: "owned" as const,
    };
    const result = SpaceInfoSchema.safeParse(spaceInfo);
    expect(result.success).toBe(true);
  });

  it("should validate full space info", () => {
    const spaceInfo = {
      id: "space-123",
      name: "My Documents",
      owner: "did:pkh:eip155:1:0x1234",
      type: "delegated" as const,
      permissions: ["tinycloud.kv/*"],
      expiresAt: new Date("2025-12-31"),
    };
    const result = SpaceInfoSchema.safeParse(spaceInfo);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Share Link Schema Tests
// =============================================================================

describe("ShareSchemaSchema", () => {
  it("should validate 'base64'", () => {
    expect(ShareSchemaSchema.safeParse("base64").success).toBe(true);
  });

  it("should validate 'compact'", () => {
    expect(ShareSchemaSchema.safeParse("compact").success).toBe(true);
  });

  it("should validate 'ipfs'", () => {
    expect(ShareSchemaSchema.safeParse("ipfs").success).toBe(true);
  });
});

describe("ShareLinkSchema", () => {
  it("should validate a share link", () => {
    const shareLink = {
      token: "abc123",
      url: "https://app.example.com/share/abc123",
      delegation: createValidDelegation(),
      schema: "base64" as const,
    };
    const result = ShareLinkSchema.safeParse(shareLink);
    expect(result.success).toBe(true);
  });

  it("should validate a full share link", () => {
    const shareLink = {
      token: "abc123",
      url: "https://app.example.com/share/abc123",
      delegation: createValidDelegation(),
      schema: "base64" as const,
      expiresAt: new Date("2025-12-31"),
      description: "Q4 Financial Report",
    };
    const result = ShareLinkSchema.safeParse(shareLink);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Ingestion Schema Tests
// =============================================================================

describe("IngestOptionsSchema", () => {
  it("should validate empty options", () => {
    const result = IngestOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should validate full options", () => {
    const options = {
      persist: true,
      validateChain: true,
      keyName: "shared-key",
      createSessionKey: false,
      priority: 2,
    };
    const result = IngestOptionsSchema.safeParse(options);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// GenerateShareParams Schema Tests
// =============================================================================

describe("GenerateShareParamsSchema", () => {
  it("should validate minimal params", () => {
    const params = {
      path: "/kv/test",
    };
    const result = GenerateShareParamsSchema.safeParse(params);
    expect(result.success).toBe(true);
  });

  it("should validate full params", () => {
    const params = {
      path: "/kv/documents/report.pdf",
      actions: ["tinycloud.kv/get"],
      expiry: new Date("2025-12-31"),
      schema: "base64" as const,
      description: "Q4 Financial Report",
      baseUrl: "https://share.example.com",
    };
    const result = GenerateShareParamsSchema.safeParse(params);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// API Response Schema Tests
// =============================================================================

describe("DelegationApiResponseSchema", () => {
  it("should validate a response", () => {
    const response = {
      siwe: "localhost wants you to sign in...",
      signature: "0x1234...",
      version: 1,
    };
    const result = DelegationApiResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it("should validate a response with cid", () => {
    const response = {
      siwe: "localhost wants you to sign in...",
      signature: "0x1234...",
      version: 1,
      cid: "bafyrei1234567890",
    };
    const result = DelegationApiResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// WASM Types Schema Tests
// =============================================================================

describe("CreateDelegationWasmParamsSchema", () => {
  // Params schema was migrated to the multi-resource shape alongside
  // the Rust create_delegation WASM change: `path` + `actions` →
  // `abilities: Record<short service, Record<path, actionURNs[]>>`.
  // These tests cover the single-entry and multi-entry cases that
  // flow through the same validator.
  it("should validate single-entry abilities params", () => {
    const params = {
      session: { did: "did:key:z6MkTest", spaceId: "space-123" },
      delegateDID: "did:key:z6MkTarget",
      spaceId: "space-123",
      abilities: {
        kv: {
          "/kv/test": ["tinycloud.kv/get"],
        },
      },
      expirationSecs: 1735689600,
    };
    const result = CreateDelegationWasmParamsSchema.safeParse(params);
    expect(result.success).toBe(true);
  });

  it("should validate multi-service multi-path abilities params", () => {
    const params = {
      session: { did: "did:key:z6MkTest", spaceId: "space-123" },
      delegateDID: "did:key:z6MkTarget",
      spaceId: "space-123",
      abilities: {
        kv: {
          "com.listen.app/": ["tinycloud.kv/get", "tinycloud.kv/put"],
        },
        sql: {
          "com.listen.app/data.sqlite": ["tinycloud.sql/read"],
        },
      },
      expirationSecs: 1735689600,
      notBeforeSecs: 1704067200,
    };
    const result = CreateDelegationWasmParamsSchema.safeParse(params);
    expect(result.success).toBe(true);
  });
});

describe("CreateDelegationWasmResultSchema", () => {
  // Result schema now carries a `resources` array instead of flat
  // path/actions fields. For single-entry calls `resources` has
  // exactly one entry; for multi-entry it has one per
  // (service, path) tuple in (service, path) lexicographic order.
  it("should validate a single-resource result", () => {
    const result = {
      delegation: "eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSJ9...",
      cid: "bafyrei1234567890",
      delegateDID: "did:key:z6MkTarget",
      expiry: new Date("2025-12-31"),
      resources: [
        {
          service: "kv",
          space: "tinycloud:pkh:eip155:1:0xabc:default",
          path: "/kv/test",
          actions: ["tinycloud.kv/get"],
        },
      ],
    };
    const parseResult = CreateDelegationWasmResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
  });

  it("should validate a multi-resource result", () => {
    const result = {
      delegation: "eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSJ9...",
      cid: "bafyrei1234567890",
      delegateDID: "did:key:z6MkTarget",
      expiry: new Date("2025-12-31"),
      resources: [
        {
          service: "kv",
          space: "tinycloud:pkh:eip155:1:0xabc:default",
          path: "com.listen.app/",
          actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
        },
        {
          service: "sql",
          space: "tinycloud:pkh:eip155:1:0xabc:default",
          path: "com.listen.app/data.sqlite",
          actions: ["tinycloud.sql/read"],
        },
      ],
    };
    const parseResult = CreateDelegationWasmResultSchema.safeParse(result);
    expect(parseResult.success).toBe(true);
  });
});

// =============================================================================
// Validation Helper Tests
// =============================================================================

describe("validateDelegation", () => {
  it("should return ok result for valid delegation", () => {
    const delegation = createValidDelegation();
    const result = validateDelegation(delegation);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cid).toBe(delegation.cid);
    }
  });

  it("should return error result for invalid delegation", () => {
    const delegation = { cid: "test" }; // Missing required fields
    const result = validateDelegation(delegation);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(DelegationErrorCodes.VALIDATION_ERROR);
      expect(result.error.service).toBe("delegation");
      expect(result.error.meta?.issues).toBeDefined();
    }
  });
});

describe("validateCreateDelegationParams", () => {
  it("should return ok result for valid params", () => {
    const params = {
      delegateDID: "did:key:z6MkTest",
      path: "/kv/test",
      actions: ["tinycloud.kv/get"],
    };
    const result = validateCreateDelegationParams(params);
    expect(result.ok).toBe(true);
  });

  it("should return error result for invalid params", () => {
    const params = { path: "/kv/test" }; // Missing delegateDID and actions
    const result = validateCreateDelegationParams(params);
    expect(result.ok).toBe(false);
  });
});

describe("validateDelegationFilters", () => {
  it("should return ok result for valid filters", () => {
    const filters = { direction: "received" as const };
    const result = validateDelegationFilters(filters);
    expect(result.ok).toBe(true);
  });

  it("should return error result for invalid direction", () => {
    const filters = { direction: "invalid" };
    const result = validateDelegationFilters(filters);
    expect(result.ok).toBe(false);
  });
});

describe("validateShareLink", () => {
  it("should return ok result for valid share link", () => {
    const shareLink = {
      token: "abc123",
      url: "https://app.example.com/share/abc123",
      delegation: createValidDelegation(),
      schema: "base64" as const,
    };
    const result = validateShareLink(shareLink);
    expect(result.ok).toBe(true);
  });

  it("should return error result for invalid share link", () => {
    const shareLink = { token: "abc123" }; // Missing required fields
    const result = validateShareLink(shareLink);
    expect(result.ok).toBe(false);
  });
});

describe("createValidator", () => {
  it("should create a working validator", () => {
    const validateKeyType = createValidator(KeyTypeSchema);

    const validResult = validateKeyType("session");
    expect(validResult.ok).toBe(true);

    const invalidResult = validateKeyType("invalid");
    expect(invalidResult.ok).toBe(false);
  });
});
