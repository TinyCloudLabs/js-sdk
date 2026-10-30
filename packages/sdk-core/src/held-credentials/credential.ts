import { sha256, verifyEd25519Strict } from "./crypto";
import { canonicalPkhDid, parsePkhDid, pkhPrincipalsEqual, registryKey, type PkhDid } from "./did";
import { asciiBytes, decodeBase64Url, decodeUtf8, encodeBase64Url, isAscii, isObject, parseStrictJson, type Json } from "./encoding";
import { refuse } from "./errors";
import { IssuerSet, didMethod, isWellFormedKid, lookupIssuerEntry, type IssuerEntry } from "./issuer-set";
import { EMAIL_HELD_ROW, findRow, rowPermitsIssuer, type ProfileRow } from "./rows";

export interface AcceptedIssuer { issuerDid: string; kid?: string }
export interface AcceptedProfile { profile: string; profileVersion: number }

export interface VerifiedHeldCredential {
  issuer: string;
  subject: string;
  /** Lowercase 20-byte address; equals `registryKey(subject)`. */
  subjectAddress: string;
  expiresAt: Date;
  credentialId: string;
  profile: string;
  profileVersion: number;
  vct: string;
  claims: Record<string, Json>;
}

const SHARED_SIGNED = new Set(["iss", "sub", "iat", "nbf", "exp", "jti", "vct", "profile", "profileVersion", "holderBinding", "status", "_sd_alg", "_sd"]);
const RESERVED_CLAIMS = new Set([...SHARED_SIGNED, "...", "cnf"]);

/** Size limits, enforced on the raw strings before any decoding or parsing (TC-1540). */
export const HELD_LIMITS = {
  sdJwtChars: 16384,
  siweMessageChars: 2048,
  siweSignatureChars: 132,
  disclosures: 8,
  disclosureChars: 1024,
  headerSegmentChars: 1024,
  payloadSegmentChars: 4096,
  signatureSegmentChars: 128,
} as const;

const HEADER_MEMBERS = new Set(["alg", "typ", "kid"]);
const JTI_UUID_V4 = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Base64url of SHA-256 over the ASCII bytes of the whole SD-JWT text (the sd_hash the SIWE resource binds). */
export function sdHash(sdJwt: string): string {
  if (typeof sdJwt !== "string" || !isAscii(sdJwt)) refuse("bad-presentation", "sdJwt must be an ASCII string");
  return encodeBase64Url(sha256(asciiBytes(sdJwt)));
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Already-validated policy. The caller checks `now`, `issuerSet`, and the list shapes first. */
export interface HeldCredentialPolicy {
  now: Date;
  issuerSet: IssuerSet;
  acceptedIssuers: readonly AcceptedIssuer[];
  acceptedProfiles: readonly AcceptedProfile[];
  didMethods: { issuer: readonly string[] };
  rows: readonly ProfileRow[];
}

/** Output of the signed-credential checks. The subject is not yet tied to a SIWE proof or a caller. */
export interface CheckedHeldCredential {
  issuer: string;
  /** The `sub` claim as signed (already a valid eip155 did:pkh on the row's chain). */
  subject: string;
  subjectPkh: PkhDid;
  expiresAt: Date;
  credentialId: string;
  profile: string;
  profileVersion: number;
  vct: string;
  claims: Record<string, Json>;
}

/**
 * Spec §4.4 steps 2 to 9 for an SD-JWT that has already passed the caller's size checks: header,
 * policy selection, issuer signature, claims, profile row, and disclosures. Does not spend nonces,
 * read SIWE, or compare the subject with a caller. Throws a HeldCredentialError on the first failure.
 */
export function checkHeldCredential(sdJwtText: string, policy: HeldCredentialPolicy): CheckedHeldCredential {
  const { now, issuerSet, acceptedIssuers, acceptedProfiles, didMethods, rows } = policy;
  const parts = sdJwtText.split("~");
  if (parts.length < 2 || parts[parts.length - 1] !== "") refuse("bad-presentation", "sdJwt must end with ~ and carry no key-binding JWT");
  const [jwt, ...disclosureParts] = parts.slice(0, -1) as [string, ...string[]];
  if (disclosureParts.some((d) => d === "")) refuse("bad-presentation", "empty disclosure");
  if (disclosureParts.length > HELD_LIMITS.disclosures) refuse("bad-presentation", "too many disclosures");
  if (disclosureParts.some((d) => d.length > HELD_LIMITS.disclosureChars)) refuse("bad-presentation", "disclosure is too long");
  const segments = jwt.split(".");
  if (segments.length !== 3 || segments.some((s) => s === "")) refuse("bad-presentation", "JWT must have three segments");
  const [headerB64, payloadB64, signatureB64] = segments as [string, string, string];
  if (headerB64.length > HELD_LIMITS.headerSegmentChars || payloadB64.length > HELD_LIMITS.payloadSegmentChars || signatureB64.length > HELD_LIMITS.signatureSegmentChars) refuse("bad-presentation", "JWT segment is too long");

  // protected header only
  const header = parseStrictJson(decodeUtf8(decodeBase64Url(headerB64, "bad-header"), "bad-header"), "bad-header");
  if (!isObject(header)) refuse("bad-header", "header must be an object");
  for (const member of Object.keys(header)) if (!HEADER_MEMBERS.has(member)) refuse("bad-header", `unexpected header member ${member}`);
  if (header.alg !== "EdDSA") refuse("bad-header", "alg must be EdDSA");
  if (header.typ !== "vc+sd-jwt") refuse("bad-header", "typ must be vc+sd-jwt");
  const kid = header.kid;
  if (typeof kid !== "string") refuse("bad-header", "kid is required");
  const hash = (kid as string).indexOf("#");
  if (hash < 1) refuse("bad-header", "kid must be a DID URL with a fragment");
  const issuerDid = (kid as string).slice(0, hash);
  if (!isWellFormedKid(kid as string, issuerDid)) refuse("bad-header", "kid must be issuerDid#fragment");
  const method = didMethod(issuerDid);
  if (method === null || !didMethods.issuer.includes(method)) refuse("did-method-not-allowed", `issuer DID method ${method} is not on the allow-list`);

  // policy selection: the presenter never chooses the issuer
  if (!acceptedIssuers.some((a) => a.issuerDid === issuerDid && (a.kid === undefined || a.kid === kid))) refuse("issuer-not-accepted", "issuer is not accepted by this policy");

  // entry lookup by the exact pair, then the checks that need only `now`
  const entry: IssuerEntry | undefined = lookupIssuerEntry(issuerSet, issuerDid, kid as string);
  if (!entry) refuse("unknown-issuer", "no issuer-set entry for this kid");
  if (entry.issuerDid !== issuerDid || entry.kid !== kid) refuse("unknown-issuer", "resolved entry is not the requested (issuerDid, kid)");
  const nowMs = now.getTime();
  if (nowMs < entry.notBefore) refuse("issuer-not-yet-valid", "issuer key is not yet valid");
  if (entry.notAfter !== null && nowMs >= entry.notAfter) refuse("issuer-stopped", "issuer key is past its hard stop");

  // signature
  const signature = decodeBase64Url(signatureB64, "bad-signature");
  if (!verifyEd25519Strict(signature, asciiBytes(`${headerB64}.${payloadB64}`), entry.publicKey)) refuse("bad-signature", "issuer signature did not verify");

  // only now decode the payload
  const payload = parseStrictJson(decodeUtf8(decodeBase64Url(payloadB64, "bad-payload"), "bad-payload"), "bad-payload");
  if (!isObject(payload)) refuse("bad-payload", "payload must be an object");
  if (payload.iss !== issuerDid) refuse("bad-payload", "iss must equal the DID part of kid");
  const { iat, nbf, exp } = payload;
  if (!isSafeInt(iat)) refuse("bad-payload", "iat is required");
  if (!isSafeInt(nbf) || nbf !== iat) refuse("bad-payload", "nbf must equal iat");
  if (!isSafeInt(exp)) refuse("bad-payload", "exp is required");
  if (entry.notBefore > (iat as number) * 1000) refuse("issuer-not-yet-valid", "credential predates the issuer key");
  if (entry.retiredAt !== null && (iat as number) * 1000 >= entry.retiredAt) refuse("issuer-retired", "issued at or after the issuer key was retired");

  // profile row and admission
  if (typeof payload.profile !== "string" || !isSafeInt(payload.profileVersion) || typeof payload.vct !== "string") refuse("bad-payload", "profile, profileVersion and vct are required");
  const profile = payload.profile as string, profileVersion = payload.profileVersion as number, vct = payload.vct as string;
  const row = findRow(rows, profile, profileVersion);
  if (!row) refuse("profile-mismatch", "unknown profile");
  if (!acceptedProfiles.some((p) => p.profile === profile && p.profileVersion === profileVersion)) refuse("profile-not-accepted", "profile is not accepted by this caller");
  if (row.vct !== vct) refuse("profile-mismatch", "vct is not the row's vct");
  if (!entry.vcts.includes(vct) || !entry.profiles.includes(profile)) refuse("profile-mismatch", "issuer entry does not admit this vct and profile");
  if (!rowPermitsIssuer(row, issuerDid)) refuse("issuer-not-accepted", "this profile row does not permit the issuer DID");

  // claims against the row
  for (const key of Object.keys(payload)) {
    if (!SHARED_SIGNED.has(key) && !row.optionalSignedClaims.includes(key)) refuse("bad-payload", `unexpected claim ${key}`);
  }
  if (payload._sd_alg !== "sha-256") refuse("bad-payload", "_sd_alg must be sha-256");
  if (!Array.isArray(payload._sd) || payload._sd.some((d) => typeof d !== "string")) refuse("bad-payload", "_sd must be a list of digests");
  if (new Set(payload._sd as string[]).size !== payload._sd.length) refuse("bad-payload", "_sd must not repeat a digest (RFC 9901 section 7.1)");
  const nowSeconds = nowMs / 1000;
  if (nowSeconds < (nbf as number)) refuse("not-yet-valid", "credential is not yet valid");
  if (nowSeconds >= (exp as number)) refuse("expired", "credential has expired");
  const lifetime = (exp as number) - (iat as number);
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > row.maxLifetimeSeconds) refuse("bad-lifetime", "exp - iat is outside the row's lifetime");
  if (typeof payload.jti !== "string" || !JTI_UUID_V4.test(payload.jti)) refuse("bad-payload", "jti must be a urn:uuid v4");
  const status = payload.status;
  if (!isObject(status) || Object.keys(status).join() !== "method" || typeof status.method !== "string" || !row.statusMethods.includes(status.method)) refuse("bad-status", "status method is not accepted");
  const subject = payload.sub;
  const subjectPkh = parsePkhDid(subject);
  if (!subjectPkh || typeof subject !== "string" || subjectPkh.chainId !== row.holder.chainId) refuse("bad-subject", "sub is not an eip155 did:pkh on the row's chain");
  const binding = payload.holderBinding;
  if (!isObject(binding) || Object.keys(binding).sort().join() !== "did,signingDomain" || binding.signingDomain !== row.bindingDomain || !pkhPrincipalsEqual(binding.did, subject)) refuse("bad-holder-binding", "holderBinding does not match the row and sub");

  // disclosures
  const digests = new Set(payload._sd as string[]);
  const seen = new Set<string>();
  const claims: Record<string, Json> = {};
  for (const disclosure of disclosureParts) {
    const digest = encodeBase64Url(sha256(asciiBytes(disclosure)));
    if (!digests.has(digest)) refuse("bad-disclosure", "disclosure digest is not in _sd");
    if (seen.has(digest)) refuse("bad-disclosure", "repeated disclosure");
    seen.add(digest);
    const decoded = parseStrictJson(decodeUtf8(decodeBase64Url(disclosure, "bad-disclosure"), "bad-disclosure"), "bad-disclosure");
    if (!Array.isArray(decoded) || decoded.length !== 3 || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") refuse("bad-disclosure", "disclosure must be [salt, name, value]");
    const [, name, value] = decoded as [string, string, Json];
    if (RESERVED_CLAIMS.has(name) || row.optionalSignedClaims.includes(name)) refuse("bad-disclosure", "claim name collides with a signed claim");
    if (!row.disclosable.includes(name)) refuse("bad-disclosure", "claim is not disclosable for this profile");
    if (typeof value !== "string") refuse("bad-disclosure", "disclosed value must be a string (no nested _sd or array elements)");
    if (Object.prototype.hasOwnProperty.call(claims, name)) refuse("bad-disclosure", "claim disclosed twice");
    claims[name] = value;
  }
  row.validateDisclosed(claims);

  return {
    issuer: issuerDid,
    subject,
    subjectPkh,
    expiresAt: new Date((exp as number) * 1000),
    credentialId: payload.jti as string,
    profile,
    profileVersion,
    vct,
    claims,
  };
}

/** Public result shape. The subject is canonical and the address is the registry key. */
export function toVerifiedCredential(checked: CheckedHeldCredential): VerifiedHeldCredential {
  return {
    issuer: checked.issuer,
    subject: canonicalPkhDid(checked.subject) as string,
    subjectAddress: registryKey(checked.subject),
    expiresAt: checked.expiresAt,
    credentialId: checked.credentialId,
    profile: checked.profile,
    profileVersion: checked.profileVersion,
    vct: checked.vct,
    claims: checked.claims,
  };
}

export interface HeldEmailCredentialOptions {
  /** Explicit clock. The verifier never reads one. */
  now: Date;
  issuerSet: IssuerSet;
  /** From the owner-signed policy or the caller's allow-list. Empty is refused. */
  acceptedIssuers: readonly AcceptedIssuer[];
  /** Issuer methods the caller enables, e.g. ["web"]. */
  didMethods: { issuer: readonly string[] };
  /** The authenticated owner (`did:pkh:eip155:...`). The credential subject must be principal-equal to it. */
  owner: string;
}

/**
 * Verifies a held email credential on its own. No presentation proof and no nonce: the caller must
 * already hold the SD-JWT and have authenticated `owner`. Refuses an owner mismatch with the same
 * code as the presentation path. Synchronous; the email row is fixed.
 * The code `nonce-account-mismatch` is kept for parity with the presentation path. This path spends no nonce.
 */
export function verifyHeldEmailCredential(sdJwt: unknown, options: HeldEmailCredentialOptions): VerifiedHeldCredential {
  const { now, issuerSet, acceptedIssuers, didMethods, owner } = options;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) refuse("bad-config", "now must be a valid Date");
  if (!IssuerSet.is(issuerSet)) refuse("bad-config", "issuerSet must come from parseIssuerSet");
  if (!didMethods || !Array.isArray(didMethods.issuer)) refuse("bad-config", "didMethods is required");
  if (!Array.isArray(acceptedIssuers) || acceptedIssuers.length === 0) refuse("bad-config", "acceptedIssuers must not be empty");
  if (parsePkhDid(owner) === null) refuse("bad-config", "owner must be a did:pkh:eip155 account");
  if (typeof sdJwt !== "string" || !isAscii(sdJwt)) refuse("bad-presentation", "sdJwt must be an ASCII string");
  if (sdJwt.length > HELD_LIMITS.sdJwtChars) refuse("bad-presentation", "sdJwt is too long");

  const checked = checkHeldCredential(sdJwt, {
    now, issuerSet, acceptedIssuers, didMethods,
    acceptedProfiles: [{ profile: EMAIL_HELD_ROW.profile, profileVersion: EMAIL_HELD_ROW.profileVersion }],
    rows: [EMAIL_HELD_ROW],
  });
  if (!pkhPrincipalsEqual(owner, checked.subject)) refuse("nonce-account-mismatch", "subject is not the authenticated owner");
  return toVerifiedCredential(checked);
}

/**
 * Structural selective disclosure: keeps only the disclosures named in `names`, in their original
 * order, and drops any key-binding suffix. It does not verify anything. Verify the full SD-JWT
 * first; this function only re-shapes a verified presentation.
 */
export function selectDisclosures(sdJwt: string, names: readonly string[]): string {
  if (typeof sdJwt !== "string") refuse("bad-presentation", "sdJwt must be a string");
  if (names.length === 0 || new Set(names).size !== names.length) refuse("bad-config", "names must be non-empty and unique");
  const parts = sdJwt.split("~");
  if (parts.length < 2 || parts[parts.length - 1] !== "") refuse("bad-presentation", "sdJwt must end with ~ and carry no key-binding JWT");
  const [jwt, ...disclosures] = parts.slice(0, -1) as [string, ...string[]];
  const kept: string[] = [];
  const found = new Set<string>();
  for (const disclosure of disclosures) {
    const decoded = parseStrictJson(decodeUtf8(decodeBase64Url(disclosure, "bad-disclosure"), "bad-disclosure"), "bad-disclosure");
    if (!Array.isArray(decoded) || decoded.length !== 3 || typeof decoded[1] !== "string") refuse("bad-disclosure", "disclosure must be [salt, name, value]");
    const name = decoded[1] as string;
    if (names.includes(name)) {
      if (found.has(name)) refuse("bad-disclosure", `duplicate disclosure for ${name}`);
      kept.push(disclosure);
      found.add(name);
    }
  }
  for (const name of names) if (!found.has(name)) refuse("bad-disclosure", `no disclosure for ${name}`);
  return [jwt, ...kept, ""].join("~");
}
