import { zodToJsonSchema } from "zod-to-json-schema";

import { PermissionEntrySchema, PermissionRequestArtifactSchema } from "./artifacts.js";
import { OPERATION_ERROR_CODES } from "./errors.js";

type JsonSchema = Record<string, unknown>;

const contextSchema: JsonSchema = {
  type: "object",
  properties: {
    profile: { type: "string", minLength: 1 },
    host: { type: "string", minLength: 1 },
    posture: {
      type: "string",
      enum: ["owner-openkey", "delegate-session", "local-owner-key", "unauthenticated"],
    },
    operatorType: { type: "string", enum: ["human", "agent"] },
    principalDid: { type: "string", minLength: 1 },
    sessionDid: { type: "string", minLength: 1 },
    ownerDid: { type: "string", minLength: 1 },
    space: { type: "string", minLength: 1 },
  },
  required: ["profile", "host", "posture"],
  additionalProperties: false,
};

const retrySchema: JsonSchema = {
  type: "object",
  properties: {
    operationId: { type: "string", minLength: 1 },
    operationVersion: { type: "integer", const: 1 },
    inputDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    safeInput: { type: "object", additionalProperties: true },
    requiresCallerInput: { type: "boolean" },
  },
  required: ["operationId", "operationVersion", "inputDigest", "requiresCallerInput"],
  additionalProperties: false,
};

const setupSchema: JsonSchema = {
  type: "object",
  properties: {
    kind: { const: "secret_manager" },
    secret: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        scope: { type: "string", minLength: 1 },
        space: { type: "string", minLength: 1 },
      },
      required: ["name", "space"],
      additionalProperties: false,
    },
    url: { type: "string", format: "uri" },
    message: { type: "string", minLength: 1 },
  },
  required: ["kind", "secret", "url", "message"],
  additionalProperties: false,
};

const errorSchema: JsonSchema = {
  type: "object",
  properties: {
    code: { type: "string", enum: [...OPERATION_ERROR_CODES] },
    message: { type: "string", minLength: 1 },
    retryable: { type: "boolean" },
    details: { type: "object", additionalProperties: true },
  },
  required: ["code", "message", "retryable"],
  additionalProperties: false,
};

const permissionEntrySchema = zodToJsonSchema(PermissionEntrySchema, {
  target: "jsonSchema7",
}) as JsonSchema;
const permissionRequestSchema = zodToJsonSchema(PermissionRequestArtifactSchema, {
  target: "jsonSchema7",
}) as JsonSchema;

function prefixLocalReferences(value: unknown, prefix: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => prefixLocalReferences(entry, prefix));
  if (value === null || typeof value !== "object") return value;

  const result: JsonSchema = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = key === "$ref" && typeof entry === "string" && entry.startsWith("#")
      ? `${prefix}${entry.slice(1)}`
      : prefixLocalReferences(entry, prefix);
  }
  return result;
}

/**
 * Build the schema for the result returned in MCP structuredContent. The
 * operation's output schema is supplied by the operation registry; the
 * envelope and artifact schemas remain owned by operations as well.
 */
export function canonicalResultJsonSchema(
  operationId: string,
  operationVersion: number,
  output: JsonSchema,
): JsonSchema {
  const permissionRequestArtifactDefinition = prefixLocalReferences(
    permissionRequestSchema,
    "#/$defs/permissionRequest",
  ) as JsonSchema;
  const permissionRequestDefinition: JsonSchema = permissionRequestArtifactDefinition;
  const outputDefinition = prefixLocalReferences(output, "#/$defs/output") as JsonSchema;
  const operationRef: JsonSchema = {
    type: "object",
    properties: {
      operationId: { type: "string", const: operationId },
      operationVersion: { type: "integer", const: operationVersion },
    },
    required: ["operationId", "operationVersion"],
    additionalProperties: false,
  };

  const base = {
    operation: operationRef,
    context: contextSchema,
  };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    anyOf: [
      {
        type: "object",
        properties: {
          status: { const: "ok" },
          ...base,
          output: { $ref: "#/$defs/output" },
        },
        required: ["status", "operation", "context", "output"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: { const: "authority_required" },
          ...base,
          missing: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/permissionEntry" },
          },
          request: { $ref: "#/$defs/permissionRequest" },
          approval: {
            type: "object",
            properties: {
              kind: { const: "openkey" },
              requestId: { type: "string", minLength: 1 },
              url: { type: "string", format: "uri" },
              fallback: { type: "string", minLength: 1 },
            },
            required: ["kind", "requestId", "fallback"],
            additionalProperties: false,
          },
          retry: retrySchema,
        },
        required: ["status", "operation", "context", "missing", "request", "approval", "retry"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          status: { const: "setup_required" },
          ...base,
          setup: setupSchema,
          retry: retrySchema,
        },
        required: ["status", "operation", "context", "setup", "retry"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { status: { const: "error" }, ...base, error: errorSchema },
        required: ["status", "operation", "context", "error"],
        additionalProperties: false,
      },
    ],
    $defs: {
      permissionEntry: permissionEntrySchema,
      permissionRequest: permissionRequestDefinition,
      output: outputDefinition,
    },
  };
}
