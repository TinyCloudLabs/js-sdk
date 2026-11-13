import { canonicalizeAddress, parsePkhDid, parseSpaceUri } from "@tinycloud/sdk-core";

export class SessionAccountMismatchError extends Error {
  readonly code = "ACCOUNT_MISMATCH";

  constructor() {
    super("This saved sign-in is for a different account. Sign in again.");
    this.name = "SessionAccountMismatchError";
  }
}

/** Address-only callers retain their existing chain selection; DID/CAIP callers pin it. */
export function requestedRestoreAccount(account: string): { address: string; chainId?: number } {
  try {
    const did = parsePkhDid(account.startsWith("eip155:") ? `did:pkh:${account}` : account);
    return did ? { address: did.address, chainId: did.chainId } : { address: canonicalizeAddress(account) };
  } catch {
    throw new SessionAccountMismatchError();
  }
}

/** Signed restore validation subsequently binds these metadata fields to the owner proof. */
export function assertRequestedRestoreAccount(
  requested: string,
  session: { address: string; chainId: number; tinycloudSession?: { spaceId: string } },
): void {
  try {
    const expected = requestedRestoreAccount(requested);
    const space = parseSpaceUri(session.tinycloudSession?.spaceId ?? "");
    if (expected.address.toLowerCase() !== canonicalizeAddress(session.address).toLowerCase() ||
      (expected.chainId !== undefined && expected.chainId !== session.chainId) ||
      space?.address?.toLowerCase() !== expected.address.toLowerCase() ||
      space.chainId !== String(session.chainId)) {
      throw new SessionAccountMismatchError();
    }
  } catch {
    throw new SessionAccountMismatchError();
  }
}
