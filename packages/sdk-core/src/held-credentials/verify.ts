import { recoverEip191Address } from "./crypto";
import { parsePkhDid, pkhPrincipalsEqual } from "./did";
import { hexToBytes, isAscii, isObject } from "./encoding";
import { refuse } from "./errors";
import { HELD_LIMITS, checkHeldCredential, sdHash, toVerifiedCredential, type AcceptedIssuer, type AcceptedProfile, type VerifiedHeldCredential } from "./credential";
import { IssuerSet } from "./issuer-set";
import type { NonceStore } from "./nonce-store";
import { DEFAULT_ROWS, type ProfileRow } from "./rows";
import { PRESENTATION_STATEMENT, SD_HASH_RESOURCE_PREFIX, assertValidAudience, parseRfc3339, parseStrictSiwe } from "./siwe";

export { HELD_LIMITS, type AcceptedIssuer, type AcceptedProfile, type VerifiedHeldCredential } from "./credential";

export interface HeldPresentation {
  sdJwt: string;
  siwe: { message: string; signature: string };
}

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

  // 2. SIWE fields and the nonce. The nonce is consumed first, on any outcome, by one atomic
  // compare-and-delete that includes the authenticated caller's account; each presentation uses its
  // nonce once.
  const message = parseStrictSiwe(siweMessage);
  if (message.domain !== audience) refuse("bad-siwe", "domain is not this verifier's audience");
  if (!/^[0-9A-Za-z]{22,}$/.test(message.nonce)) refuse("bad-nonce", "nonce must be at least 22 base62 characters (or 32 hex)");
  const consumed = await nonceStore.consume(audience, message.nonce, callerAccount);
  if (!consumed.existed) refuse("nonce-replayed", "nonce is unknown, already used, or bound to another account");

  // 3. the signed credential (spec §4.4 steps 2 to 9), shared with verifyHeldEmailCredential
  const checked = checkHeldCredential(sdJwtText, { now, issuerSet, acceptedIssuers, acceptedProfiles, didMethods, rows });
  const subject = checked.subject;
  const subjectPkh = checked.subjectPkh;

  // 4. SIWE fields against the credential
  const nowMs = now.getTime();
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

  // 5. the credential's subject must be the authenticated caller (a presentation is not authentication)
  if (!pkhPrincipalsEqual(callerAccount, subject)) refuse("nonce-account-mismatch", "subject is not the authenticated caller");

  return toVerifiedCredential(checked);
}
