import { secp256k1 } from "@noble/curves/secp256k1";
import { recoverEip191Address } from "./crypto";
import { HELD_LIMITS, sdHash } from "./credential";
import { parsePkhDid, pkhPrincipalsEqual, toChecksumAddress } from "./did";
import { hexToBytes, isAscii, isObject } from "./encoding";
import { refuse } from "./errors";
import { PRESENTATION_STATEMENT, SD_HASH_RESOURCE_PREFIX, assertValidAudience, parseRfc3339, parseStrictSiwe } from "./siwe";
import type { HeldPresentation } from "./verify";

/** Signs an EIP-191 `personal_sign` message. Returns `0x` + 130 hex (r, s, v) with low-S. Called once per presentation. */
export type HeldPresentationSigner = (message: string) => Promise<string>;

export interface HeldPresentationSiwe {
  message: string;
  signature: string;
}

export interface BuildHeldPresentationSiweInput {
  /** The verifier's audience: a bare host[:port] authority. It becomes the SIWE domain and the https origin. */
  audience: string;
  /** Nonce minted by the verifier for `audience`, bound to `account`. At least 22 base62 characters. */
  nonce: string;
  /** Base64url SHA-256 of the presented SD-JWT: `sdHash(selectDisclosures(...))`. */
  sdHash: string;
  /** The holder's `did:pkh:eip155:1:<address>`. */
  account: string;
  /** Whole seconds only, as RFC 3339 `Z`. Sub-second precision is refused, not truncated. */
  issuedAt: Date;
  /** Whole seconds only, as RFC 3339 `Z`. Must be after `issuedAt`. */
  expirationTime?: Date;
  /** Produces the signature. Each call builds a fresh message; nothing is cached. */
  sign: HeldPresentationSigner;
}

export interface CheckReturnedPresentationOptions {
  /** Explicit clock for the SIWE expiry and not-before windows. */
  now: Date;
  /** The verifier's audience. The SIWE domain and https origin must match it. */
  audience: string;
  /** The holder's `did:pkh:eip155:1:<address>`. The SIWE address must be principal-equal to it. */
  account: string;
}

const NONCE_FORMAT = /^[0-9A-Za-z]{22,}$/;
const SD_HASH_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_FORMAT = /^0x[0-9a-fA-F]{130}$/;
const SECP256K1_HALF_ORDER = secp256k1.CURVE.n / 2n;

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/** The node accepts only low-S signatures (`recover_from_prehash`). A high-S twin is refused, not normalised. */
function hasLowS(signature: string): boolean {
  return BigInt(`0x${signature.slice(66, 130)}`) <= SECP256K1_HALF_ORDER;
}

/** RFC 3339 UTC with whole seconds, the form the node fixtures use. Sub-second precision is refused, not dropped. */
function wholeSecondRfc3339(value: Date, field: string): string {
  if (value.getUTCMilliseconds() !== 0) refuse("bad-config", `${field} must be a whole second`);
  return value.toISOString().replace(".000Z", "Z");
}

function rfc3339Millis(value: string): number {
  const millis = parseRfc3339(value);
  if (millis === null) refuse("bad-siwe", "SIWE timestamp is not RFC 3339");
  return millis;
}

/**
 * Builds the EIP-4361 message for a held presentation in the layout `parseStrictSiwe` accepts, and
 * signs it with `sign`. The signature must recover to `account`. The verifier, not this builder,
 * decides whether the presentation is accepted.
 */
export async function buildHeldPresentationSiwe(input: BuildHeldPresentationSiweInput): Promise<HeldPresentationSiwe> {
  const { audience, nonce, sdHash: hash, account, issuedAt, expirationTime, sign } = input;
  if (typeof audience !== "string") refuse("bad-config", "audience must be a string");
  assertValidAudience(audience);
  const subject = parsePkhDid(account);
  if (subject === null) refuse("bad-config", "account must be a did:pkh:eip155 account");
  if (subject.chainId !== "1") refuse("bad-config", "held presentations are on chain 1");
  if (typeof nonce !== "string" || !NONCE_FORMAT.test(nonce)) refuse("bad-config", "nonce must be at least 22 base62 characters");
  if (typeof hash !== "string" || !SD_HASH_FORMAT.test(hash)) refuse("bad-config", "sdHash must be a base64url SHA-256");
  if (!isValidDate(issuedAt)) refuse("bad-config", "issuedAt must be a valid Date");
  if (expirationTime !== undefined && !isValidDate(expirationTime)) refuse("bad-config", "expirationTime must be a valid Date");
  if (expirationTime !== undefined && expirationTime.getTime() <= issuedAt.getTime()) refuse("bad-config", "expirationTime must be after issuedAt");
  if (typeof sign !== "function") refuse("bad-config", "sign is required");

  const message = [
    `${audience} wants you to sign in with your Ethereum account:`,
    toChecksumAddress(subject.address),
    "",
    PRESENTATION_STATEMENT,
    "",
    `URI: https://${audience}`,
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${wholeSecondRfc3339(issuedAt, "issuedAt")}`,
    ...(expirationTime === undefined ? [] : [`Expiration Time: ${wholeSecondRfc3339(expirationTime, "expirationTime")}`]),
    "Resources:",
    `- ${SD_HASH_RESOURCE_PREFIX}${hash}`,
  ].join("\n");
  parseStrictSiwe(message);
  if (message.length > HELD_LIMITS.siweMessageChars) refuse("bad-config", "SIWE message exceeds the node limit");

  const signature = await sign(message);
  if (typeof signature !== "string" || !SIGNATURE_FORMAT.test(signature)) refuse("bad-config", "signer must return 0x-prefixed 65-byte hex");
  if (!hasLowS(signature)) refuse("bad-siwe-signature", "signer must return a low-S signature");
  const recovered = recoverEip191Address(message, hexToBytes(signature.slice(2), "bad-siwe-signature"));
  if (recovered !== subject.address) refuse("bad-siwe-signature", "signer does not control the account");
  return { message, signature };
}

/**
 * Client-side check of a presentation before it is sent on. It is not a verifier: it does not look
 * up issuers, spend a nonce, or check the credential signature. `verifyHeldPresentation` decides acceptance.
 */
export function checkReturnedPresentation(presentation: unknown, options: CheckReturnedPresentationOptions): HeldPresentation {
  const { now, audience, account } = options;
  if (!isValidDate(now)) refuse("bad-config", "now must be a valid Date");
  assertValidAudience(audience);
  if (parsePkhDid(account) === null) refuse("bad-config", "account must be a did:pkh:eip155 account");
  if (!isObject(presentation) || Object.keys(presentation).sort().join() !== "sdJwt,siwe") refuse("bad-presentation", "unexpected shape");
  const { sdJwt, siwe } = presentation as { sdJwt: unknown; siwe: unknown };
  if (typeof sdJwt !== "string" || !isAscii(sdJwt) || sdJwt.length > HELD_LIMITS.sdJwtChars) refuse("bad-presentation", "sdJwt must be a bounded ASCII string");
  if (!isObject(siwe) || Object.keys(siwe).sort().join() !== "message,signature" || typeof siwe.message !== "string" || typeof siwe.signature !== "string") {
    refuse("bad-presentation", "siwe must carry message and signature");
  }
  const siweMessage = siwe.message as string;
  const siweSignature = siwe.signature as string;
  if (siweMessage.length > HELD_LIMITS.siweMessageChars) refuse("bad-presentation", "siwe message is too long");
  if (!SIGNATURE_FORMAT.test(siweSignature) || !hasLowS(siweSignature)) refuse("bad-siwe-signature", "signature must be 0x-prefixed 65-byte low-S hex");

  const parsed = parseStrictSiwe(siweMessage);
  if (parsed.domain !== audience) refuse("bad-siwe", "domain is not the audience");
  let origin: string | undefined;
  try {
    const url = new URL(parsed.uri);
    origin = url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined;
  } catch {
    origin = undefined;
  }
  if (origin !== `https://${audience}`) refuse("bad-siwe", "uri must be an https origin matching the audience");
  if (parsed.version !== "1") refuse("bad-siwe", "version must be 1");
  if (parsed.statement !== PRESENTATION_STATEMENT) refuse("bad-siwe", "unexpected statement");
  if (parsed.chainId !== "1") refuse("bad-siwe", "chain id must be 1");
  if (!NONCE_FORMAT.test(parsed.nonce)) refuse("bad-nonce", "nonce must be at least 22 base62 characters");
  if (parsed.resources.length !== 1 || parsed.resources[0] !== `${SD_HASH_RESOURCE_PREFIX}${sdHash(sdJwt)}`) {
    refuse("bad-siwe", "resources must be exactly the sd_hash of this presentation");
  }
  const nowMs = now.getTime();
  if (parsed.expirationTime !== undefined && nowMs >= rfc3339Millis(parsed.expirationTime)) refuse("bad-siwe", "SIWE has expired");
  if (parsed.notBefore !== undefined && nowMs < rfc3339Millis(parsed.notBefore)) refuse("bad-siwe", "SIWE is not yet valid");
  if (!pkhPrincipalsEqual(`did:pkh:eip155:${parsed.chainId}:${parsed.address}`, account)) refuse("bad-siwe", "SIWE address is not the account");
  const recovered = recoverEip191Address(siweMessage, hexToBytes(siweSignature.slice(2), "bad-siwe-signature"));
  if (recovered === null || recovered !== parsed.address.toLowerCase()) refuse("bad-siwe-signature", "signature does not recover the SIWE address");

  return { sdJwt, siwe: { message: siweMessage, signature: siweSignature } };
}
