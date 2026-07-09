import {
  POLICY_ENGINE_RECORD_SCHEMA,
  POLICY_SCHEMA,
  createAndSignPolicy,
  createAndSignPolicyEngineRecord,
  validatePolicyEngineRecordSignedShape,
  verifyPolicyEngineRecord,
  type Policy,
  type PolicyEngineRecord,
  type SignedObjectSigner,
  type UnsignedPolicyEngineRecord,
} from "./signed-object";
import {
  PolicyCapabilityError,
  normalizePolicyCapability,
  type JsonObject,
  type PolicyCapability,
} from "./capability";
import { normalizeJson, type JsonValue } from "./jcs";
import { SignedObjectProfileError, SignedObjectSchemaError } from "./errors";

export const TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA =
  "xyz.tinycloud.exchange/transcript-bootstrap/v0" as const;
export const POLICY_VERSION_V0 = "v0" as const;
export const W3C_VC_CREDENTIAL_VERIFIER = "w3c.vc/credential/v1" as const;

export type PolicyAuthoringErrorCode =
  | PolicyCapabilityError["code"]
  | "policy-authoring-malformed"
  | "policy-authoring-unknown-key"
  | "policy-engine-record-absent"
  | "policy-engine-record-date-invalid"
  | "policy-engine-record-signature-invalid"
  | "policy-engine-record-audience-mismatch"
  | "policy-engine-record-expired"
  | "policy-engine-record-owner-mismatch"
  | "policy-engine-record-grant-issuer-mismatch"
  | "policy-engine-record-policy-version-unsupported"
  | "policy-engine-record-evidence-verifier-unsupported"
  | "transcript-share-bootstrap-malformed";

export class PolicyAuthoringError extends Error {
  public readonly code: PolicyAuthoringErrorCode;

  constructor(code: PolicyAuthoringErrorCode, message: string) {
    super(message);
    this.name = "PolicyAuthoringError";
    this.code = code;
  }
}

export interface CreateTranscriptSharePolicyInput {
  readonly ownerDid: string;
  readonly signingKeyDid: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly permissionsCeiling: readonly unknown[];
  readonly when: JsonObject;
  readonly grant: JsonObject;
  readonly disclosure?: JsonObject;
  readonly audit?: JsonObject;
}

export interface TranscriptShareBootstrap {
  readonly schema: typeof TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA;
  readonly policyId: string;
  readonly policyEngine: {
    readonly endpoint: string;
    readonly audience: string;
    readonly supportedEvidenceVerifiers: readonly [typeof W3C_VC_CREDENTIAL_VERIFIER];
    readonly signedRecord: PolicyEngineRecord;
  };
  readonly resourceHint: JsonObject;
}

export interface ComposeTranscriptShareBootstrapInput {
  readonly policyId: string;
  readonly policyEngineRecord: PolicyEngineRecord;
  readonly resourceHint: JsonObject;
}

export interface CreatePolicyEngineRecordInput {
  readonly ownerDid: string;
  readonly endpoint: string;
  readonly audience: string;
  readonly grantIssuerDid: string;
  readonly expiresAt: string;
  readonly supportedPolicyVersions?: readonly string[];
  readonly supportedEvidenceVerifiers?: readonly string[];
}

export interface VerifyPolicyEngineRecordOptions {
  readonly signedRecord: unknown;
  readonly ownerDid: string;
  readonly audience: string;
  readonly grantIssuerDid: string;
  readonly now: string;
  readonly requiredPolicyVersion?: string;
  readonly requiredEvidenceVerifier?: string;
}

/**
 * Author a transcript-sharing Policy from already-resolved Listen-adapter
 * PolicyCapability JSON. Manifest PermissionEntry shapes are refused here; the
 * SDK does not expand or invent permissions while signing authority-bearing
 * objects.
 */
export async function createAndSignTranscriptSharePolicy(
  input: CreateTranscriptSharePolicyInput,
  signer: SignedObjectSigner,
): Promise<Policy> {
  const normalized = expectObject(input, "$", "policy-authoring-malformed");
  assertExactKeys(
    normalized,
    [
      "ownerDid",
      "signingKeyDid",
      "createdAt",
      "expiresAt",
      "resourceType",
      "resourceId",
      "permissionsCeiling",
      "when",
      "grant",
      "disclosure",
      "audit",
    ],
    "$",
  );
  const permissions = requiredArray(normalized, "permissionsCeiling", "$");
  if (permissions.length === 0) {
    throw new PolicyAuthoringError(
      "policy-authoring-malformed",
      "$.permissionsCeiling must not be empty",
    );
  }
  const ceiling: PolicyCapability[] = [];
  for (let index = 0; index < permissions.length; index++) {
    ceiling.push(wrapCapabilityError(() => normalizePolicyCapability(permissions[index])));
  }
  return createAndSignPolicy(
    {
      schema: POLICY_SCHEMA,
      ownerDid: requiredString(normalized, "ownerDid", "$"),
      signingKeyDid: requiredString(normalized, "signingKeyDid", "$"),
      createdAt: requiredString(normalized, "createdAt", "$"),
      ...(hasOwn(normalized, "expiresAt")
        ? { expiresAt: requiredString(normalized, "expiresAt", "$") }
        : {}),
      resource: {
        resourceType: requiredString(normalized, "resourceType", "$"),
        resourceId: requiredString(normalized, "resourceId", "$"),
        permissionsCeiling: ceiling,
      },
      when: requiredObject(normalized, "when", "$"),
      grant: requiredObject(normalized, "grant", "$"),
      ...(hasOwn(normalized, "disclosure")
        ? { disclosure: requiredObject(normalized, "disclosure", "$") }
        : {}),
      ...(hasOwn(normalized, "audit") ? { audit: requiredObject(normalized, "audit", "$") } : {}),
    },
    signer,
  ).catch((error) => {
    throw wrapSignedObjectError(error);
  });
}

export function createUnsignedPolicyEngineRecord(
  input: CreatePolicyEngineRecordInput,
): UnsignedPolicyEngineRecord {
  const normalized = expectObject(input, "$", "policy-authoring-malformed");
  assertExactKeys(
    normalized,
    [
      "ownerDid",
      "endpoint",
      "audience",
      "grantIssuerDid",
      "expiresAt",
      "supportedPolicyVersions",
      "supportedEvidenceVerifiers",
    ],
    "$",
  );
  const supportedPolicyVersions = hasOwn(normalized, "supportedPolicyVersions")
    ? requiredStringArray(normalized, "supportedPolicyVersions", "$")
    : [POLICY_VERSION_V0];
  validateSupportedPolicyVersions(supportedPolicyVersions, "$.supportedPolicyVersions");
  const supportedEvidenceVerifiers = hasOwn(normalized, "supportedEvidenceVerifiers")
    ? requiredStringArray(normalized, "supportedEvidenceVerifiers", "$")
    : [W3C_VC_CREDENTIAL_VERIFIER];
  validateSupportedEvidenceVerifiers(
    supportedEvidenceVerifiers,
    "$.supportedEvidenceVerifiers",
  );
  const expiresAt = fieldString(
    normalized,
    "expiresAt",
    "$",
    "policy-engine-record-date-invalid",
  );
  parseStrictRfc3339(expiresAt, "$.expiresAt");

  return {
    schema: POLICY_ENGINE_RECORD_SCHEMA,
    ownerDid: requiredString(normalized, "ownerDid", "$"),
    endpoint: requiredString(normalized, "endpoint", "$"),
    audience: requiredString(normalized, "audience", "$"),
    supportedPolicyVersions,
    supportedEvidenceVerifiers,
    grantIssuerDid: requiredString(normalized, "grantIssuerDid", "$"),
    expiresAt,
  };
}

export async function createAndSignRequesterPolicyEngineRecord(
  input: CreatePolicyEngineRecordInput,
  signer: SignedObjectSigner,
): Promise<PolicyEngineRecord> {
  return createAndSignPolicyEngineRecord(createUnsignedPolicyEngineRecord(input), signer).catch(
    (error) => {
      throw wrapSignedObjectError(error);
    },
  );
}

/**
 * Compose the SDK-level transcript-share bootstrap record. This record is not
 * an invitation and is not authority; it only tells a requester where to ask
 * and which policy id to reference.
 */
export function composeTranscriptShareBootstrap(
  input: ComposeTranscriptShareBootstrapInput,
): TranscriptShareBootstrap {
  const normalized = expectObject(input, "$", "transcript-share-bootstrap-malformed");
  assertExactKeys(normalized, ["policyId", "policyEngineRecord", "resourceHint"], "$");
  const signedRecord = expectPolicyEngineRecord(
    requiredValue(normalized, "policyEngineRecord", "$"),
  );
  if (!signedRecord.supportedEvidenceVerifiers.includes(W3C_VC_CREDENTIAL_VERIFIER)) {
    throw new PolicyAuthoringError(
      "transcript-share-bootstrap-malformed",
      "policy engine record does not support the bootstrap evidence verifier",
    );
  }
  return {
    schema: TRANSCRIPT_SHARE_BOOTSTRAP_SCHEMA,
    policyId: requiredString(normalized, "policyId", "$"),
    policyEngine: {
      endpoint: signedRecord.endpoint,
      audience: signedRecord.audience,
      supportedEvidenceVerifiers: [W3C_VC_CREDENTIAL_VERIFIER],
      signedRecord,
    },
    resourceHint: requiredObject(normalized, "resourceHint", "$"),
  };
}

/**
 * Requester-side authentication gate for policy-engine endpoints. A requester
 * MUST NOT send credential evidence or call /resolve unless this verification
 * succeeds.
 */
export async function verifyPolicyEngineRecordForRequester(
  options: VerifyPolicyEngineRecordOptions,
): Promise<PolicyEngineRecord> {
  const normalized = expectObject(options, "$", "policy-authoring-malformed");
  assertExactKeys(
    normalized,
    [
      "signedRecord",
      "ownerDid",
      "audience",
      "grantIssuerDid",
      "now",
      "requiredPolicyVersion",
      "requiredEvidenceVerifier",
    ],
    "$",
  );
  if (!hasOwn(normalized, "signedRecord")) {
    throw new PolicyAuthoringError(
      "policy-engine-record-absent",
      "$.signedRecord must be present",
    );
  }
  const signedRecord = normalized["signedRecord"];
  if (signedRecord === null || typeof signedRecord !== "object" || Array.isArray(signedRecord)) {
    throw new PolicyAuthoringError(
      "policy-engine-record-absent",
      "$.signedRecord must be present",
    );
  }
  const recordObject = signedRecord as JsonObject;
  const expiresAt = fieldString(recordObject, "expiresAt", "$.signedRecord", "policy-engine-record-date-invalid");
  const now = fieldString(normalized, "now", "$", "policy-engine-record-date-invalid");
  const expiresMs = parseStrictRfc3339(expiresAt, "$.signedRecord.expiresAt");
  const nowMs = parseStrictRfc3339(now, "$.now");
  if (expiresMs <= nowMs) {
    throw new PolicyAuthoringError(
      "policy-engine-record-expired",
      "$.signedRecord.expiresAt is expired",
    );
  }

  let verified: PolicyEngineRecord;
  try {
    verified = (await verifyPolicyEngineRecord(recordObject)).object;
  } catch (error) {
    throw new PolicyAuthoringError(
      "policy-engine-record-signature-invalid",
      error instanceof Error ? error.message : String(error),
    );
  }

  const expectedOwnerDid = requiredString(normalized, "ownerDid", "$");
  if (verified.ownerDid !== expectedOwnerDid) {
    throw new PolicyAuthoringError(
      "policy-engine-record-owner-mismatch",
      "$.signedRecord.ownerDid does not match",
    );
  }
  const expectedAudience = requiredString(normalized, "audience", "$");
  if (verified.audience !== expectedAudience) {
    throw new PolicyAuthoringError(
      "policy-engine-record-audience-mismatch",
      "$.signedRecord.audience does not match",
    );
  }
  const expectedGrantIssuerDid = requiredString(normalized, "grantIssuerDid", "$");
  if (verified.grantIssuerDid !== expectedGrantIssuerDid) {
    throw new PolicyAuthoringError(
      "policy-engine-record-grant-issuer-mismatch",
      "$.signedRecord.grantIssuerDid does not match",
    );
  }
  const requiredPolicyVersion = hasOwn(normalized, "requiredPolicyVersion")
    ? requiredString(normalized, "requiredPolicyVersion", "$")
    : POLICY_VERSION_V0;
  if (!verified.supportedPolicyVersions.includes(requiredPolicyVersion)) {
    throw new PolicyAuthoringError(
      "policy-engine-record-policy-version-unsupported",
      "$.signedRecord.supportedPolicyVersions does not include the required version",
    );
  }
  const requiredEvidenceVerifier = hasOwn(normalized, "requiredEvidenceVerifier")
    ? requiredString(normalized, "requiredEvidenceVerifier", "$")
    : W3C_VC_CREDENTIAL_VERIFIER;
  if (!verified.supportedEvidenceVerifiers.includes(requiredEvidenceVerifier)) {
    throw new PolicyAuthoringError(
      "policy-engine-record-evidence-verifier-unsupported",
      "$.signedRecord.supportedEvidenceVerifiers does not include the required verifier",
    );
  }
  return verified;
}

function expectObject(input: unknown, path: string, code: PolicyAuthoringErrorCode): JsonObject {
  try {
    const normalized = normalizeJson(input);
    if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
      throw new PolicyAuthoringError(code, `${path} must be an object`);
    }
    return normalized as JsonObject;
  } catch (error) {
    if (error instanceof PolicyAuthoringError) {
      throw error;
    }
    throw new PolicyAuthoringError(
      code,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function expectPolicyEngineRecord(input: JsonValue): PolicyEngineRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new PolicyAuthoringError(
      "transcript-share-bootstrap-malformed",
      "$.policyEngineRecord must be an object",
    );
  }
  try {
    return validatePolicyEngineRecordSignedShape(input);
  } catch (error) {
    throw new PolicyAuthoringError(
      "transcript-share-bootstrap-malformed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function assertExactKeys(object: JsonObject, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) {
      throw new PolicyAuthoringError("policy-authoring-unknown-key", `${path} has unknown field ${key}`);
    }
  }
}

function requiredValue(object: JsonObject, key: string, path: string): JsonValue {
  if (!hasOwn(object, key)) {
    throw new PolicyAuthoringError("policy-authoring-malformed", `${path}.${key} is required`);
  }
  return object[key];
}

function requiredString(object: JsonObject, key: string, path: string): string {
  const value = requiredValue(object, key, path);
  if (typeof value !== "string" || value.length === 0) {
    throw new PolicyAuthoringError("policy-authoring-malformed", `${path}.${key} must be a non-empty string`);
  }
  return value;
}

function fieldString(
  object: JsonObject,
  key: string,
  path: string,
  code: PolicyAuthoringErrorCode,
): string {
  if (!hasOwn(object, key)) {
    throw new PolicyAuthoringError(code, `${path}.${key} is required`);
  }
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PolicyAuthoringError(code, `${path}.${key} must be a non-empty string`);
  }
  return value;
}

function requiredObject(object: JsonObject, key: string, path: string): JsonObject {
  const value = requiredValue(object, key, path);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyAuthoringError("policy-authoring-malformed", `${path}.${key} must be an object`);
  }
  return value as JsonObject;
}

function requiredArray(object: JsonObject, key: string, path: string): readonly JsonValue[] {
  const value = requiredValue(object, key, path);
  if (!Array.isArray(value)) {
    throw new PolicyAuthoringError("policy-authoring-malformed", `${path}.${key} must be an array`);
  }
  return value;
}

function requiredStringArray(object: JsonObject, key: string, path: string): string[] {
  const values = requiredArray(object, key, path);
  return values.map((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new PolicyAuthoringError(
        "policy-authoring-malformed",
        `${path}.${key}[${index}] must be a non-empty string`,
      );
    }
    return value;
  });
}

function validateSupportedPolicyVersions(values: readonly string[], path: string): void {
  if (values.length === 0) {
    throw new PolicyAuthoringError(
      "policy-authoring-malformed",
      `${path} must not be empty`,
    );
  }
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== POLICY_VERSION_V0) {
      throw new PolicyAuthoringError(
        "policy-authoring-malformed",
        `${path}[${index}] is unsupported`,
      );
    }
  }
}

function validateSupportedEvidenceVerifiers(values: readonly string[], path: string): void {
  if (values.length === 0) {
    throw new PolicyAuthoringError(
      "policy-authoring-malformed",
      `${path} must not be empty`,
    );
  }
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== W3C_VC_CREDENTIAL_VERIFIER) {
      throw new PolicyAuthoringError(
        "policy-authoring-malformed",
        `${path}[${index}] is unsupported`,
      );
    }
  }
}

function wrapCapabilityError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof PolicyCapabilityError) {
      throw new PolicyAuthoringError(error.code, error.message);
    }
    throw error;
  }
}

function wrapSignedObjectError(error: unknown): Error {
  if (error instanceof PolicyAuthoringError) {
    return error;
  }
  if (error instanceof SignedObjectSchemaError || error instanceof SignedObjectProfileError) {
    return new PolicyAuthoringError("policy-authoring-malformed", error.message);
  }
  return new PolicyAuthoringError(
    "policy-authoring-malformed",
    error instanceof Error ? error.message : String(error),
  );
}

function parseStrictRfc3339(value: string, path: string): number {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/,
  );
  if (!match) {
    throw new PolicyAuthoringError("policy-engine-record-date-invalid", `${path} must be strict RFC 3339`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new PolicyAuthoringError(
      "policy-engine-record-date-invalid",
      `${path} must be parseable`,
    );
  }
  const canonical = new Date(parsed).toISOString().replace(".000Z", "Z");
  if (canonical !== value) {
    throw new PolicyAuthoringError(
      "policy-engine-record-date-invalid",
      `${path} must be normalizable`,
    );
  }
  return parsed;
}

const objectHasOwn: (object: object, propertyKey: PropertyKey) => boolean =
  (Object as ObjectConstructor & {
    hasOwn?: (object: object, propertyKey: PropertyKey) => boolean;
  }).hasOwn ??
  (Object.prototype.hasOwnProperty.call.bind(
    Object.prototype.hasOwnProperty,
  ) as (object: object, propertyKey: PropertyKey) => boolean);

function hasOwn(object: JsonObject, key: string): boolean {
  return objectHasOwn(object, key);
}
