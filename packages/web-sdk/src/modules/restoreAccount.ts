import { canonicalizeAddress, parsePkhDid, parseSpaceUri, parseSignedSiweCacao, type PersistedSessionData } from "@tinycloud/sdk-core";

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

/** Bind the request to the verified CACAO owner before restoring any session state. */
export async function assertRequestedRestoreAccount(
  requested: string,
  session: Pick<PersistedSessionData, "address" | "chainId" | "tinycloudSession">,
): Promise<void> {
  try {
    const expected = requestedRestoreAccount(requested);
    const authorization = session.tinycloudSession?.delegationHeader.Authorization;
    if (!authorization || !session.tinycloudSession?.delegationCid) throw new SessionAccountMismatchError();
    const signed = await parseSignedSiweCacao(authorization.replace(/^Bearer\s+/i, ""), session.tinycloudSession.delegationCid);
    const owner = parsePkhDid(signed.issuer);
    const space = parseSpaceUri(session.tinycloudSession?.spaceId ?? "");
    if (!owner || owner.address.toLowerCase() !== expected.address.toLowerCase() ||
      owner.chainId !== session.chainId ||
      (expected.chainId !== undefined && owner.chainId !== expected.chainId) ||
      expected.address.toLowerCase() !== canonicalizeAddress(session.address).toLowerCase() ||
      (expected.chainId !== undefined && expected.chainId !== session.chainId) ||
      space?.address?.toLowerCase() !== expected.address.toLowerCase() ||
      space.chainId !== String(session.chainId)) {
      throw new SessionAccountMismatchError();
    }
  } catch {
    throw new SessionAccountMismatchError();
  }
}
