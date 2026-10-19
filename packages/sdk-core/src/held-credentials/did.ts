import { keccak_256 } from "./crypto";
import { asciiBytes } from "./encoding";

export interface PkhDid {
  chainId: string;
  /** Lowercase `0x` + 40 hex. */
  address: string;
}

/** EIP-55 checksummed form of a `0x` + 40 hex address. */
export function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase();
  const hash = keccak_256(asciiBytes(lower));
  let out = "0x";
  for (let i = 0; i < 40; i += 1) {
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  }
  return out;
}

/** All-lowercase, all-uppercase or correctly checksummed. A mixed-case address with a wrong EIP-55 checksum is refused. */
export function isValidAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

/** Parses `did:pkh:eip155:<chainId>:<address>`; null for anything else (no byte fallback). */
export function parsePkhDid(did: unknown): PkhDid | null {
  if (typeof did !== "string") return null;
  const match = /^did:pkh:eip155:(0|[1-9][0-9]{0,15}):(0x[0-9a-fA-F]{40})$/.exec(did);
  if (!match || !isValidAddress(match[2]!)) return null;
  return { chainId: match[1]!, address: match[2]!.toLowerCase() };
}

/** Principal equality: the exact eip155 chain id and the same address bytes. Never compares strings. */
export function pkhPrincipalsEqual(a: unknown, b: unknown): boolean {
  const left = parsePkhDid(a);
  const right = parsePkhDid(b);
  return left !== null && right !== null && left.chainId === right.chainId && left.address === right.address;
}

/**
 * The one key billing, Exo and credentials.org use for a verified subject: the lowercase 20-byte
 * address. It is chain-independent because v1 accepts only externally owned accounts (their control
 * does not depend on the chain). Accepting contract wallets or other chains would require adding
 * the chain here.
 */
export function registryKey(subject: string): string {
  const parsed = parsePkhDid(subject);
  if (!parsed) throw new TypeError("registryKey needs a did:pkh:eip155 subject");
  return parsed.address;
}
