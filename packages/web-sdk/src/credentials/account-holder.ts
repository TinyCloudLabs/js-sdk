import { verifyEip191MessageSignature } from "@tinycloud/sdk-core";
import { ACCOUNT_BINDING_DOMAIN, parsePkhDid, toChecksumAddress } from "@tinycloud/sdk-core/held-credentials";
import { EmailProofError, type HolderSigner } from "@tinycloud/node-sdk/credentials";

/** Kid fragment for an account (EIP-191) holder key, as the witness expects it. */
export const ACCOUNT_KID_FRAGMENT = "blockchainAccountId";

/** Held credentials are bound to Ethereum mainnet. Every other chain is refused. */
const ACCOUNT_CHAIN_ID = "1";

const SEPARATOR = 0x00;

function refuse(): EmailProofError {
  return new EmailProofError("request", "HOLDER_INVALID");
}

/**
 * Refuses unless the bytes are `UTF8(ACCOUNT_BINDING_DOMAIN) ‖ 0x00 ‖ body` with a non-empty body.
 * Runs before the caller's signer, so a refused request never reaches the wallet.
 */
function requireAccountBindingBytes(bytes: Uint8Array): void {
  const domain = new TextEncoder().encode(ACCOUNT_BINDING_DOMAIN);
  if (bytes.length <= domain.length + 1 || bytes[domain.length] !== SEPARATOR) throw refuse();
  for (let i = 0; i < domain.length; i++) if (bytes[i] !== domain[i]) throw refuse();
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
 * Bytes outside the account-binding domain are refused before `sign` is called.
 */
export function createAccountHolderSigner(did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array>): HolderSigner {
  const parsed = parsePkhDid(did);
  if (parsed === null || parsed.chainId !== ACCOUNT_CHAIN_ID) throw refuse();
  const address = toChecksumAddress(parsed.address);
  const canonical = `did:pkh:eip155:${ACCOUNT_CHAIN_ID}:${address}`;
  const guardedSign = async (bytes: Uint8Array): Promise<Uint8Array> => {
    requireAccountBindingBytes(bytes);
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
