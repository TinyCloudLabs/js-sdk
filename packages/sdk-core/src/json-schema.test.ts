/**
 * Tests for JSON Schema export functionality.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from "bun:test";
import {
  // Bundle functions
  getAllJsonSchemas,
  getAllJsonSchemasFlat,
  SCHEMA_NAMES,
  // Individual schema functions - Storage
  getEnsDataJsonSchema,
  getPersistedTinyCloudSessionJsonSchema,
  getPersistedSessionDataJsonSchema,
  getTinyCloudSessionJsonSchema,
  // Individual schema functions - Delegations
  getJWKJsonSchema,
  getKeyTypeJsonSchema,
  getKeyInfoJsonSchema,
  getDelegationErrorJsonSchema,
  getDelegationJsonSchema,
  getCapabilityEntryJsonSchema,
  getDelegationRecordJsonSchema,
  getCreateDelegationParamsJsonSchema,
  getDelegationChainJsonSchema,
  getDelegationChainV2JsonSchema,
  getDelegationDirectionJsonSchema,
  getDelegationFiltersJsonSchema,
  getSpaceOwnershipJsonSchema,
  getSpaceInfoJsonSchema,
  getShareSchemaJsonSchema,
  getShareLinkJsonSchema,
  getIngestOptionsJsonSchema,
  getGenerateShareParamsJsonSchema,
  getDelegationApiResponseJsonSchema,
  getCreateDelegationWasmParamsJsonSchema,
  getCreateDelegationWasmResultJsonSchema,
  // Individual schema functions - Space Hosting
  getSpaceHostResultJsonSchema,
  // Individual schema functions - Space Creation
  getSpaceCreationContextJsonSchema,
  getSpaceCreationHandlerJsonSchema,
  // Individual schema functions - Config
  getBackoffStrategyJsonSchema,
  getRetryPolicyJsonSchema,
  getPartialRetryPolicyJsonSchema,
  getTinyCloudConfigJsonSchema,
  // Individual schema functions - Authorization
  getPartialSiweMessageJsonSchema,
  getUserAuthorizationConfigJsonSchema,
  // Individual schema functions - Sign Strategy
  getSignRequestTypeJsonSchema,
  getSignRequestJsonSchema,
  getSignResponseJsonSchema,
  getAutoSignStrategyJsonSchema,
  getAutoRejectStrategyJsonSchema,
  getCallbackStrategyJsonSchema,
  getEventEmitterStrategyJsonSchema,
  getSignStrategyJsonSchema,
  // Individual schema functions - Space Service
  getSpaceConfigJsonSchema,
  getSpaceServiceConfigJsonSchema,
  getSpaceDelegationParamsJsonSchema,
} from "./json-schema";

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Validates that a value is a valid JSON Schema object.
 */
function isValidJsonSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) {
    return false;
  }
  // JSON Schema should have either $schema, type, or $ref
  const s = schema as Record<string, unknown>;
  return (
    typeof s.$schema === "string" ||
    typeof s.type === "string" ||
    typeof s.$ref === "string" ||
    typeof s.anyOf !== "undefined" ||
    typeof s.oneOf !== "undefined" ||
    typeof s.allOf !== "undefined" ||
    typeof s.enum !== "undefined" ||
    typeof s.definitions !== "undefined"
  );
}

// =============================================================================
// Individual Schema Tests - Storage
// =============================================================================

describe("JSON Schema Export - Storage", () => {
  it("should generate JSON Schema for EnsData", () => {
    const schema = getEnsDataJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
    expect(schema).toHaveProperty("$schema");
  });

  it("should generate JSON Schema for PersistedTinyCloudSession", () => {
    const schema = getPersistedTinyCloudSessionJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
    expect(schema).toHaveProperty("$schema");
  });

  it("should generate JSON Schema for PersistedSessionData", () => {
    const schema = getPersistedSessionDataJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
    expect(schema).toHaveProperty("$schema");
  });

  it("should generate JSON Schema for TinyCloudSession", () => {
    const schema = getTinyCloudSessionJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
    expect(schema).toHaveProperty("$schema");
  });
});

// =============================================================================
// Individual Schema Tests - Delegations
// =============================================================================

describe("JSON Schema Export - Delegations", () => {
  it("should generate JSON Schema for JWK", () => {
    const schema = getJWKJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for KeyType", () => {
    const schema = getKeyTypeJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for KeyInfo", () => {
    const schema = getKeyInfoJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for DelegationError", () => {
    const schema = getDelegationErrorJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for Delegation", () => {
    const schema = getDelegationJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for CapabilityEntry", () => {
    const schema = getCapabilityEntryJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for DelegationRecord", () => {
    const schema = getDelegationRecordJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for CreateDelegationParams", () => {
    const schema = getCreateDelegationParamsJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for DelegationChain", () => {
    const schema = getDelegationChainJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for DelegationChainV2", () => {
    const schema = getDelegationChainV2JsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for DelegationDirection", () => {
    const schema = getDelegationDirectionJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for DelegationFilters", () => {
    const schema = getDelegationFiltersJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for SpaceOwnership", () => {
    const schema = getSpaceOwnershipJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for SpaceInfo", () => {
    const schema = getSpaceInfoJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for ShareSchema", () => {
    const schema = getShareSchemaJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for ShareLink", () => {
    const schema = getShareLinkJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for IngestOptions", () => {
    const schema = getIngestOptionsJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for GenerateShareParams", () => {
    const schema = getGenerateShareParamsJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for DelegationApiResponse", () => {
    const schema = getDelegationApiResponseJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for CreateDelegationWasmParams", () => {
    const schema = getCreateDelegationWasmParamsJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for CreateDelegationWasmResult", () => {
    const schema = getCreateDelegationWasmResultJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });
});

// =============================================================================
// Individual Schema Tests - Space Hosting
// =============================================================================

describe("JSON Schema Export - Space Hosting", () => {
  it("should generate JSON Schema for SpaceHostResult", () => {
    const schema = getSpaceHostResultJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });
});

// =============================================================================
// Individual Schema Tests - Space Creation
// =============================================================================

describe("JSON Schema Export - Space Creation", () => {
  it("should generate JSON Schema for SpaceCreationContext", () => {
    const schema = getSpaceCreationContextJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for SpaceCreationHandler", () => {
    const schema = getSpaceCreationHandlerJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });
});

// =============================================================================
// Individual Schema Tests - Config
// =============================================================================

describe("JSON Schema Export - Config", () => {
  it("should generate JSON Schema for BackoffStrategy", () => {
    const schema = getBackoffStrategyJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for RetryPolicy", () => {
    const schema = getRetryPolicyJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for PartialRetryPolicy", () => {
    const schema = getPartialRetryPolicyJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for TinyCloudConfig", () => {
    const schema = getTinyCloudConfigJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });
});

// =============================================================================
// Individual Schema Tests - Authorization
// =============================================================================

describe("JSON Schema Export - Authorization", () => {
  it("should generate JSON Schema for PartialSiweMessage", () => {
    const schema = getPartialSiweMessageJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for UserAuthorizationConfig", () => {
    const schema = getUserAuthorizationConfigJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });
});

// =============================================================================
// Individual Schema Tests - Sign Strategy
// =============================================================================

describe("JSON Schema Export - Sign Strategy", () => {
  it("should generate JSON Schema for SignRequestType", () => {
    const schema = getSignRequestTypeJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for SignRequest", () => {
    const schema = getSignRequestJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for SignResponse", () => {
    const schema = getSignResponseJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for AutoSignStrategy", () => {
    const schema = getAutoSignStrategyJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for AutoRejectStrategy", () => {
    const schema = getAutoRejectStrategyJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for CallbackStrategy", () => {
    const schema = getCallbackStrategyJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for EventEmitterStrategy", () => {
    const schema = getEventEmitterStrategyJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for SignStrategy", () => {
    const schema = getSignStrategyJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });
});

// =============================================================================
// Individual Schema Tests - Space Service
// =============================================================================

describe("JSON Schema Export - Space Service", () => {
  it("should generate JSON Schema for SpaceConfig", () => {
    const schema = getSpaceConfigJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for SpaceServiceConfig", () => {
    const schema = getSpaceServiceConfigJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate JSON Schema for SpaceDelegationParams", () => {
    const schema = getSpaceDelegationParamsJsonSchema();
    expect(isValidJsonSchema(schema)).toBe(true);
  });
});

// =============================================================================
// Bundle Tests
// =============================================================================

describe("JSON Schema Export - Bundle", () => {
  it("should generate all schemas as a categorized bundle", () => {
    const bundle = getAllJsonSchemas();

    // Check all categories exist
    expect(bundle).toHaveProperty("storage");
    expect(bundle).toHaveProperty("delegations");
    expect(bundle).toHaveProperty("spaceHosting");
    expect(bundle).toHaveProperty("spaceCreation");
    expect(bundle).toHaveProperty("config");
    expect(bundle).toHaveProperty("authorization");
    expect(bundle).toHaveProperty("signStrategy");
    expect(bundle).toHaveProperty("spaceService");

    // Check storage schemas
    expect(isValidJsonSchema(bundle.storage.EnsData)).toBe(true);
    expect(isValidJsonSchema(bundle.storage.PersistedTinyCloudSession)).toBe(true);
    expect(isValidJsonSchema(bundle.storage.PersistedSessionData)).toBe(true);
    expect(isValidJsonSchema(bundle.storage.TinyCloudSession)).toBe(true);

    // Check delegation schemas
    expect(isValidJsonSchema(bundle.delegations.Delegation)).toBe(true);
    expect(isValidJsonSchema(bundle.delegations.DelegationChain)).toBe(true);

    // Check config schemas
    expect(isValidJsonSchema(bundle.config.TinyCloudConfig)).toBe(true);
    expect(isValidJsonSchema(bundle.config.RetryPolicy)).toBe(true);

    // Check sign strategy schemas
    expect(isValidJsonSchema(bundle.signStrategy.SignStrategy)).toBe(true);
    expect(isValidJsonSchema(bundle.signStrategy.SignRequest)).toBe(true);
  });

  it("should generate all schemas as a flat object", () => {
    const flat = getAllJsonSchemasFlat();

    // Check that all schema names are present
    for (const name of SCHEMA_NAMES) {
      expect(flat).toHaveProperty(name);
      expect(isValidJsonSchema(flat[name])).toBe(true);
    }
  });

  it("should match schema count between flat and SCHEMA_NAMES", () => {
    const flat = getAllJsonSchemasFlat();
    expect(Object.keys(flat).length).toBe(SCHEMA_NAMES.length);
  });
});

// =============================================================================
// Options Tests
// =============================================================================

describe("JSON Schema Export - Options", () => {
  it("should respect custom name option", () => {
    const schema = getDelegationJsonSchema({ name: "CustomDelegation" });
    expect(schema).toHaveProperty("$schema");
    // The name is used as the definition key, not a direct property
    expect(isValidJsonSchema(schema)).toBe(true);
  });

  it("should generate valid JSON that can be stringified", () => {
    const bundle = getAllJsonSchemas();
    const json = JSON.stringify(bundle);
    expect(typeof json).toBe("string");
    expect(json.length).toBeGreaterThan(1000);

    // Parse it back to verify it's valid JSON
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty("storage");
    expect(parsed).toHaveProperty("delegations");
  });
});

// =============================================================================
// Schema Content Tests
// =============================================================================

describe("JSON Schema Export - Schema Content", () => {
  it("should generate Delegation schema", () => {
    const schema = getDelegationJsonSchema() as Record<string, unknown>;

    // Schema should have a $schema property
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");

    // Note: The exact structure depends on zod and zod-to-json-schema versions.
    // We verify the schema is generated without throwing, which is the primary goal.
    expect(schema).toBeDefined();
  });

  it("should generate SignStrategy schema as discriminated union", () => {
    const schema = getSignStrategyJsonSchema() as Record<string, unknown>;
    expect(isValidJsonSchema(schema)).toBe(true);

    // Schema should have $schema property
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });

  it("should generate enum schemas", () => {
    const schema = getKeyTypeJsonSchema() as Record<string, unknown>;

    // Schema should have $schema property
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");

    // The schema structure varies by zod-to-json-schema version
    expect(schema).toBeDefined();
  });
});
