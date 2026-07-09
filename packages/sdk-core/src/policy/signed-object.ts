import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { bytesToHex, sha256, verifyMessage } from "viem";
import { parsePkhDid } from "../identity";
import { canonicalizePolicyCapability } from "./capability";
import {
  SignatureMaterialError,
  SignatureVerificationError,
  SignedObjectDigestError,
  SignedObjectIdError,
  SignedObjectProfileError,
  SignedObjectSchemaError,
  SigningKeyBindingError,
  UnsupportedSignatureSuiteError,
  toSignedObjectError,
} from "./errors";
import { type JsonValue, jcsCanonicalize, normalizeJson } from "./jcs";

export const POLICY_SCHEMA = "xyz.tinycloud.policy/policy/v0";
export const POLICY_STATUS_SCHEMA = "xyz.tinycloud.policy/status/v0";
export const POLICY_ENGINE_RECORD_SCHEMA =
  "xyz.tinycloud.policy/engine-record/v0";

export const ED25519_JCS_SIGNATURE_SUITE = "eddsa-ed25519-sha256-jcs-v1";
export const EIP191_JCS_SIGNATURE_SUITE =
  "eip191-secp256k1-sha256-jcs-v1";

export type SignedObjectKind = "Policy" | "PolicyStatus" | "PolicyEngineRecord";

export type SignatureSuite =
  | typeof ED25519_JCS_SIGNATURE_SUITE
  | typeof EIP191_JCS_SIGNATURE_SUITE;

export interface SignedObjectSignature {
  suite: SignatureSuite;
  signerDid: string;
  value: string;
}

export type JsonObject = { readonly [key: string]: JsonValue };

export interface Policy {
  readonly schema: typeof POLICY_SCHEMA;
  readonly policyId: string;
  readonly ownerDid: string;
  readonly signingKeyDid: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly resource: JsonObject;
  readonly when: JsonObject;
  readonly grant: JsonObject;
  readonly disclosure?: JsonObject;
  readonly audit?: JsonObject;
  readonly signature: SignedObjectSignature;
}

export type UnsignedPolicy = Omit<Policy, "policyId" | "signature">;

export interface PolicyStatus {
  readonly schema: typeof POLICY_STATUS_SCHEMA;
  readonly statusId: string;
  readonly policyId: string;
  readonly ownerDid: string;
  readonly sequence: number;
  readonly disposition: "active" | "suspended" | "revoked";
  readonly effectiveAt: string;
  readonly reasonCode?: string;
  readonly signingKeyDid: string;
  readonly signature: SignedObjectSignature;
}

export type UnsignedPolicyStatus = Omit<PolicyStatus, "statusId" | "signature">;

export interface PolicyEngineRecord {
  readonly schema: typeof POLICY_ENGINE_RECORD_SCHEMA;
  readonly engineRecordId: string;
  readonly ownerDid: string;
  readonly endpoint: string;
  readonly audience: string;
  readonly supportedPolicyVersions: string[];
  readonly supportedEvidenceVerifiers: string[];
  readonly grantIssuerDid: string;
  readonly expiresAt: string;
  readonly signature: SignedObjectSignature;
}

export type UnsignedPolicyEngineRecord = Omit<
  PolicyEngineRecord,
  "engineRecordId" | "signature"
>;

export type SignedPolicyObject =
  | Policy
  | PolicyStatus
  | PolicyEngineRecord;

export type UnsignedPolicyObject =
  | UnsignedPolicy
  | UnsignedPolicyStatus
  | UnsignedPolicyEngineRecord;

export interface SignedObjectSigner {
  readonly suite: SignatureSuite;
  readonly signerDid: string;
  signDigest(digest: Uint8Array): Promise<Uint8Array | string> | Uint8Array | string;
}

export interface SignedObjectMaterial {
  readonly kind: SignedObjectKind;
  readonly idField: string;
  readonly id: string;
  readonly domain: string;
  readonly unsigned: JsonObject;
  readonly jcs: string;
  readonly jcsBytes: Uint8Array;
  readonly digest: Uint8Array;
  readonly digestHex: string;
}

export type SignedObjectVerificationResult<T extends SignedPolicyObject> =
  | { readonly ok: true; readonly object: T; readonly material: SignedObjectMaterial }
  | { readonly ok: false; readonly error: SignedObjectProfileError };

interface ObjectDescriptor {
  readonly kind: SignedObjectKind;
  readonly schema: string;
  readonly idField: "policyId" | "statusId" | "engineRecordId";
  readonly idPrefix: string;
  readonly domain: string;
}

const DESCRIPTORS: Record<SignedObjectKind, ObjectDescriptor> = {
  Policy: {
    kind: "Policy",
    schema: POLICY_SCHEMA,
    idField: "policyId",
    idPrefix: "pol_",
    domain: POLICY_SCHEMA,
  },
  PolicyStatus: {
    kind: "PolicyStatus",
    schema: POLICY_STATUS_SCHEMA,
    idField: "statusId",
    idPrefix: "polst_",
    domain: POLICY_STATUS_SCHEMA,
  },
  PolicyEngineRecord: {
    kind: "PolicyEngineRecord",
    schema: POLICY_ENGINE_RECORD_SCHEMA,
    idField: "engineRecordId",
    idPrefix: "peng_",
    domain: POLICY_ENGINE_RECORD_SCHEMA,
  },
};

const textEncoder = new TextEncoder();
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const objectHasOwn: (object: object, propertyKey: PropertyKey) => boolean =
  (Object as ObjectConstructor & {
    hasOwn?: (object: object, propertyKey: PropertyKey) => boolean;
  }).hasOwn ??
  (Object.prototype.hasOwnProperty.call.bind(
    Object.prototype.hasOwnProperty,
  ) as (object: object, propertyKey: PropertyKey) => boolean);

export function canonicalizeSignedObjectUnsigned(input: unknown): string {
  return jcsCanonicalize(input);
}

export function deriveSignedObjectMaterial(input: unknown): SignedObjectMaterial {
  const descriptor = descriptorForUnsigned(input);
  const unsigned = validateUnsignedForDescriptor(input, descriptor);
  return materialForUnsigned(unsigned, descriptor);
}

export function signedObjectIdFor(input: unknown): string {
  return deriveSignedObjectMaterial(input).id;
}

export async function createAndSignSignedObject(
  input: unknown,
  signer: SignedObjectSigner,
): Promise<SignedPolicyObject> {
  const normalized = expectJsonObject(normalizeJson(input), "$");
  const descriptor = descriptorForUnsigned(normalized);
  const stripped = stripOwnIdAndSignature(normalized, descriptor);
  const unsigned = validateUnsignedForDescriptor(stripped, descriptor);
  assertSupportedSignatureSuite(signer.suite);
  requireStringType(signer.signerDid, "$.signer.signerDid");
  assertSignerDidMatchesSuite(signer.signerDid, signer.suite);
  assertSigningKeyBindingForCreate(unsigned, signer.signerDid);
  const material = materialForUnsigned(unsigned, descriptor);
  const signatureValue = encodeSignatureValue(
    await signer.signDigest(material.digest),
    signer.suite,
  );
  const signature = validateSignature({
    suite: signer.suite,
    signerDid: signer.signerDid,
    value: signatureValue,
  });
  return {
    ...unsigned,
    [descriptor.idField]: material.id,
    signature,
  } as unknown as SignedPolicyObject;
}

export function createAndSignPolicy(
  input: unknown,
  signer: SignedObjectSigner,
): Promise<Policy> {
  return createAndSignSignedObject(input, signer).then((object) =>
    validatePolicySignedShape(object),
  );
}

export function createAndSignPolicyStatus(
  input: unknown,
  signer: SignedObjectSigner,
): Promise<PolicyStatus> {
  return createAndSignSignedObject(input, signer).then((object) =>
    validatePolicyStatusSignedShape(object),
  );
}

export function createAndSignPolicyEngineRecord(
  input: unknown,
  signer: SignedObjectSigner,
): Promise<PolicyEngineRecord> {
  return createAndSignSignedObject(input, signer).then((object) =>
    validatePolicyEngineRecordSignedShape(object),
  );
}

export async function verifySignedObject(
  input: unknown,
): Promise<{ object: SignedPolicyObject; material: SignedObjectMaterial }> {
  const signed = validateSignedObjectShape(input);
  const signedJson = signed as unknown as JsonObject;
  const descriptor = descriptorForSchema(signed.schema);
  const signature = validateSignature(signed.signature);
  assertSigningKeyBindingForVerify(signedJson, signature);
  const unsigned = stripOwnIdAndSignature(signedJson, descriptor);
  const material = materialForUnsigned(unsigned, descriptor);
  assertIdMatches(signedJson, material, descriptor);
  if (!(await verifySignature(signature, material.digest))) {
    throw new SignatureVerificationError("signature verification failed");
  }
  return { object: signed, material };
}

export async function verifyPolicy(
  input: unknown,
): Promise<{ object: Policy; material: SignedObjectMaterial }> {
  const result = await verifySignedObject(input);
  return {
    object: validatePolicySignedShape(result.object),
    material: result.material,
  };
}

export async function verifyPolicyStatus(
  input: unknown,
): Promise<{ object: PolicyStatus; material: SignedObjectMaterial }> {
  const result = await verifySignedObject(input);
  return {
    object: validatePolicyStatusSignedShape(result.object),
    material: result.material,
  };
}

export async function verifyPolicyEngineRecord(
  input: unknown,
): Promise<{ object: PolicyEngineRecord; material: SignedObjectMaterial }> {
  const result = await verifySignedObject(input);
  return {
    object: validatePolicyEngineRecordSignedShape(result.object),
    material: result.material,
  };
}

export async function validatePolicySigned(
  input: unknown,
): Promise<SignedObjectVerificationResult<Policy>> {
  try {
    const result = await verifyPolicy(input);
    return { ok: true, object: result.object, material: result.material };
  } catch (error) {
    return { ok: false, error: toSignedObjectError(error) };
  }
}

export async function validatePolicyStatusSigned(
  input: unknown,
): Promise<SignedObjectVerificationResult<PolicyStatus>> {
  try {
    const result = await verifyPolicyStatus(input);
    return { ok: true, object: result.object, material: result.material };
  } catch (error) {
    return { ok: false, error: toSignedObjectError(error) };
  }
}

export async function validatePolicyEngineRecordSigned(
  input: unknown,
): Promise<SignedObjectVerificationResult<PolicyEngineRecord>> {
  try {
    const result = await verifyPolicyEngineRecord(input);
    return { ok: true, object: result.object, material: result.material };
  } catch (error) {
    return { ok: false, error: toSignedObjectError(error) };
  }
}

export function validatePolicyUnsigned(input: unknown): UnsignedPolicy {
  return validatePolicyShape(input, false) as unknown as UnsignedPolicy;
}

export function validatePolicyStatusUnsigned(input: unknown): UnsignedPolicyStatus {
  return validatePolicyStatusShape(input, false) as unknown as UnsignedPolicyStatus;
}

export function validatePolicyEngineRecordUnsigned(
  input: unknown,
): UnsignedPolicyEngineRecord {
  return validatePolicyEngineRecordShape(input, false) as unknown as UnsignedPolicyEngineRecord;
}

export function validatePolicySignedShape(input: unknown): Policy {
  return validatePolicyShape(input, true) as unknown as Policy;
}

export function validatePolicyStatusSignedShape(input: unknown): PolicyStatus {
  return validatePolicyStatusShape(input, true) as unknown as PolicyStatus;
}

export function validatePolicyEngineRecordSignedShape(
  input: unknown,
): PolicyEngineRecord {
  return validatePolicyEngineRecordShape(input, true) as unknown as PolicyEngineRecord;
}

function validateSignedObjectShape(input: unknown): SignedPolicyObject {
  const normalized = expectJsonObject(normalizeJson(input), "$");
  const schema = requiredString(normalized, "schema", "$");
  const descriptor = descriptorForSchema(schema);
  switch (descriptor.kind) {
    case "Policy":
      return validatePolicySignedShape(normalized);
    case "PolicyStatus":
      return validatePolicyStatusSignedShape(normalized);
    case "PolicyEngineRecord":
      return validatePolicyEngineRecordSignedShape(normalized);
  }
}

function validateUnsignedForDescriptor(
  input: unknown,
  descriptor: ObjectDescriptor,
): JsonObject {
  switch (descriptor.kind) {
    case "Policy":
      return validatePolicyUnsigned(input) as unknown as JsonObject;
    case "PolicyStatus":
      return validatePolicyStatusUnsigned(input) as unknown as JsonObject;
    case "PolicyEngineRecord":
      return validatePolicyEngineRecordUnsigned(input) as unknown as JsonObject;
  }
}

function validatePolicyShape(input: unknown, signed: boolean): JsonObject {
  const object = expectJsonObject(normalizeJson(input), "$");
  assertExactKeys(
    object,
    signed
      ? [
          "schema",
          "policyId",
          "ownerDid",
          "signingKeyDid",
          "createdAt",
          "expiresAt",
          "resource",
          "when",
          "grant",
          "disclosure",
          "audit",
          "signature",
        ]
      : [
          "schema",
          "ownerDid",
          "signingKeyDid",
          "createdAt",
          "expiresAt",
          "resource",
          "when",
          "grant",
          "disclosure",
          "audit",
        ],
    "$",
  );
  expectConst(requiredString(object, "schema", "$"), POLICY_SCHEMA, "$.schema");
  if (signed) {
    requiredString(object, "policyId", "$");
    validateSignature(requiredValue(object, "signature", "$"));
  }
  requiredString(object, "ownerDid", "$");
  requiredString(object, "signingKeyDid", "$");
  requiredDateString(object, "createdAt", "$");
  optionalDateString(object, "expiresAt", "$");
  validatePolicyResource(requiredValue(object, "resource", "$"), "$.resource");
  validateExpression(requiredValue(object, "when", "$"), "$.when");
  validateGrant(requiredValue(object, "grant", "$"), "$.grant");
  if (hasOwn(object, "disclosure")) {
    validateDisclosure(requiredValue(object, "disclosure", "$"), "$.disclosure");
  }
  if (hasOwn(object, "audit")) {
    validateAudit(requiredValue(object, "audit", "$"), "$.audit");
  }
  return object;
}

function validatePolicyStatusShape(input: unknown, signed: boolean): JsonObject {
  const object = expectJsonObject(normalizeJson(input), "$");
  assertExactKeys(
    object,
    signed
      ? [
          "schema",
          "statusId",
          "policyId",
          "ownerDid",
          "sequence",
          "disposition",
          "effectiveAt",
          "reasonCode",
          "signingKeyDid",
          "signature",
        ]
      : [
          "schema",
          "policyId",
          "ownerDid",
          "sequence",
          "disposition",
          "effectiveAt",
          "reasonCode",
          "signingKeyDid",
        ],
    "$",
  );
  expectConst(requiredString(object, "schema", "$"), POLICY_STATUS_SCHEMA, "$.schema");
  if (signed) {
    requiredString(object, "statusId", "$");
    validateSignature(requiredValue(object, "signature", "$"));
  }
  requiredString(object, "policyId", "$");
  requiredString(object, "ownerDid", "$");
  requiredInteger(object, "sequence", "$", 0);
  expectOneOf(requiredString(object, "disposition", "$"), [
    "active",
    "suspended",
    "revoked",
  ], "$.disposition");
  requiredDateString(object, "effectiveAt", "$");
  optionalString(object, "reasonCode", "$");
  requiredString(object, "signingKeyDid", "$");
  return object;
}

function validatePolicyEngineRecordShape(
  input: unknown,
  signed: boolean,
): JsonObject {
  const object = expectJsonObject(normalizeJson(input), "$");
  assertExactKeys(
    object,
    signed
      ? [
          "schema",
          "engineRecordId",
          "ownerDid",
          "endpoint",
          "audience",
          "supportedPolicyVersions",
          "supportedEvidenceVerifiers",
          "grantIssuerDid",
          "expiresAt",
          "signature",
        ]
      : [
          "schema",
          "ownerDid",
          "endpoint",
          "audience",
          "supportedPolicyVersions",
          "supportedEvidenceVerifiers",
          "grantIssuerDid",
          "expiresAt",
        ],
    "$",
  );
  expectConst(
    requiredString(object, "schema", "$"),
    POLICY_ENGINE_RECORD_SCHEMA,
    "$.schema",
  );
  if (signed) {
    requiredString(object, "engineRecordId", "$");
    validateSignature(requiredValue(object, "signature", "$"));
  }
  requiredString(object, "ownerDid", "$");
  requiredString(object, "endpoint", "$");
  requiredString(object, "audience", "$");
  requiredStringArray(object, "supportedPolicyVersions", "$", (value, path) =>
    expectConst(value, "v0", path),
  );
  requiredStringArray(object, "supportedEvidenceVerifiers", "$");
  requiredString(object, "grantIssuerDid", "$");
  requiredDateString(object, "expiresAt", "$");
  return object;
}

function validateSignature(input: unknown): SignedObjectSignature {
  const object = expectJsonObject(input, "$.signature");
  assertExactKeys(object, ["suite", "signerDid", "value"], "$.signature");
  const suite = requiredString(object, "suite", "$.signature");
  assertSupportedSignatureSuite(suite);
  const signerDid = requiredString(object, "signerDid", "$.signature");
  const value = requiredString(object, "value", "$.signature");
  decodeSignatureValue(value, suite);
  return { suite, signerDid, value };
}

function validatePolicyResource(input: unknown, path: string): void {
  const object = expectJsonObject(input, path);
  assertExactKeys(object, ["resourceType", "resourceId", "permissionsCeiling"], path);
  requiredString(object, "resourceType", path);
  requiredString(object, "resourceId", path);
  const ceiling = requiredArray(object, "permissionsCeiling", path, 1);
  for (let index = 0; index < ceiling.length; index++) {
    validatePolicyCapability(ceiling[index], `${path}.permissionsCeiling[${index}]`);
  }
}

function validatePolicyCapability(input: unknown, path: string): void {
  const object = expectJsonObject(input, path);
  try {
    const canonical = canonicalizePolicyCapability(object);
    if (jcsCanonicalize(object) !== jcsCanonicalize(canonical)) {
      throw new SignedObjectSchemaError(`${path} must be canonical PolicyCapability JSON`);
    }
  } catch (error) {
    if (error instanceof SignedObjectSchemaError) {
      throw error;
    }
    throw new SignedObjectSchemaError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function validateExpression(input: unknown, path: string): void {
  const object = expectJsonObject(input, path);
  const keys = Object.keys(object);
  if (keys.length !== 1) {
    throw new SignedObjectSchemaError(`${path} must have exactly one expression key`);
  }
  const key = keys[0];
  if (key === "allOf" || key === "anyOf") {
    const values = requiredArray(object, key, path, 1);
    for (let index = 0; index < values.length; index++) {
      validateExpression(values[index], `${path}.${key}[${index}]`);
    }
    return;
  }
  if (key === "subject") {
    const subject = expectJsonObject(requiredValue(object, "subject", path), `${path}.subject`);
    assertExactKeys(subject, ["did"], `${path}.subject`);
    requiredString(subject, "did", `${path}.subject`);
    return;
  }
  if (key === "evidence") {
    validateEvidenceRequirement(requiredValue(object, "evidence", path), `${path}.evidence`);
    return;
  }
  throw new SignedObjectSchemaError(`${path} has unknown expression key ${key}`);
}

function validateEvidenceRequirement(input: unknown, path: string): void {
  const object = expectJsonObject(input, path);
  assertExactKeys(
    object,
    ["requirementId", "verifier", "requirements", "authority", "freshness"],
    path,
  );
  requiredString(object, "requirementId", path);
  requiredString(object, "verifier", path);
  requiredValue(object, "requirements", path);
  if (hasOwn(object, "authority")) {
    const authority = expectJsonObject(requiredValue(object, "authority", path), `${path}.authority`);
    assertExactKeys(
      authority,
      ["profile", "acceptedIssuers", "allowOwnerAuthorizedIssuer"],
      `${path}.authority`,
    );
    optionalString(authority, "profile", `${path}.authority`);
    if (hasOwn(authority, "acceptedIssuers")) {
      requiredStringArray(authority, "acceptedIssuers", `${path}.authority`);
    }
    optionalBoolean(authority, "allowOwnerAuthorizedIssuer", `${path}.authority`);
  }
  if (hasOwn(object, "freshness")) {
    const freshness = expectJsonObject(requiredValue(object, "freshness", path), `${path}.freshness`);
    assertExactKeys(freshness, ["maxStatusAgeSeconds"], `${path}.freshness`);
    requiredInteger(freshness, "maxStatusAgeSeconds", `${path}.freshness`, 0);
  }
}

function validateGrant(input: unknown, path: string): void {
  const object = expectJsonObject(input, path);
  assertExactKeys(object, ["output", "maxTtlSeconds", "delegationMode", "revocation"], path);
  expectConst(requiredString(object, "output", path), "portable-delegation", `${path}.output`);
  requiredInteger(object, "maxTtlSeconds", path, 1);
  expectOneOf(requiredString(object, "delegationMode", path), [
    "terminal",
    "attenuable",
  ], `${path}.delegationMode`);
  expectOneOf(requiredString(object, "revocation", path), [
    "refresh_only",
    "active_cutoff",
  ], `${path}.revocation`);
}

function validateDisclosure(input: unknown, path: string): void {
  const object = expectJsonObject(input, path);
  assertExactKeys(object, ["denial"], path);
  expectOneOf(requiredString(object, "denial", path), ["none", "code", "debug"], `${path}.denial`);
}

function validateAudit(input: unknown, path: string): void {
  const object = expectJsonObject(input, path);
  assertExactKeys(object, ["issuance"], path);
  expectOneOf(requiredString(object, "issuance", path), ["off", "security", "full"], `${path}.issuance`);
}

function materialForUnsigned(
  unsigned: JsonObject,
  descriptor: ObjectDescriptor,
): SignedObjectMaterial {
  const jcs = jcsCanonicalize(unsigned);
  const jcsBytes = textEncoder.encode(jcs);
  const digest = sha256Bytes(concatBytes(textEncoder.encode(`${descriptor.domain}\0`), jcsBytes));
  const id = `${descriptor.idPrefix}${base32LowerNoPad(digest)}`;
  return {
    kind: descriptor.kind,
    idField: descriptor.idField,
    id,
    domain: descriptor.domain,
    unsigned,
    jcs,
    jcsBytes,
    digest,
    digestHex: bytesToHex(digest).slice(2),
  };
}

function assertIdMatches(
  signed: JsonObject,
  material: SignedObjectMaterial,
  descriptor: ObjectDescriptor,
): void {
  const actual = requiredString(signed, descriptor.idField, "$");
  if (actual === material.id) {
    return;
  }
  if (new RegExp(`^${descriptor.idPrefix}[a-z2-7]{52}$`).test(actual)) {
    throw new SignedObjectDigestError(
      `${descriptor.idField} was not derived from the signed object digest`,
    );
  }
  throw new SignedObjectIdError(`${descriptor.idField} does not match ${descriptor.idPrefix}`);
}

function assertSigningKeyBindingForCreate(
  unsigned: JsonObject,
  signerDid: string,
): void {
  if (!hasOwn(unsigned, "signingKeyDid")) {
    return;
  }
  const signingKeyDid = requiredString(unsigned, "signingKeyDid", "$");
  if (signingKeyDid !== signerDid) {
    throw new SigningKeyBindingError(
      `signer DID ${signerDid} does not match signingKeyDid ${signingKeyDid}`,
    );
  }
}

function assertSigningKeyBindingForVerify(
  signed: JsonObject,
  signature: SignedObjectSignature,
): void {
  if (!hasOwn(signed, "signingKeyDid")) {
    return;
  }
  const signingKeyDid = requiredString(signed, "signingKeyDid", "$");
  if (signature.signerDid !== signingKeyDid) {
    throw new SigningKeyBindingError(
      `signature signerDid ${signature.signerDid} does not match signingKeyDid ${signingKeyDid}`,
    );
  }
}

function assertSignerDidMatchesSuite(
  signerDid: string,
  suite: SignatureSuite,
): void {
  if (suite === ED25519_JCS_SIGNATURE_SUITE) {
    ed25519PublicKeyFromDidKey(signerDid);
    return;
  }
  if (suite === EIP191_JCS_SIGNATURE_SUITE) {
    parseDidPkh(signerDid);
    return;
  }
  throw new UnsupportedSignatureSuiteError(`unsupported signature suite: ${suite}`);
}

async function verifySignature(
  signature: SignedObjectSignature,
  digest: Uint8Array,
): Promise<boolean> {
  if (signature.suite === ED25519_JCS_SIGNATURE_SUITE) {
    const publicKey = ed25519PublicKeyFromDidKey(signature.signerDid);
    const signatureBytes = decodeSignatureValue(signature.value, signature.suite);
    try {
      return ed25519.verify(signatureBytes, digest, publicKey);
    } catch {
      throw new SignatureVerificationError("Ed25519 signature verification failed");
    }
  }

  if (signature.suite === EIP191_JCS_SIGNATURE_SUITE) {
    const pkh = parseDidPkh(signature.signerDid);
    const signatureBytes = decodeSignatureValue(signature.value, signature.suite);
    try {
      return verifyMessage({
        address: pkh.address,
        message: { raw: digest },
        signature: bytesToHex(signatureBytes),
      });
    } catch {
      throw new SignatureVerificationError("EIP-191 signature verification failed");
    }
  }

  throw new UnsupportedSignatureSuiteError(`unsupported signature suite: ${signature.suite}`);
}

function ed25519PublicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:")) {
    throw new SignatureMaterialError("Ed25519 signerDid must be did:key");
  }
  const identifier = did.slice("did:key:".length);
  if (!identifier.startsWith("z")) {
    throw new SignatureMaterialError("did:key must use base58btc multibase");
  }
  let bytes: Uint8Array;
  try {
    bytes = bases.base58btc.decode(identifier);
  } catch {
    throw new SignatureMaterialError("did:key signerDid is undecodable");
  }
  if (bytes.length === 34 && bytes[0] === 0xed && bytes[1] === 0x01) {
    return bytes.slice(2);
  }
  throw new SignatureMaterialError("did:key signerDid is not an Ed25519 key");
}

function parseDidPkh(did: string): { address: `0x${string}` } {
  let parsed: ReturnType<typeof parsePkhDid>;
  try {
    parsed = parsePkhDid(did);
  } catch {
    throw new SignatureMaterialError("did:pkh signerDid is undecodable");
  }
  if (!parsed) {
    throw new SignatureMaterialError("EIP-191 signerDid must be did:pkh");
  }
  return { address: parsed.address };
}

function decodeSignatureValue(value: string, suite: SignatureSuite): Uint8Array {
  if (value.length === 0 || !BASE64URL_RE.test(value) || value.includes("=")) {
    throw new SignatureMaterialError("signature value must be base64url without padding");
  }
  const bytes = base64UrlDecode(value);
  if (suite === ED25519_JCS_SIGNATURE_SUITE && bytes.length !== 64) {
    throw new SignatureMaterialError("Ed25519 signature must be 64 bytes");
  }
  if (suite === EIP191_JCS_SIGNATURE_SUITE) {
    if (bytes.length !== 65) {
      throw new SignatureMaterialError("EIP-191 signature must be 65 bytes");
    }
    const v = bytes[64];
    if (v !== 27 && v !== 28) {
      throw new SignatureMaterialError("EIP-191 signature recovery id must be 27 or 28");
    }
  }
  return bytes;
}

function encodeSignatureValue(
  value: Uint8Array | string,
  suite: SignatureSuite,
): string {
  if (typeof value === "string") {
    const encoded = value.startsWith("0x")
      ? base64UrlEncode(hexToBytes(value))
      : value;
    decodeSignatureValue(encoded, suite);
    return encoded;
  }
  const encoded = base64UrlEncode(value);
  decodeSignatureValue(encoded, suite);
  return encoded;
}

function stripOwnIdAndSignature(
  object: JsonObject,
  descriptor: ObjectDescriptor,
): JsonObject {
  const output = Object.create(null) as { [key: string]: JsonValue };
  for (const [key, value] of Object.entries(object)) {
    if (key === descriptor.idField || key === "signature") {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function descriptorForUnsigned(input: unknown): ObjectDescriptor {
  const object = expectJsonObject(normalizeJson(input), "$");
  return descriptorForSchema(requiredString(object, "schema", "$"));
}

function descriptorForSchema(schema: string): ObjectDescriptor {
  if (schema === POLICY_SCHEMA) return DESCRIPTORS.Policy;
  if (schema === POLICY_STATUS_SCHEMA) return DESCRIPTORS.PolicyStatus;
  if (schema === POLICY_ENGINE_RECORD_SCHEMA) return DESCRIPTORS.PolicyEngineRecord;
  throw new SignedObjectSchemaError(`unsupported signed-object schema: ${schema}`);
}

function expectJsonObject(input: unknown, path: string): JsonObject {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SignedObjectSchemaError(`${path} must be an object`);
  }
  return input as JsonObject;
}

function assertExactKeys(object: JsonObject, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) {
      throw new SignedObjectSchemaError(`${path} has unknown field ${key}`);
    }
  }
}

function requiredValue(object: JsonObject, key: string, path: string): JsonValue {
  if (!hasOwn(object, key)) {
    throw new SignedObjectSchemaError(`${path}.${key} is required`);
  }
  return object[key];
}

function requiredString(object: JsonObject, key: string, path: string): string {
  return requireStringType(requiredValue(object, key, path), `${path}.${key}`);
}

function optionalString(object: JsonObject, key: string, path: string): void {
  if (!hasOwn(object, key)) {
    return;
  }
  requireStringType(requiredValue(object, key, path), `${path}.${key}`);
}

function requireStringType(value: JsonValue, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SignedObjectSchemaError(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(object: JsonObject, key: string, path: string): void {
  if (!hasOwn(object, key)) {
    return;
  }
  if (typeof requiredValue(object, key, path) !== "boolean") {
    throw new SignedObjectSchemaError(`${path}.${key} must be a boolean`);
  }
}

function requiredInteger(
  object: JsonObject,
  key: string,
  path: string,
  minimum: number,
): number {
  const value = requiredValue(object, key, path);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new SignedObjectSchemaError(
      `${path}.${key} must be an integer >= ${minimum}`,
    );
  }
  return value;
}

function requiredArray(
  object: JsonObject,
  key: string,
  path: string,
  minimum: number,
): readonly JsonValue[] {
  const value = requiredValue(object, key, path);
  if (!Array.isArray(value) || value.length < minimum) {
    throw new SignedObjectSchemaError(
      `${path}.${key} must be an array with at least ${minimum} item(s)`,
    );
  }
  return value;
}

function requiredStringArray(
  object: JsonObject,
  key: string,
  path: string,
  check?: (value: string, path: string) => void,
): void {
  const values = requiredArray(object, key, path, 0);
  for (let index = 0; index < values.length; index++) {
    const itemPath = `${path}.${key}[${index}]`;
    const value = requireStringType(values[index], itemPath);
    check?.(value, itemPath);
  }
}

function requiredDateString(object: JsonObject, key: string, path: string): void {
  assertRfc3339(requiredString(object, key, path), `${path}.${key}`);
}

function optionalDateString(object: JsonObject, key: string, path: string): void {
  if (!hasOwn(object, key)) {
    return;
  }
  assertRfc3339(requiredString(object, key, path), `${path}.${key}`);
}

function assertRfc3339(value: string, path: string): void {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) {
    throw new SignedObjectSchemaError(`${path} must be strict RFC 3339`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new SignedObjectSchemaError(`${path} must be a parseable RFC 3339 timestamp`);
  }
  const canonical = new Date(parsed).toISOString().replace(".000Z", "Z");
  if (canonical !== value) {
    throw new SignedObjectSchemaError(`${path} must be a normalizable RFC 3339 timestamp`);
  }
}

function expectConst<T extends string>(actual: string, expected: T, path: string): T {
  if (actual !== expected) {
    throw new SignedObjectSchemaError(`${path} must be ${expected}`);
  }
  return expected;
}

function expectOneOf<T extends string>(
  actual: string,
  allowed: readonly T[],
  path: string,
): T {
  for (const value of allowed) {
    if (actual === value) {
      return value;
    }
  }
  throw new SignedObjectSchemaError(`${path} has unsupported value ${actual}`);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return objectHasOwn(object, key);
}

function assertSupportedSignatureSuite(suite: string): asserts suite is SignatureSuite {
  if (suite !== ED25519_JCS_SIGNATURE_SUITE && suite !== EIP191_JCS_SIGNATURE_SUITE) {
    throw new UnsupportedSignatureSuiteError(`unsupported signature suite: ${suite}`);
  }
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes, "bytes");
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function base32LowerNoPad(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return output;
}

function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triplet = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    output += alphabet[(triplet >> 18) & 63];
    output += alphabet[(triplet >> 12) & 63];
    if (index + 1 < bytes.length) {
      output += alphabet[(triplet >> 6) & 63];
    }
    if (index + 2 < bytes.length) {
      output += alphabet[triplet & 63];
    }
  }
  return output;
}

function base64UrlDecode(value: string): Uint8Array {
  if (value.length % 4 === 1) {
    throw new SignatureMaterialError("signature value is not canonical base64url");
  }
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const index = alphabet.indexOf(char);
    if (index < 0) {
      throw new SignatureMaterialError("signature value is not base64url");
    }
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  const decoded = Uint8Array.from(bytes);
  if (base64UrlEncode(decoded) !== value) {
    throw new SignatureMaterialError("signature value is not canonical base64url");
  }
  return decoded;
}

function hexToBytes(value: string): Uint8Array {
  const hex = value.slice(2);
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new SignatureMaterialError("hex signature must have even length");
  }
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.length; index++) {
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}
