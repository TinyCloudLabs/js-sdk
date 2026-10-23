import { jcsCanonicalize } from "@tinycloud/sdk-core";
import { ACCOUNT_BINDING_DOMAIN, parsePkhDid, toChecksumAddress } from "@tinycloud/sdk-core/held-credentials";
import { EmailProofError, type HolderSigner } from "@tinycloud/node-sdk/credentials";

/** Kid fragment for an account (EIP-191) holder key, as the witness expects it. */
export const ACCOUNT_KID_FRAGMENT = "blockchainAccountId";

/**
 * Bytes an account holder signs over a holder binding: `UTF8(domain) ‖ 0x00 ‖ UTF8(JCS(binding))`.
 * The domain is the account-binding domain, not the did:key holder-binding domain.
 */
export function accountBindingSigningBytes(binding: unknown): Uint8Array {
  const encoder = new TextEncoder();
  const domain = encoder.encode(ACCOUNT_BINDING_DOMAIN);
  const canonical = encoder.encode(jcsCanonicalize(binding));
  const out = new Uint8Array(domain.length + 1 + canonical.length);
  out.set(domain, 0);
  out[domain.length] = 0;
  out.set(canonical, domain.length + 1);
  return out;
}

/**
 * Account (EIP-191) holder. The caller supplies `sign`; this module holds no key material.
 * `did` must be a did:pkh:eip155 account and is canonicalised to EIP-55 form. Anything else is refused.
 */
export function createAccountHolderSigner(did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array>): HolderSigner {
  const parsed = parsePkhDid(did);
  if (parsed === null) throw new EmailProofError("request", "HOLDER_INVALID");
  const canonical = `did:pkh:eip155:${parsed.chainId}:${toChecksumAddress(parsed.address)}`;
  return { did: canonical, alg: "EIP191", kid: `${canonical}#${ACCOUNT_KID_FRAGMENT}`, sign };
}
