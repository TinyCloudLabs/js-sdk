import { recoverEip191Address, sha256, verifyEd25519Strict } from "./crypto";
import { canonicalPkhDid, parsePkhDid, pkhPrincipalsEqual, registryKey } from "./did";
import { asciiBytes, decodeBase64Url, decodeUtf8, encodeBase64Url, hexToBytes, isAscii, isObject, parseStrictJson, type Json } from "./encoding";
import { refuse } from "./errors";
import { IssuerSet, didMethod, lookupIssuerEntry, isWellFormedKid, type IssuerEntry } from "./issuer-set";
import type { NonceStore } from "./nonce-store";
import { DEFAULT_ROWS, findRow, type ProfileRow } from "./rows";
import { PRESENTATION_STATEMENT, SD_HASH_RESOURCE_PREFIX, assertValidAudience, parseRfc3339, parseStrictSiwe } from "./siwe";


export interface HeldPresentation {
  sdJwt: string;
  siwe: { message: string; signature: string };
}

export interface AcceptedIssuer { issuerDid: string; kid?: string }
export interface AcceptedProfile { profile: string; profileVersion: number }

export interface VerifyHeldPresentationOptions {
  /** Explicit clock. The verifier never reads one. */
  now: Date;
  issuerSet: IssuerSet;
  /** From the owner-signed policy or the caller's allow-list. Empty is refused. */
  acceptedIssuers: readonly AcceptedIssuer[];
  /** Empty is refused. */
  acceptedProfiles: readonly AcceptedProfile[];
  /** docs/principles.md principle 2. Issuer methods the caller enables, e.g. ["web"]. */
  didMethods: { issuer: readonly string[] };
  /** This verifier's own EIP-4361 domain (an authority). One distinct audience per verifier. */
  audience: string;
  nonceStore: NonceStore;
  /**
   * The authenticated caller's account (`did:pkh:eip155:...`). Nonces are minted bound to it, and
   * `subject` must be principal-equal to it. A presentation is not authentication (spec §4).
   */
  callerAccount: string;
  /** Defaults to the email row. */
  rows?: readonly ProfileRow[];
}

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

function sdHash(sdJwt: string): string {
  return encodeBase64Url(sha256(asciiBytes(sdJwt)));
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Verifies a held-credential presentation (spec §4.4). Fail closed: the first failed check throws a
 * HeldCredentialError. The caller-bound nonce is spent first, on any outcome. No payload claim is read before the issuer signature has verified.
 */
export async function verifyHeldPresentation(presentation: unknown, options: VerifyHeldPresentationOptions): Promise<VerifiedHeldCredential> {
  // 1. shape and inputs (nothing is looked up yet)
  const { now, issuerSet, acceptedIssuers, acceptedProfiles, didMethods, audience, nonceStore, callerAccount } = options;
  const rows = options.rows ?? DEFAULT_ROWS;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) refuse("bad-config", "now must be a valid Date");
  if (!IssuerSet.is(issuerSet)) refuse("bad-config", "issuerSet must come from parseIssuerSet");
  if (!nonceStore || !didMethods || !Array.isArray(didMethods.issuer)) refuse("bad-config", "issuerSet, nonceStore and didMethods are required");
  if (!Array.isArray(acceptedIssuers) || acceptedIssuers.length === 0) refuse("bad-config", "acceptedIssuers must not be empty");
  if (!Array.isArray(acceptedProfiles) || acceptedProfiles.length === 0) refuse("bad-config", "acceptedProfiles must not be empty");
  assertValidAudience(audience);
  if (parsePkhDid(callerAccount) === null) refuse("bad-config", "callerAccount must be a did:pkh:eip155 account");
  if (!isObject(presentation) || Object.keys(presentation).sort().join() !== "sdJwt,siwe") refuse("bad-presentation", "unexpected shape");
  const { sdJwt, siwe } = presentation as { sdJwt: unknown; siwe: unknown };
  if (typeof sdJwt !== "string" || !isAscii(sdJwt)) refuse("bad-presentation", "sdJwt must be an ASCII string");
  if (!isObject(siwe) || Object.keys(siwe).sort().join() !== "message,signature" || typeof siwe.message !== "string" || typeof siwe.signature !== "string") refuse("bad-presentation", "siwe shape");
  const sdJwtText = sdJwt as string;
  const siweMessage = siwe.message as string;
  const siweSignature = siwe.signature as string;
  // bounded before anything is split, decoded or parsed (a refusal here spends no nonce)
  if (sdJwtText.length > HELD_LIMITS.sdJwtChars) refuse("bad-presentation", "sdJwt is too long");
  if (siweMessage.length > HELD_LIMITS.siweMessageChars) refuse("bad-presentation", "siwe message is too long");
  if (siweSignature.length > HELD_LIMITS.siweSignatureChars) refuse("bad-presentation", "siwe signature is too long");

  // 2. SIWE fields and the nonce. The nonce is spent FIRST, on any outcome, by one atomic
  // compare-and-delete that includes the authenticated caller's account. A forger can only spend a
  // nonce bound to themselves, and every refusal below has already spent this one.
  const message = parseStrictSiwe(siweMessage);
  if (message.domain !== audience) refuse("bad-siwe", "domain is not this verifier's audience");
  if (!/^[0-9A-Za-z]{22,}$/.test(message.nonce)) refuse("bad-nonce", "nonce must be at least 22 base62 characters (or 32 hex)");
  const consumed = await nonceStore.consume(audience, message.nonce, callerAccount);
  if (!consumed.existed) refuse("nonce-replayed", "nonce is unknown, already used, or bound to another account");

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

  // 2. protected header only
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

  // 3. policy selection: the presenter never chooses the issuer
  if (!acceptedIssuers.some((a) => a.issuerDid === issuerDid && (a.kid === undefined || a.kid === kid))) refuse("issuer-not-accepted", "issuer is not accepted by this policy");

  // 4. entry lookup by the exact pair, then the checks that need only `now`
  const entry: IssuerEntry | undefined = lookupIssuerEntry(issuerSet, issuerDid, kid as string);
  if (!entry) refuse("unknown-issuer", "no issuer-set entry for this kid");
  if (entry.issuerDid !== issuerDid || entry.kid !== kid) refuse("unknown-issuer", "resolved entry is not the requested (issuerDid, kid)");
  const nowMs = now.getTime();
  if (nowMs < entry.notBefore) refuse("issuer-not-yet-valid", "issuer key is not yet valid");
  if (entry.notAfter !== null && nowMs >= entry.notAfter) refuse("issuer-stopped", "issuer key is past its hard stop");

  // 5. signature
  const signature = decodeBase64Url(signatureB64, "bad-signature");
  if (!verifyEd25519Strict(signature, asciiBytes(`${headerB64}.${payloadB64}`), entry.publicKey)) refuse("bad-signature", "issuer signature did not verify");

  // 6. only now decode the payload
  const payload = parseStrictJson(decodeUtf8(decodeBase64Url(payloadB64, "bad-payload"), "bad-payload"), "bad-payload");
  if (!isObject(payload)) refuse("bad-payload", "payload must be an object");
  if (payload.iss !== issuerDid) refuse("bad-payload", "iss must equal the DID part of kid");
  const { iat, nbf, exp } = payload;
  if (!isSafeInt(iat)) refuse("bad-payload", "iat is required");
  if (!isSafeInt(nbf) || nbf !== iat) refuse("bad-payload", "nbf must equal iat");
  if (!isSafeInt(exp)) refuse("bad-payload", "exp is required");
  if (entry.notBefore > (iat as number) * 1000) refuse("issuer-not-yet-valid", "credential predates the issuer key");
  if (entry.retiredAt !== null && (iat as number) * 1000 >= entry.retiredAt) refuse("issuer-retired", "issued at or after the issuer key was retired");

  // 7. profile row and admission
  if (typeof payload.profile !== "string" || !isSafeInt(payload.profileVersion) || typeof payload.vct !== "string") refuse("bad-payload", "profile, profileVersion and vct are required");
  const profile = payload.profile as string, profileVersion = payload.profileVersion as number, vct = payload.vct as string;
  const row = findRow(rows, profile, profileVersion);
  if (!row) refuse("profile-mismatch", "unknown profile");
  if (!acceptedProfiles.some((p) => p.profile === profile && p.profileVersion === profileVersion)) refuse("profile-not-accepted", "profile is not accepted by this caller");
  if (row.vct !== vct) refuse("profile-mismatch", "vct is not the row's vct");
  if (!entry.vcts.includes(vct) || !entry.profiles.includes(profile)) refuse("profile-mismatch", "issuer entry does not admit this vct and profile");

  // 8. claims against the row
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

  // 9. disclosures
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

  // 10. SIWE fields against the credential
  let origin: string | undefined;
  try { const url = new URL(message.uri); origin = url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined; } catch { origin = undefined; }
  if (origin !== `https://${audience}`) refuse("bad-siwe", "uri must be an https origin matching the audience");
  if (message.version !== "1") refuse("bad-siwe", "version must be 1");
  if (message.statement !== PRESENTATION_STATEMENT) refuse("bad-siwe", "unexpected statement");
  if (message.chainId !== subjectPkh.chainId) refuse("bad-siwe", "chain id must equal the credential subject's");
  if (!pkhPrincipalsEqual(`did:pkh:eip155:${message.chainId}:${message.address}`, subject)) refuse("bad-siwe", "address is not the credential subject");
  if (message.resources.length !== 1 || message.resources.some((r) => r.toLowerCase().startsWith("urn:recap:")) || message.resources[0] !== `${SD_HASH_RESOURCE_PREFIX}${sdHash(sdJwtText)}`) refuse("bad-siwe", "resources must be exactly the sd_hash of this presentation");
  if (message.expirationTime !== undefined && nowMs >= (parseRfc3339(message.expirationTime) as number)) refuse("bad-siwe", "SIWE has expired");
  if (message.notBefore !== undefined && nowMs < (parseRfc3339(message.notBefore) as number)) refuse("bad-siwe", "SIWE is not yet valid");
  const signatureBytes = hexToBytes(siweSignature.startsWith("0x") ? siweSignature.slice(2) : "zz", "bad-siwe-signature");
  const recovered = recoverEip191Address(siweMessage, signatureBytes);
  if (recovered === null || recovered !== subjectPkh.address) refuse("bad-siwe-signature", "signature does not recover the credential subject");

  // 11. the credential's subject must be the authenticated caller (a presentation is not authentication)
  if (!pkhPrincipalsEqual(callerAccount, subject)) refuse("nonce-account-mismatch", "subject is not the authenticated caller");

  return {
    issuer: issuerDid,
    subject: canonicalPkhDid(subject) as string,
    subjectAddress: registryKey(subject as string),
    expiresAt: new Date((exp as number) * 1000),
    credentialId: payload.jti as string,
    profile,
    profileVersion,
    vct,
    claims,
  };
}

