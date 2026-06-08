import { getAddress, isAddress } from "viem";

export type CanonicalAddress = `0x${string}`;

export interface PkhDidParts {
  method: "pkh";
  namespace: "eip155";
  chainId: number;
  address: CanonicalAddress;
}

export interface DidEqualsOptions {
  ignoreFragment?: boolean;
}

export interface DidCacheKeyOptions {
  preserveFragment?: boolean;
}

export class IdentityParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityParseError";
  }
}

const PKH_DID_RE = /^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/;
const DID_RE = /^did:[a-z0-9]+:.+$/;

function splitDidUrl(input: string): { did: string; fragment: string } {
  const fragmentIndex = input.indexOf("#");
  if (fragmentIndex < 0) {
    return { did: input, fragment: "" };
  }
  return {
    did: input.slice(0, fragmentIndex),
    fragment: input.slice(fragmentIndex),
  };
}

function assertValidChainId(chainId: number): void {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new IdentityParseError(`Invalid EIP-155 chain ID: ${chainId}`);
  }
}

export function isEvmAddress(input: string): boolean {
  return isAddress(input, { strict: false });
}

export function canonicalizeAddress(address: string): CanonicalAddress {
  if (!isEvmAddress(address)) {
    throw new IdentityParseError(`Invalid EVM address: ${address}`);
  }
  return getAddress(address) as CanonicalAddress;
}

export function addressStorageKey(address: string): CanonicalAddress {
  return canonicalizeAddress(address).toLowerCase() as CanonicalAddress;
}

export function pkhDid(address: string, chainId: number = 1): string {
  assertValidChainId(chainId);
  return `did:pkh:eip155:${chainId}:${canonicalizeAddress(address)}`;
}

export function parsePkhDid(did: string): PkhDidParts | null {
  const match = did.match(PKH_DID_RE);
  if (!match) return null;

  const chainId = Number(match[1]);
  assertValidChainId(chainId);

  return {
    method: "pkh",
    namespace: "eip155",
    chainId,
    address: canonicalizeAddress(match[2]),
  };
}

export function canonicalizeDid(did: string): string {
  const pkh = parsePkhDid(did);
  if (pkh) {
    return pkhDid(pkh.address, pkh.chainId);
  }
  if (DID_RE.test(did)) {
    return did;
  }
  throw new IdentityParseError(`Invalid DID: ${did}`);
}

export function canonicalizeDidUrl(didUrl: string): string {
  const { did, fragment } = splitDidUrl(didUrl);
  return `${canonicalizeDid(did)}${fragment}`;
}

export function principalDid(didUrl: string): string {
  return canonicalizeDid(splitDidUrl(didUrl).did);
}

export function didEquals(a: string, b: string, options: DidEqualsOptions = {}): boolean {
  const canonicalize = options.ignoreFragment ? principalDid : canonicalizeDidUrl;
  return canonicalize(a) === canonicalize(b);
}

export function principalDidEquals(a: string, b: string): boolean {
  return didEquals(a, b, { ignoreFragment: true });
}

export function didCacheKey(input: string, options: DidCacheKeyOptions = {}): string {
  const { did, fragment } = splitDidUrl(input);
  const pkh = parsePkhDid(did);
  const base = pkh
    ? `did:pkh:eip155:${pkh.chainId}:${addressStorageKey(pkh.address)}`
    : canonicalizeDid(did);

  return options.preserveFragment ? `${base}${fragment}` : base;
}

export function makePkhSpaceId(
  address: string,
  chainId: number,
  name: string,
): string {
  assertValidChainId(chainId);
  if (!name) {
    throw new IdentityParseError("Space name cannot be empty");
  }
  return `tinycloud:pkh:eip155:${chainId}:${canonicalizeAddress(address)}:${name}`;
}
