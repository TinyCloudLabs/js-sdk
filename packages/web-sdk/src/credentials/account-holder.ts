import { jcsCanonicalize, verifyEip191MessageSignature } from "@tinycloud/sdk-core";
import { ACCOUNT_BINDING_DOMAIN, parsePkhDid, pkhPrincipalsEqual, toChecksumAddress } from "@tinycloud/sdk-core/held-credentials";
import { EmailProofError, HELD_ACCOUNT_BINDING_PINS as PINS, type HolderSigner } from "@tinycloud/node-sdk/credentials";

/** Kid fragment for an account (EIP-191) holder key, as the witness expects it. */
export const ACCOUNT_KID_FRAGMENT = "blockchainAccountId";

/** Held credentials are bound to Ethereum mainnet. Every other chain is refused. */
const ACCOUNT_CHAIN_ID = "1";

const SEPARATOR = 0x00;

function refuse(): EmailProofError {
  return new EmailProofError("request", "HOLDER_INVALID");
}

/**
 * Refuses unless the bytes are `UTF8(ACCOUNT_BINDING_DOMAIN) ‖ 0x00 ‖ body` with a non-empty body, and returns the body.
 * Runs before the caller's signer, so a refused request never reaches the wallet.
 */
function requireAccountBindingBytes(bytes: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode(ACCOUNT_BINDING_DOMAIN);
  if (bytes.length <= domain.length + 1 || bytes[domain.length] !== SEPARATOR) throw refuse();
  for (let i = 0; i < domain.length; i++) if (bytes[i] !== domain[i]) throw refuse();
  return bytes.subarray(domain.length + 1);
}

/** The 20 fields of the witness's account binding (contract C4.2), all strings except the two integers. */
const BINDING_FIELDS = [
  "audience", "challengeNonce", "completionContext", "completionOrigin", "credentialLifetimeSeconds", "descriptorDigest", "expiresAt",
  "holderDid", "issuedAt", "issuer", "issuerKid", "jti", "normalizedClaimsDigest", "openerOrigin", "profile", "profileVersion", "protocol",
  "requestId", "requirementDigest", "type",
] as const;
const JTI_V4 = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID32 = /^[A-Za-z0-9_-]{32}$/;
const DIGEST43 = /^[A-Za-z0-9_-]{43}$/;
const RFC3339_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const REQUEST_TTL_MS = 600_000;

/**
 * Refuses unless `body` is exactly one held account binding for `account`: the strict JCS bytes of an object with exactly the 20 fields
 * of C4.2, where every static field equals `HELD_ACCOUNT_BINDING_PINS` (the one frozen object the create request and the acquisition
 * checks also use), `holderDid` is this account (as a principal), `jti` is a lowercase v4 urn:uuid, and every other field has its strict
 * format. No field can carry free text, so nothing but the pinned values and the request's own opaque values can reach the wallet prompt.
 * A body equal to its own re-canonicalisation has no duplicate key, no whitespace and no reordering. The per-request values
 * themselves (nonce, digests, times) are checked by the acquisition flow, which knows them.
 */
function requireAccountBinding(body: Uint8Array, account: string): void {
  const text = messageText(body);
  let parsed: unknown;
  let canonical: string;
  try {
    parsed = JSON.parse(text);
    canonical = jcsCanonicalize(parsed);
  } catch {
    throw refuse();
  }
  if (canonical !== text || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw refuse();
  const binding = parsed as Record<string, unknown>;
  if (Object.keys(binding).sort().join() !== BINDING_FIELDS.join()) throw refuse();
  for (const field of BINDING_FIELDS) {
    if (field !== "profileVersion" && field !== "credentialLifetimeSeconds" && (typeof binding[field] !== "string" || binding[field] === "")) throw refuse();
  }
  const text_ = (field: string): string => binding[field] as string;
  if (
    (Object.keys(PINS) as (keyof typeof PINS)[]).some((field) => binding[field] !== PINS[field]) ||
    !pkhPrincipalsEqual(binding.holderDid, account) ||
    !JTI_V4.test(text_("jti")) ||
    !ID32.test(text_("requestId")) || !ID32.test(text_("challengeNonce")) ||
    !DIGEST43.test(text_("requirementDigest")) || !DIGEST43.test(text_("normalizedClaimsDigest")) ||
    !RFC3339_SECONDS.test(text_("issuedAt")) || !RFC3339_SECONDS.test(text_("expiresAt")) ||
    Date.parse(text_("expiresAt")) - Date.parse(text_("issuedAt")) !== REQUEST_TTL_MS
  ) throw refuse();
}

/** Decodes the signed bytes exactly. Invalid UTF-8 is refused: the wallet message would not round-trip. */
function messageText(bytes: Uint8Array): string {
  try {
    // ignoreBOM: a U+FEFF anywhere (including at the start of the body) is kept in the text, so it fails the strict-JCS check instead of being dropped.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw refuse();
  }
}

function hexOf(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Account (EIP-191) holder. The caller supplies `sign`, which must be the wallet's `personal_sign` over the
 * exact bytes it is given. That is the one place the EIP-191 prefix is applied. This module adds no prefix.
 * It verifies the returned 65-byte signature by recovering the signer over the same message, and refuses
 * unless the recovered address equals the account. `did` must be did:pkh:eip155:1, canonicalised to EIP-55.
 * It signs one thing only: `UTF8(ACCOUNT_BINDING_DOMAIN) ‖ 0x00 ‖ JCS(account binding for this account)`. Any other
 * bytes (other text, a binding for another holder, a ticket-typed or non-canonical body) are refused with
 * HOLDER_INVALID before `sign` is called.
 */
export function createAccountHolderSigner(did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array>): HolderSigner {
  const parsed = parsePkhDid(did);
  if (parsed === null || parsed.chainId !== ACCOUNT_CHAIN_ID) throw refuse();
  const address = toChecksumAddress(parsed.address);
  const canonical = `did:pkh:eip155:${ACCOUNT_CHAIN_ID}:${address}`;
  const guardedSign = async (input: Uint8Array): Promise<Uint8Array> => {
    // One private copy, taken first: the check, the decode and the wallet all see these exact bytes, whatever the caller's object does later
    // (a mutated buffer, or a subclass whose `subarray` or accessors answer differently).
    const bytes = new Uint8Array(input);
    requireAccountBinding(requireAccountBindingBytes(bytes), canonical);
    const message = messageText(bytes);
    const signature = await sign(bytes);
    // Canonical personal_sign form: 65 bytes with v (the last byte) 27 or 28. Anything else is refused.
    const v = signature[64];
    if (signature.length !== 65 || (v !== 27 && v !== 28)) throw refuse();
    if (!(await verifyEip191MessageSignature(message, hexOf(signature), address))) throw refuse();
    return signature;
  };
  return { did: canonical, alg: "EIP191", kid: `${canonical}#${ACCOUNT_KID_FRAGMENT}`, sign: guardedSign };
}
