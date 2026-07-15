import {
  RECIPIENT_DID_SHARE_ENVELOPE_V2_DOMAIN,
  canonicalizeAddress,
  canonicalizeDid,
  jcsCanonicalize,
  pkhDid,
  verifyDidKeyEd25519Signature,
  type IWasmBindings,
  type NativeVerifiedRecipientDidDelegationBundleV2,
  type RecipientDidCacaoArtifactV2,
  type RecipientDidDelegationBundleV2,
  type RecipientDidDelegationRoutingV2,
  type RecipientDidShareDisplayV2,
  type RecipientDidShareEnvelopeV2,
  type RecipientDidShareEnvelopeV2SigningPayload,
  type RecipientDidShareTargetV2,
  type RecipientDidUcanArtifactV2,
  type TinyCloudSession,
} from "@tinycloud/sdk-core";

import type { PortableDelegation } from "./delegation";

const RAW_CODEC = 0x55n;
const RECIPIENT_READ_ACTION = "tinycloud.kv/get";
const DNS_HOSTNAME_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface SignShareEnvelopeV2Input {
  readonly version: 2;
  readonly shareId: string;
  readonly delegation: {
    readonly routing: RecipientDidDelegationRoutingV2;
    readonly grant: PortableDelegation;
  };
  readonly authorizationTarget: {
    readonly kind: "recipientDid";
    readonly did: string;
  };
  readonly target: RecipientDidShareTargetV2;
  readonly display: RecipientDidShareDisplayV2;
  readonly expiry: string;
}

export interface SignShareEnvelopeV2Result {
  readonly envelope: RecipientDidShareEnvelopeV2;
  readonly signerDid: string;
  readonly signature: string;
  readonly issuerProofs: readonly [RecipientDidCacaoArtifactV2];
}

interface SignShareEnvelopeV2Context {
  readonly session: TinyCloudSession;
  readonly wasm: IWasmBindings;
  signBytes(bytes: Uint8Array): Promise<Uint8Array>;
}

export class RecipientDidSharingError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "SESSION_NOT_OWNER_ROOT"
    | "DELEGATION_MISMATCH"
    | "NATIVE_VERIFIER_UNAVAILABLE";

  constructor(code: RecipientDidSharingError["code"], message: string) {
    super(message);
    this.name = "RecipientDidSharingError";
    this.code = code;
  }
}

/** @internal Fixed-purpose implementation used only by TinyCloudNode. */
export async function signShareEnvelopeV2WithSession(
  input: SignShareEnvelopeV2Input,
  context: SignShareEnvelopeV2Context,
): Promise<SignShareEnvelopeV2Result> {
  const { session, wasm } = context;
  const normalizedInput: SignShareEnvelopeV2Input = {
    ...input,
    expiry: canonicalWholeSecondExpiry(input.expiry),
  };
  const signerDid = sessionPrincipalFromVerificationMethod(
    session.verificationMethod,
  );
  assertEnvelopeFields(normalizedInput, session);

  const computeCid = wasm.computeCid;
  if (!computeCid) {
    throw new RecipientDidSharingError(
      "SESSION_NOT_OWNER_ROOT",
      "Recipient-DID sharing requires native delegation CID computation",
    );
  }

  const cacaoBytes = decodeCanonicalCacaoAuthorization(
    session.delegationHeader.Authorization,
  );
  const cacaoCid = computeCid(cacaoBytes, RAW_CODEC);
  if (cacaoCid !== session.delegationCid) {
    throw new RecipientDidSharingError(
      "SESSION_NOT_OWNER_ROOT",
      "Active session Cacao CID does not match its signed authorization bytes",
    );
  }
  const cacao: RecipientDidCacaoArtifactV2 = {
    kind: "cacao",
    cid: cacaoCid,
    encoding: "dag-cbor-base64url-pad",
    value: paddedBase64Url(cacaoBytes),
  };

  const grant = recipientGrantArtifact(
    normalizedInput.delegation.grant,
    computeCid,
  );
  assertRecipientGrantClaims(
    grant.value,
    normalizedInput,
    session,
    signerDid,
    cacaoCid,
  );

  const issuerProofs = [cacao] as const;
  const bundle: RecipientDidDelegationBundleV2 = {
    format: "tinycloud-recipient-delegation-v2",
    routing: {
      origin: normalizedInput.delegation.routing.origin,
      nodeAudience: normalizedInput.delegation.routing.nodeAudience,
    },
    grant,
    issuerProofs,
  };
  const payload: RecipientDidShareEnvelopeV2SigningPayload = {
    version: 2,
    shareId: normalizedInput.shareId,
    delegation: bundle,
    authorizationTarget: {
      kind: "recipientDid",
      did: normalizedInput.authorizationTarget.did,
    },
    target: {
      origin: normalizedInput.target.origin,
      nodeAudience: normalizedInput.target.nodeAudience,
      spaceId: normalizedInput.target.spaceId,
      resource: { kind: "exact", path: normalizedInput.target.resource.path },
      actions: [...normalizedInput.target.actions],
    },
    display: copyDisplay(normalizedInput.display),
    expiry: normalizedInput.expiry,
    signature: { signerDid, algorithm: "Ed25519" },
  };
  const signatureBytes = await context.signBytes(signingBytes(payload));
  if (signatureBytes.length !== 64) {
    throw new RecipientDidSharingError(
      "SESSION_NOT_OWNER_ROOT",
      "Active session signer did not return a 64-byte Ed25519 signature",
    );
  }
  const signature = base64UrlEncode(signatureBytes);
  return {
    envelope: {
      ...payload,
      signature: { ...payload.signature, value: signature },
    },
    signerDid,
    signature,
    issuerProofs,
  };
}

/**
 * Invoke the atomic native authority verifier, failing closed while the
 * corresponding tinycloud-node/WASM primitive is unavailable.
 */
export function verifyRecipientDidDelegationBundleV2Native(
  wasm: IWasmBindings,
  bundle: RecipientDidDelegationBundleV2,
  now: Date,
): NativeVerifiedRecipientDidDelegationBundleV2 {
  const verify = wasm.verifyRecipientDidDelegationBundleV2;
  if (!verify) {
    throw new RecipientDidSharingError(
      "NATIVE_VERIFIER_UNAVAILABLE",
      "This SDK runtime does not provide atomic recipient-DID delegation verification",
    );
  }
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RecipientDidSharingError(
      "INVALID_INPUT",
      "now must be a valid Date",
    );
  }
  return verify(bundle, BigInt(Math.floor(milliseconds / 1000)));
}

function canonicalWholeSecondExpiry(value: string): string {
  const expiry = new Date(value);
  if (Number.isNaN(expiry.getTime()) || expiry.toISOString() !== value) {
    throw new RecipientDidSharingError(
      "INVALID_INPUT",
      "expiry must be a canonical ISO-8601 UTC instant",
    );
  }
  return new Date(Math.floor(expiry.getTime() / 1000) * 1000).toISOString();
}

function assertEnvelopeFields(
  input: SignShareEnvelopeV2Input,
  session: TinyCloudSession,
): void {
  if (
    input.version !== 2 ||
    typeof input.shareId !== "string" ||
    input.shareId.length === 0
  ) {
    invalid(
      "Expected recipient-DID share envelope version 2 and a non-empty shareId",
    );
  }
  assertCanonicalRecipientDid(input.authorizationTarget.did);
  if (input.authorizationTarget.kind !== "recipientDid") {
    invalid("authorizationTarget must be recipientDid");
  }
  assertRouting(input.delegation.routing);
  assertRouting({
    origin: input.target.origin,
    nodeAudience: input.target.nodeAudience,
  });
  if (
    input.delegation.routing.origin !== input.target.origin ||
    input.delegation.routing.nodeAudience !== input.target.nodeAudience
  ) {
    invalid("Delegation routing and target routing must match exactly");
  }

  const grant = input.delegation.grant;
  if (grant.host !== input.target.origin) {
    mismatch("Portable delegation host must equal the signed target origin");
  }
  if (grant.delegateDID !== input.authorizationTarget.did) {
    mismatch(
      "Portable delegation audience must equal the signed recipient DID",
    );
  }
  if (grant.spaceId !== input.target.spaceId) {
    mismatch("Portable delegation space must equal the signed target space");
  }
  if (
    input.target.resource.kind !== "exact" ||
    !isCanonicalResourcePath(input.target.resource.path) ||
    grant.path !== input.target.resource.path
  ) {
    mismatch(
      "Portable delegation path must equal the canonical exact target path",
    );
  }
  if (
    input.target.actions.length !== 1 ||
    input.target.actions[0] !== RECIPIENT_READ_ACTION ||
    grant.actions.length !== 1 ||
    grant.actions[0] !== RECIPIENT_READ_ACTION
  ) {
    mismatch("Recipient-DID v2 requires exactly tinycloud.kv/get");
  }
  if (grant.disableSubDelegation === true) {
    mismatch(
      "Recipient grant must remain usable as the holder's invocation parent",
    );
  }

  const expiry = new Date(input.expiry);
  if (
    Number.isNaN(expiry.getTime()) ||
    expiry.toISOString() !== input.expiry ||
    grant.expiry.toISOString() !== input.expiry ||
    expiry.getTime() <= Date.now()
  ) {
    mismatch(
      "Envelope and portable delegation expiry must be equal, canonical, and future",
    );
  }

  if (session.chainId !== 1 || grant.chainId !== 1) {
    invalid("Recipient-DID v2 supports EIP-155 chain 1 only");
  }
  const ownerDid = pkhDid(canonicalizeAddress(session.address), 1);
  if (canonicalizeDid(ownerDid) !== ownerDid) {
    invalid("Active session owner DID is not canonical");
  }
  if (
    canonicalizeAddress(grant.ownerAddress) !==
    canonicalizeAddress(session.address)
  ) {
    mismatch(
      "Portable delegation owner does not match the active session owner",
    );
  }
  const expectedSpacePrefix = `tinycloud:pkh:eip155:1:${ownerDid.slice(ownerDid.lastIndexOf(":") + 1)}:`;
  const spaceName = input.target.spaceId.slice(expectedSpacePrefix.length);
  if (
    !input.target.spaceId.startsWith(expectedSpacePrefix) ||
    !/^[A-Za-z0-9_-]+$/.test(spaceName)
  ) {
    mismatch("Signed target space is not owned by the active session owner");
  }
  assertDisplay(input.display);
}

function recipientGrantArtifact(
  delegation: PortableDelegation,
  computeCid: NonNullable<IWasmBindings["computeCid"]>,
): RecipientDidUcanArtifactV2 {
  const value = delegation.delegationHeader.Authorization.replace(
    /^Bearer /i,
    "",
  );
  decodeCanonicalJwt(value);
  const computed = computeCid(new TextEncoder().encode(value), RAW_CODEC);
  if (computed !== delegation.cid) {
    mismatch("Recipient grant CID does not match its signed UCAN bytes");
  }
  return { kind: "ucan", cid: computed, encoding: "jwt", value };
}

function assertRecipientGrantClaims(
  jwt: string,
  input: SignShareEnvelopeV2Input,
  session: TinyCloudSession,
  signerDid: string,
  cacaoCid: string,
): void {
  const payload = decodeCanonicalJwt(jwt);
  const segments = jwt.split(".");
  const header = decodeCanonicalJsonObject(segments[0], "header");
  if (header.alg !== "EdDSA") {
    mismatch("Recipient grant JWT must use EdDSA");
  }
  const signature = base64UrlDecode(segments[2]);
  if (
    signature.length !== 64 ||
    !verifyDidKeyEd25519Signature(
      signerDid,
      new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
      signature,
    )
  ) {
    mismatch(
      "Recipient grant JWT signature is not valid for the active session signer",
    );
  }
  const issuer = requiredString(payload, "iss");
  if (sessionPrincipalFromVerificationMethod(issuer) !== signerDid) {
    mismatch("Recipient grant issuer must be the active session signer");
  }
  if (requiredString(payload, "aud") !== input.authorizationTarget.did) {
    mismatch("Recipient grant JWT audience does not match authorizationTarget");
  }
  const proofs = payload.prf;
  if (!Array.isArray(proofs) || proofs.length !== 1 || proofs[0] !== cacaoCid) {
    throw new RecipientDidSharingError(
      "SESSION_NOT_OWNER_ROOT",
      "Recipient grant must be directly parented by the active owner Cacao",
    );
  }
  const exp = payload.exp;
  if (
    !Number.isSafeInteger(exp) ||
    new Date((exp as number) * 1000).toISOString() !== input.expiry
  ) {
    mismatch(
      "Recipient grant JWT expiry does not match the signed envelope expiry",
    );
  }
  if (
    typeof payload.nbf === "number" &&
    payload.nbf > Math.floor(Date.now() / 1000)
  ) {
    mismatch("Recipient grant is not active yet");
  }

  const expectedResource = `${input.target.spaceId}/kv/${input.target.resource.path}`;
  const attenuation = payload.att;
  if (!isPlainObject(attenuation) || Object.keys(attenuation).length !== 1) {
    mismatch("Recipient grant must contain exactly one attenuated resource");
  }
  const abilities = attenuation[expectedResource];
  if (!isPlainObject(abilities) || Object.keys(abilities).length !== 1) {
    mismatch(
      "Recipient grant resource does not exactly match the signed target",
    );
  }
  const caveats = abilities[RECIPIENT_READ_ACTION];
  if (
    !Array.isArray(caveats) ||
    caveats.length !== 1 ||
    !isPlainObject(caveats[0]) ||
    Object.keys(caveats[0]).length !== 0
  ) {
    mismatch(
      "Recipient grant must contain only an uncaveated tinycloud.kv/get ability",
    );
  }
}

function signingBytes(
  payload: RecipientDidShareEnvelopeV2SigningPayload,
): Uint8Array {
  return concatBytes(
    new TextEncoder().encode(RECIPIENT_DID_SHARE_ENVELOPE_V2_DOMAIN),
    new TextEncoder().encode(jcsCanonicalize(payload)),
  );
}

function assertCanonicalRecipientDid(did: string): void {
  let canonical: string;
  try {
    canonical = canonicalizeDid(did);
  } catch {
    invalid("Recipient DID is invalid");
  }
  if (!did.startsWith("did:pkh:eip155:1:") || canonical! !== did) {
    invalid("Recipient DID must be the exact canonical chain-1 did:pkh");
  }
}

function assertRouting(routing: RecipientDidDelegationRoutingV2): void {
  let url: URL;
  try {
    url = new URL(routing.origin);
  } catch {
    invalid("Recipient-DID route origin is invalid");
  }
  if (
    url!.protocol !== "https:" ||
    url!.origin !== routing.origin ||
    url!.port !== "" ||
    !DNS_HOSTNAME_RE.test(url!.hostname) ||
    isIpv4Literal(url!.hostname) ||
    routing.nodeAudience !== `did:web:${url!.hostname}`
  ) {
    invalid(
      "Recipient-DID route must be canonical HTTPS with its exact did:web audience",
    );
  }
}

function assertDisplay(display: RecipientDidShareDisplayV2): void {
  for (const value of [
    display.senderName,
    display.filename,
    display.recipientHint,
  ]) {
    if (value !== undefined && typeof value !== "string") {
      invalid("Share display text fields must be strings");
    }
  }
  if (
    display.mode !== undefined &&
    display.mode !== "document" &&
    display.mode !== "source" &&
    display.mode !== "folder"
  ) {
    invalid("Share display mode is invalid");
  }
}

function copyDisplay(
  display: RecipientDidShareDisplayV2,
): RecipientDidShareDisplayV2 {
  return {
    ...(display.senderName !== undefined
      ? { senderName: display.senderName }
      : {}),
    ...(display.filename !== undefined ? { filename: display.filename } : {}),
    ...(display.recipientHint !== undefined
      ? { recipientHint: display.recipientHint }
      : {}),
    ...(display.mode !== undefined ? { mode: display.mode } : {}),
  };
}

function sessionPrincipalFromVerificationMethod(value: string): string {
  const match = value.match(
    /^(did:key:(z[1-9A-HJ-NP-Za-km-z]+))#(z[1-9A-HJ-NP-Za-km-z]+)$/,
  );
  if (!match || match[2] !== match[3]) {
    throw new RecipientDidSharingError(
      "SESSION_NOT_OWNER_ROOT",
      "Active session must use the canonical did:key verification method",
    );
  }
  return match[1];
}

function decodeCanonicalCacaoAuthorization(value: string): Uint8Array {
  const encoded = value.replace(/^Bearer /i, "");
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new RecipientDidSharingError(
      "SESSION_NOT_OWNER_ROOT",
      "Active session authorization is not canonical padded base64url Cacao",
    );
  }
  const unpadded = encoded.replace(/=+$/, "");
  const bytes = base64UrlDecode(unpadded);
  if (paddedBase64Url(bytes) !== encoded) {
    throw new RecipientDidSharingError(
      "SESSION_NOT_OWNER_ROOT",
      "Active session authorization is not canonical padded base64url Cacao",
    );
  }
  return bytes;
}

function decodeCanonicalJwt(jwt: string): Record<string, unknown> {
  const segments = jwt.split(".");
  if (
    segments.length !== 3 ||
    segments.some((segment) => segment.length === 0)
  ) {
    mismatch("Recipient grant is not a compact UCAN JWT");
  }
  for (const segment of segments) {
    const decoded = base64UrlDecode(segment);
    if (base64UrlEncode(decoded) !== segment) {
      mismatch(
        "Recipient grant JWT segments must be canonical unpadded base64url",
      );
    }
  }
  return decodeCanonicalJsonObject(segments[1], "payload");
}

function decodeCanonicalJsonObject(
  segment: string,
  label: "header" | "payload",
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(segment)),
    );
    if (!isPlainObject(parsed))
      mismatch(`Recipient grant JWT ${label} must be an object`);
    return parsed;
  } catch (error) {
    if (error instanceof RecipientDidSharingError) throw error;
    mismatch(`Recipient grant JWT ${label} is invalid JSON`);
  }
}

function requiredString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    mismatch(`Recipient grant JWT ${key} claim is missing`);
  }
  return value;
}

function isCanonicalResourcePath(value: string): boolean {
  if (value.length === 0 || /[\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (/%2f|%5c|%2e/i.test(value)) return false;
  return value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isIpv4Literal(hostname: string): boolean {
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
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
    if (index + 1 < bytes.length) output += alphabet[(triplet >> 6) & 63];
    if (index + 2 < bytes.length) output += alphabet[triplet & 63];
  }
  return output;
}

function base64UrlDecode(value: string): Uint8Array {
  if (
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length % 4 === 1
  ) {
    mismatch("Expected canonical base64url data");
  }
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    buffer = (buffer << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function paddedBase64Url(bytes: Uint8Array): string {
  const unpadded = base64UrlEncode(bytes);
  return `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
}

function invalid(message: string): never {
  throw new RecipientDidSharingError("INVALID_INPUT", message);
}

function mismatch(message: string): never {
  throw new RecipientDidSharingError("DELEGATION_MISMATCH", message);
}
