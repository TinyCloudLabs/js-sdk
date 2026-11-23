/**
 * Tests for JSON Schema export functionality.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from "bun:test";
import {
  getAllJsonSchemas,
  getAllJsonSchemasFlat,
  getSignStrategyJsonSchema,
  SCHEMA_NAMES,
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
// Schema Content Tests
// =============================================================================

describe("JSON Schema Export - Schema Content", () => {
  it("should generate SignStrategy schema as discriminated union", () => {
    const schema = getSignStrategyJsonSchema() as Record<string, unknown>;
    expect(isValidJsonSchema(schema)).toBe(true);

    // Schema should have $schema property
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
  });
});
