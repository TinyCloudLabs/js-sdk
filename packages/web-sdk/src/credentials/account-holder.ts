import { jcsCanonicalize, verifyEip191MessageSignature } from "@tinycloud/sdk-core";
import { ACCOUNT_BINDING_DOMAIN, parsePkhDid, pkhPrincipalsEqual, toChecksumAddress } from "@tinycloud/sdk-core/held-credentials";
import { EMAIL_PROOF_PINS, EmailProofError, type HolderSigner } from "@tinycloud/node-sdk/credentials";

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
const CREDENTIAL_LIFETIME_SECONDS = 31_536_000;
const JTI_V4 = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Refuses unless `body` is exactly one held account binding for `account`: the strict JCS bytes of an object with
 * exactly the 20 fields, the account-binding `type`, the acquisition protocol, profileVersion 1, a 365-day
 * lifetime, a lowercase v4 urn:uuid `jti`, this account as `holderDid` (as a principal) and the pinned issuer.
 * A body equal to its own re-canonicalisation has no duplicate key, no whitespace and no reordering.
 * The per-request values (nonce, mailbox digest, times) are checked by the acquisition flow, which knows them.
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
  if (
    binding.type !== ACCOUNT_BINDING_DOMAIN ||
    binding.protocol !== "tinycloud.credentials/acquisition/v1" ||
    binding.profileVersion !== 1 ||
    binding.credentialLifetimeSeconds !== CREDENTIAL_LIFETIME_SECONDS ||
    !JTI_V4.test(binding.jti as string) ||
    binding.issuer !== EMAIL_PROOF_PINS.issuerDid ||
    binding.issuerKid !== EMAIL_PROOF_PINS.issuerKid ||
    !pkhPrincipalsEqual(binding.holderDid, account)
  ) throw refuse();
}

/** Decodes the signed bytes exactly. Invalid UTF-8 is refused: the wallet message would not round-trip. */
function messageText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
  const guardedSign = async (bytes: Uint8Array): Promise<Uint8Array> => {
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
