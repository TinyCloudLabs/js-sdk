import { CAPABILITY_REGISTRY } from "@tinycloud/bootstrap";
import { bytesToHex, sha256 } from "viem";
import { jcsCanonicalize, normalizeJson, type JsonValue } from "./jcs";

const POLICY_CAPABILITY_DOMAIN = "xyz.tinycloud.policy/PolicyCapability/v0";
const textEncoder = new TextEncoder();

export type PolicyCapabilityErrorCode =
  | "policy-capability-malformed"
  | "policy-capability-unknown-key"
  | "policy-capability-malformed-service"
  | "policy-capability-malformed-space"
  | "policy-capability-malformed-path"
  | "policy-capability-malformed-action"
  | "policy-capability-empty-actions"
  | "policy-capability-malformed-caveats";

export class PolicyCapabilityError extends Error {
  public readonly code: PolicyCapabilityErrorCode;

  constructor(code: PolicyCapabilityErrorCode, message: string) {
    super(message);
    this.name = "PolicyCapabilityError";
    this.code = code;
  }
}

export interface PolicyCapability {
  readonly service: "tinycloud.kv" | "tinycloud.sql" | "tinycloud.vfs";
  readonly space: string;
  readonly path: string;
  readonly actions: readonly string[];
  readonly caveats?: JsonObject;
}

export type JsonObject = { readonly [key: string]: JsonValue };

interface NormalizeOptions {
  readonly allowPrefixPaths?: boolean;
  readonly requireCanonical?: boolean;
}

const objectHasOwn: (object: object, propertyKey: PropertyKey) => boolean =
  (Object as ObjectConstructor & {
    hasOwn?: (object: object, propertyKey: PropertyKey) => boolean;
  }).hasOwn ??
  (Object.prototype.hasOwnProperty.call.bind(
    Object.prototype.hasOwnProperty,
  ) as (object: object, propertyKey: PropertyKey) => boolean);

const CEILING_SERVICES = new Set(["tinycloud.kv", "tinycloud.sql", "tinycloud.vfs"]);
const GRANTABLE_ACTIONS = new Map<string, ReadonlySet<string>>();

for (const entry of CAPABILITY_REGISTRY) {
  if (!CEILING_SERVICES.has(entry.service)) {
    continue;
  }
  if (entry.aliasOf !== undefined || entry.implies !== undefined || entry.urn.endsWith("/*")) {
    continue;
  }
  const existing = GRANTABLE_ACTIONS.get(entry.service);
  if (existing === undefined) {
    GRANTABLE_ACTIONS.set(entry.service, new Set([entry.urn]));
    continue;
  }
  (existing as Set<string>).add(entry.urn);
}

/**
 * Strict authoring validator for resolved Listen-adapter PolicyCapability JSON.
 * It accepts only concrete service/space/path/action/caveat forms and rejects
 * manifest-shaped permission payloads before any Policy is signed.
 */
export function normalizePolicyCapability(input: unknown): PolicyCapability {
  return normalizePolicyCapabilityWithOptions(input, { requireCanonical: true });
}

/**
 * Frozen-vector canonicalizer for the m1-b-01a policy-capability vectors.
 * Prefix paths are allowed here only to preserve behavioral conformance with
 * the vendored engine vectors; authoring uses normalizePolicyCapability.
 */
export function canonicalizePolicyCapability(input: unknown): PolicyCapability {
  return normalizePolicyCapabilityWithOptions(input, { allowPrefixPaths: true });
}

export function policyCapabilityDigestHex(input: unknown): string {
  const canonical = canonicalizePolicyCapability(input);
  const jcs = textEncoder.encode(jcsCanonicalize(canonical));
  const domain = textEncoder.encode(`${POLICY_CAPABILITY_DOMAIN}\0`);
  const bytes = new Uint8Array(domain.length + jcs.length);
  bytes.set(domain, 0);
  bytes.set(jcs, domain.length);
  return bytesToHex(sha256(bytes, "bytes")).slice(2);
}

export function policyCapabilityContains(authority: unknown, request: unknown): boolean {
  let auth: PolicyCapability;
  let req: PolicyCapability;
  try {
    auth = canonicalizePolicyCapability(authority);
    req = canonicalizePolicyCapability(request);
  } catch {
    return false;
  }
  if (auth.service !== req.service || auth.space !== req.space) {
    return false;
  }
  if (!pathContains(auth.path, req.path)) {
    return false;
  }
  const authActions = new Set(auth.actions);
  for (const action of req.actions) {
    if (!authActions.has(action)) {
      return false;
    }
  }
  return caveatsContain(auth.caveats, req.caveats);
}

function normalizePolicyCapabilityWithOptions(
  input: unknown,
  options: NormalizeOptions,
): PolicyCapability {
  const object = expectObject(input, "$");
  assertExactKeys(object, ["service", "space", "path", "actions", "caveats"], "$");
  const service = requiredString(object, "service", "$", "policy-capability-malformed-service");
  if (!CEILING_SERVICES.has(service)) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-service",
      "$.service is outside the frozen permissionsCeiling vocabulary",
    );
  }
  const space = requiredString(object, "space", "$", "policy-capability-malformed-space");
  validateConcreteSpace(space);
  const canonicalSpace = space.normalize("NFC");
  if (options.requireCanonical && canonicalSpace !== space) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-space",
      "$.space must already be canonical NFC",
    );
  }
  const rawPath = requiredString(object, "path", "$", "policy-capability-malformed-path");
  validateRawPath(rawPath, options);
  const path = normalizePath(rawPath);
  if (options.requireCanonical && path !== rawPath) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-path",
      "$.path must already be canonical",
    );
  }
  validateRawPath(path, options);
  const actions = normalizeActions(
    requiredArray(object, "actions", "$", "policy-capability-malformed-action"),
    service,
    options,
  );
  const output = Object.create(null) as {
    service: PolicyCapability["service"];
    space: string;
    path: string;
    actions: string[];
    caveats?: JsonObject;
  };
  output.service = service as PolicyCapability["service"];
  output.space = canonicalSpace;
  output.path = path;
  output.actions = actions;
  if (hasOwn(object, "caveats")) {
    output.caveats = validateCaveats(
      requiredValue(object, "caveats", "$", "policy-capability-malformed-caveats"),
      output.service,
    );
  }
  return output;
}

function expectObject(input: unknown, path: string): JsonObject {
  try {
    const normalized = normalizeJson(input);
    if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
      throw new PolicyCapabilityError("policy-capability-malformed", `${path} must be an object`);
    }
    return normalized as JsonObject;
  } catch (error) {
    if (error instanceof PolicyCapabilityError) {
      throw error;
    }
    throw new PolicyCapabilityError(
      "policy-capability-malformed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function assertExactKeys(object: JsonObject, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) {
      throw new PolicyCapabilityError(
        key === "id" || key === "scope" ? "policy-capability-malformed" : "policy-capability-unknown-key",
        `${path} has unknown field ${key}`,
      );
    }
  }
}

function requiredValue(
  object: JsonObject,
  key: string,
  path: string,
  code: PolicyCapabilityErrorCode,
): JsonValue {
  if (!hasOwn(object, key)) {
    throw new PolicyCapabilityError(code, `${path}.${key} is required`);
  }
  return object[key];
}

function requiredString(
  object: JsonObject,
  key: string,
  path: string,
  code: PolicyCapabilityErrorCode,
): string {
  const value = requiredValue(object, key, path, code);
  if (typeof value !== "string" || value.length === 0) {
    throw new PolicyCapabilityError(code, `${path}.${key} must be a non-empty string`);
  }
  return value;
}

function requiredArray(
  object: JsonObject,
  key: string,
  path: string,
  code: PolicyCapabilityErrorCode,
): readonly JsonValue[] {
  const value = requiredValue(object, key, path, code);
  if (!Array.isArray(value)) {
    throw new PolicyCapabilityError(code, `${path}.${key} must be an array`);
  }
  return value;
}

function validateConcreteSpace(space: string): void {
  if (space === "*" || space.includes("*") || space.includes("?") || space.includes("/")) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-space",
      "$.space must be concrete",
    );
  }
}

function validateRawPath(path: string, options: NormalizeOptions): void {
  if (path.length === 0) {
    throw new PolicyCapabilityError("policy-capability-malformed-path", "$.path is empty");
  }
  if (!options.allowPrefixPaths && path.endsWith("/")) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-path",
      "$.path must be an exact concrete path, not a prefix",
    );
  }
  if (path.endsWith("/*") || path.includes("**")) {
    throw new PolicyCapabilityError("policy-capability-malformed-path", "$.path is a prefix form");
  }
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const isTrailingPrefixSegment =
      options.allowPrefixPaths && index === segments.length - 1 && segment.length === 0;
    if (segment.length === 0 && !isTrailingPrefixSegment) {
      throw new PolicyCapabilityError("policy-capability-malformed-path", "$.path has an empty segment");
    }
    if (segment === "." || segment === "..") {
      throw new PolicyCapabilityError(
        "policy-capability-malformed-path",
        "$.path has a traversal segment",
      );
    }
    if (segment === "*" || segment === "?" || segment.includes("*") || segment.includes("?")) {
      throw new PolicyCapabilityError(
        "policy-capability-malformed-path",
        "$.path has a wildcard segment",
      );
    }
  }
}

function normalizePath(path: string): string {
  return decodeUnreserved(path).normalize("NFC");
}

function decodeUnreserved(path: string): string {
  return path.replace(/%[0-9A-Fa-f]{2}/g, (encoded) => {
    const char = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
    return /^[A-Za-z0-9._~-]$/.test(char) ? char : encoded.toUpperCase();
  });
}

function normalizeActions(
  actions: readonly JsonValue[],
  service: string,
  options: NormalizeOptions,
): string[] {
  const accepted = GRANTABLE_ACTIONS.get(service);
  if (accepted === undefined) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-service",
      "$.service is unsupported",
    );
  }
  const unique = new Set<string>();
  const rawActions: string[] = [];
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    if (typeof action !== "string" || action.length === 0) {
      throw new PolicyCapabilityError(
        "policy-capability-malformed-action",
        `$.actions[${index}] must be a non-empty action URN`,
      );
    }
    if (!action.startsWith(`${service}/`) || action.includes("*") || !accepted.has(action)) {
      throw new PolicyCapabilityError(
        "policy-capability-malformed-action",
        `$.actions[${index}] is not a grantable action URN`,
      );
    }
    rawActions.push(action);
    unique.add(action);
  }
  if (unique.size === 0) {
    throw new PolicyCapabilityError(
      "policy-capability-empty-actions",
      "$.actions must not be empty",
    );
  }
  const normalizedActions = [...unique].sort();
  if (
    options.requireCanonical &&
    (rawActions.length !== normalizedActions.length ||
      rawActions.some((action, index) => action !== normalizedActions[index]))
  ) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-action",
      "$.actions must already be sorted, deduplicated canonical action URNs",
    );
  }
  return normalizedActions;
}

function validateCaveats(input: JsonValue, service: PolicyCapability["service"]): JsonObject {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-caveats",
      "$.caveats must be an object",
    );
  }
  if (service === "tinycloud.sql") {
    return validateSqlCaveats(input as JsonObject);
  }
  throw new PolicyCapabilityError(
    "policy-capability-malformed-caveats",
    "$.caveats are not defined for this service",
  );
}

function validateSqlCaveats(input: JsonObject): JsonObject {
  assertCaveatKeys(input, ["mode", "readOnly", "statements"], "$.caveats");
  const mode = caveatString(input, "mode", "$.caveats");
  if (mode !== "constrained-statements") {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-caveats",
      "$.caveats.mode is unsupported",
    );
  }
  if (requiredCaveat(input, "readOnly", "$.caveats") !== true) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-caveats",
      "$.caveats.readOnly must be true",
    );
  }
  const statements = requiredCaveat(input, "statements", "$.caveats");
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-caveats",
      "$.caveats.statements must be a non-empty array",
    );
  }
  for (let index = 0; index < statements.length; index++) {
    validateSqlStatement(statements[index], `$.caveats.statements[${index}]`);
  }
  return input;
}

function validateSqlStatement(input: JsonValue, path: string): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new PolicyCapabilityError("policy-capability-malformed-caveats", `${path} must be an object`);
  }
  const object = input as JsonObject;
  assertCaveatKeys(object, ["name", "sql", "fixedParams"], path);
  caveatString(object, "name", path);
  caveatString(object, "sql", path);
  const fixedParams = requiredCaveat(object, "fixedParams", path);
  if (!Array.isArray(fixedParams)) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-caveats",
      `${path}.fixedParams must be an array`,
    );
  }
  for (let index = 0; index < fixedParams.length; index++) {
    validateFixedParam(fixedParams[index], `${path}.fixedParams[${index}]`);
  }
}

function validateFixedParam(input: JsonValue, path: string): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new PolicyCapabilityError("policy-capability-malformed-caveats", `${path} must be an object`);
  }
  const object = input as JsonObject;
  assertCaveatKeys(object, ["index", "value"], path);
  const index = requiredCaveat(object, "index", path);
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-caveats",
      `${path}.index must be a non-negative integer`,
    );
  }
  requiredCaveat(object, "value", path);
}

function assertCaveatKeys(object: JsonObject, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) {
      throw new PolicyCapabilityError(
        "policy-capability-malformed-caveats",
        `${path} has unknown field ${key}`,
      );
    }
  }
}

function requiredCaveat(object: JsonObject, key: string, path: string): JsonValue {
  if (!hasOwn(object, key)) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-caveats",
      `${path}.${key} is required`,
    );
  }
  return object[key];
}

function caveatString(object: JsonObject, key: string, path: string): string {
  const value = requiredCaveat(object, key, path);
  if (typeof value !== "string" || value.length === 0) {
    throw new PolicyCapabilityError(
      "policy-capability-malformed-caveats",
      `${path}.${key} must be a non-empty string`,
    );
  }
  return value;
}

function pathContains(authority: string, request: string): boolean {
  if (authority === request) {
    return true;
  }
  return authority.endsWith("/") && request.startsWith(authority);
}

function caveatsContain(authority: JsonObject | undefined, request: JsonObject | undefined): boolean {
  if (authority === undefined) {
    return request === undefined;
  }
  if (request === undefined) {
    return Object.keys(authority).length === 0;
  }
  if (authority.mode !== "constrained-statements" || request.mode !== "constrained-statements") {
    return false;
  }
  const authorityStatements = Array.isArray(authority.statements) ? authority.statements : [];
  const requestStatements = Array.isArray(request.statements) ? request.statements : [];
  return requestStatements.every((statement) =>
    authorityStatements.some((candidate) => jcsCanonicalize(candidate) === jcsCanonicalize(statement)),
  );
}

function hasOwn(object: JsonObject, key: string): boolean {
  return objectHasOwn(object, key);
}
