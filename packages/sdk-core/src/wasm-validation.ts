/**
 * Debug-only WASM output validation utilities.
 *
 * These utilities provide runtime validation for WASM function outputs
 * in development builds only. In production, validation is skipped for
 * performance since the Rust WASM layer already performs its own validation.
 *
 * @packageDocumentation
 */

import { z } from "zod";
import { CreateDelegationWasmResultSchema } from "./delegations/types.schema.js";

/**
 * Check if we're running in a production environment.
 * Checks both Node.js and browser bundler conventions.
 */
function isProduction(): boolean {
  // Node.js environment
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") {
    return true;
  }
  // Browser bundler convention (Vite, webpack, etc.)
  // @ts-ignore - import.meta.env may not exist in all environments
  if (typeof import.meta !== "undefined" && import.meta.env?.PROD === true) {
    return true;
  }
  return false;
}

/**
 * Validation result returned by debug validators.
 */
export interface WasmValidationResult<T> {
  /** The data (original or validated) */
  data: T;
  /** Whether validation was performed */
  validated: boolean;
  /** Validation issues if any (only populated in non-production) */
  issues?: z.ZodIssue[];
}

/**
 * Validates WASM function output against a Zod schema.
 * Only validates in non-production environments for performance.
 *
 * In development:
 * - Validates the output against the schema
 * - Logs a warning if validation fails
 * - Returns the original data (never throws)
 *
 * In production:
 * - Skips validation entirely
 * - Returns the data as-is
 *
 * @param schema - The Zod schema to validate against
 * @param data - The WASM function output to validate
 * @param fnName - Name of the WASM function (for logging)
 * @returns The original data with validation metadata
 *
 * @example
 * ```typescript
 * import { validateWasmOutput, CreateDelegationWasmResultSchema } from "@tinycloud/sdk-core";
 *
 * const rawResult = wasmCreateDelegation(...args);
 * const result = validateWasmOutput(
 *   CreateDelegationWasmResultSchema,
 *   rawResult,
 *   "createDelegation"
 * );
 * // In dev: logs warning if validation fails
 * // In prod: returns immediately without validation
 * ```
 */
export function validateWasmOutput<T>(
  schema: z.ZodType<T>,
  data: unknown,
  fnName: string
): WasmValidationResult<T> {
  // Skip validation in production for performance
  if (isProduction()) {
    return {
      data: data as T,
      validated: false,
    };
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    console.warn(
      `[WASM Debug] ${fnName} output validation failed:`,
      result.error.issues,
      "\nReceived data:",
      data
    );
    return {
      data: data as T,
      validated: true,
      issues: result.error.issues,
    };
  }

  return {
    data: result.data,
    validated: true,
  };
}

/**
 * Schema for validating createDelegation WASM output.
 *
 * This is a relaxed version of {@link CreateDelegationWasmResultSchema}
 * that accepts the raw WASM output format: `expiry` may come back as a
 * number (seconds since epoch, the Rust-native form) or a string before
 * transformation to Date, and `delegateDID` may be emitted under the
 * camelCase field name the WASM produces (`delegateDid`).
 *
 * The multi-resource `resources` array matches the strict schema: the
 * Rust layer always emits it sorted by `(service, path)`.
 */
export const CreateDelegationWasmRawResultSchema = z.object({
  /** Base64url-encoded UCAN delegation */
  delegation: z.string(),
  /** CID of the delegation */
  cid: z.string(),
  /** DID of the delegate */
  delegateDID: z.string(),
  /** Expiration time (may be number, string, or Date from WASM) */
  expiry: z.union([z.number(), z.string(), z.date()]),
  /**
   * Resources granted by this delegation. Each entry carries its own
   * `(service, space, path, actions)` tuple. Always non-empty on
   * success.
   */
  resources: z.array(
    z.object({
      service: z.string(),
      space: z.string(),
      path: z.string(),
      actions: z.array(z.string()),
    })
  ),
});

export type CreateDelegationWasmRawResult = z.infer<
  typeof CreateDelegationWasmRawResultSchema
>;

/**
 * Validates the output of the createDelegation WASM function.
 *
 * Uses the raw result schema which accepts expiry as number/string/Date
 * to handle the raw WASM output before any TypeScript transformation.
 *
 * @param data - The raw output from WASM createDelegation
 * @returns Validation result with the data
 *
 * @example
 * ```typescript
 * import { validateCreateDelegationWasmOutput } from "@tinycloud/sdk-core";
 *
 * const rawResult = wasmCreateDelegation(session, delegateDID, ...);
 * const { data, issues } = validateCreateDelegationWasmOutput(rawResult);
 * if (issues) {
 *   // Handle validation issues in development
 * }
 * ```
 */
export function validateCreateDelegationWasmOutput(
  data: unknown
): WasmValidationResult<CreateDelegationWasmRawResult> {
  return validateWasmOutput(
    CreateDelegationWasmRawResultSchema,
    data,
    "createDelegation"
  );
}

/**
 * Schema for validating invoke WASM output.
 *
 * The invoke function returns an object with headers and body properties.
 */
export const InvokeWasmResultSchema = z.object({
  /** HTTP headers from the invocation response */
  headers: z.record(z.string(), z.string()),
  /** Request body to send */
  body: z.string(),
});

export type InvokeWasmResult = z.infer<typeof InvokeWasmResultSchema>;

/**
 * Validates the output of the invoke WASM function.
 *
 * @param data - The raw output from WASM invoke
 * @returns Validation result with the data
 */
export function validateInvokeWasmOutput(
  data: unknown
): WasmValidationResult<InvokeWasmResult> {
  return validateWasmOutput(InvokeWasmResultSchema, data, "invoke");
}

/**
 * Schema for validating prepareSession WASM output.
 */
export const PrepareSessionWasmResultSchema = z.object({
  /** SIWE message to sign */
  siweMessage: z.string(),
  /** JWK for the session key */
  jwk: z.object({
    kty: z.string(),
    crv: z.string().optional(),
    x: z.string().optional(),
    d: z.string().optional(),
  }).passthrough(),
  /** Verification method */
  verificationMethod: z.string(),
});

export type PrepareSessionWasmResult = z.infer<typeof PrepareSessionWasmResultSchema>;

/**
 * Validates the output of the prepareSession WASM function.
 *
 * @param data - The raw output from WASM prepareSession
 * @returns Validation result with the data
 */
export function validatePrepareSessionWasmOutput(
  data: unknown
): WasmValidationResult<PrepareSessionWasmResult> {
  return validateWasmOutput(PrepareSessionWasmResultSchema, data, "prepareSession");
}

/**
 * Schema for validating completeSessionSetup WASM output (Session type).
 */
export const SessionWasmResultSchema = z.object({
  /** Delegation header for authentication */
  delegationHeader: z.object({
    Authorization: z.string(),
  }),
  /** CID of the delegation */
  delegationCid: z.string(),
  /** JWK for the session key */
  jwk: z.object({
    kty: z.string(),
    crv: z.string().optional(),
    x: z.string().optional(),
    d: z.string().optional(),
  }).passthrough(),
  /** Space ID */
  spaceId: z.string(),
  /** Additional spaces included in session capabilities */
  additionalSpaces: z.record(z.string(), z.string()).optional(),
  /** Verification method */
  verificationMethod: z.string(),
});

export type SessionWasmResult = z.infer<typeof SessionWasmResultSchema>;

/**
 * Validates the output of the completeSessionSetup WASM function.
 *
 * @param data - The raw output from WASM completeSessionSetup
 * @returns Validation result with the data
 */
export function validateCompleteSessionSetupWasmOutput(
  data: unknown
): WasmValidationResult<SessionWasmResult> {
  return validateWasmOutput(SessionWasmResultSchema, data, "completeSessionSetup");
}

/**
 * Schema for validating siweToDelegationHeaders WASM output.
 */
export const SiweToDelegationHeadersWasmResultSchema = z.object({
  /** Authorization header for the delegation */
  Authorization: z.string(),
});

export type SiweToDelegationHeadersWasmResult = z.infer<
  typeof SiweToDelegationHeadersWasmResultSchema
>;

/**
 * Validates the output of the siweToDelegationHeaders WASM function.
 *
 * @param data - The raw output from WASM siweToDelegationHeaders
 * @returns Validation result with the data
 */
export function validateSiweToDelegationHeadersWasmOutput(
  data: unknown
): WasmValidationResult<SiweToDelegationHeadersWasmResult> {
  return validateWasmOutput(
    SiweToDelegationHeadersWasmResultSchema,
    data,
    "siweToDelegationHeaders"
  );
}

// Re-export the strict schema for consumers who need it
export { CreateDelegationWasmResultSchema } from "./delegations/types.schema.js";
