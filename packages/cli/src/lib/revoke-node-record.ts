import type { AccountDelegationRecord, TinyCloudNode } from "@tinycloud/node-sdk";

/** Records scanned while looking a grant up: a page holds 100, so a hostile or huge account cannot stall a revoke. */
const MAX_PAGES = 50;
/** Hops walked from the grant's issuer up to the account owner. */
const MAX_CHAIN_DEPTH = 8;

function normalizeDid(input: string): string {
  const fragment = input.indexOf("#");
  return (fragment < 0 ? input : input.slice(0, fragment)).trim().toLowerCase();
}

function ownerOfSpace(space: string): string | undefined {
  const owner = /^tinycloud:((?:did:)?pkh:eip155:[1-9]\d*:0x[0-9a-fA-F]{40})(?::|$)/.exec(space)?.[1];
  if (!owner) return undefined;
  return normalizeDid(owner.startsWith("did:") ? owner : `did:${owner}`);
}

/**
 * The space a node-recorded grant covers, only when that grant is the signed-in owner's to revoke.
 * Both checks must hold; anything else (not found, another issuer, a space the owner does not
 * own, several spaces) is `undefined`, so the caller keeps failing closed.
 *
 *  - Every resource names a `tinycloud:` space owned by `ownerDid`, and they are all the same one.
 *  - The issuer is `ownerDid` itself, the signed-in session key, or a session key whose own
 *    delegation (found through `parents` in the same records) was issued by one of those.
 *
 * The node still decides whether the revocation is allowed; this only stops the CLI from asking it
 * to revoke on behalf of a space or issuer that the lookup response alone vouches for.
 */
export function ownerSpaceFromNodeRecords(
  records: readonly AccountDelegationRecord[],
  cid: string,
  ownerDid: string,
  sessionDid: string | undefined,
): string | undefined {
  // One CID may be listed once per direction; rows that disagree about issuer, recipient or scope are ambiguous.
  const matches = records.filter((record) => record.cid === cid);
  const target = matches[0];
  if (!target || new Set(matches.map(({ delegatorDid, delegateDid, resources }) =>
    JSON.stringify([delegatorDid, delegateDid, resources]))).size !== 1) return undefined;
  const owner = normalizeDid(ownerDid);
  if (target.resources.length === 0) return undefined;
  const spaces = new Set<string>();
  for (const { resource } of target.resources) {
    const space = /^(tinycloud:[^/]+)\//.exec(resource)?.[1];
    if (!space || ownerOfSpace(space) !== owner) return undefined;
    spaces.add(space);
  }
  if (spaces.size !== 1) return undefined;

  const session = sessionDid === undefined ? undefined : normalizeDid(sessionDid);
  const byDelegate = new Map<string, AccountDelegationRecord[]>();
  for (const record of records) {
    const key = normalizeDid(record.delegateDid);
    byDelegate.set(key, [...byDelegate.get(key) ?? [], record]);
  }
  const issuedByOwner = (record: AccountDelegationRecord, depth: number, seen: ReadonlySet<string>): boolean => {
    const issuer = normalizeDid(record.delegatorDid);
    if (issuer === owner || issuer === session) return true;
    if (depth >= MAX_CHAIN_DEPTH) return false;
    return record.parents.some((parentCid) =>
      !seen.has(parentCid) &&
      (byDelegate.get(issuer) ?? []).some((parent) =>
        parent.cid === parentCid && issuedByOwner(parent, depth + 1, new Set([...seen, parentCid]))));
  };
  return issuedByOwner(target, 0, new Set([cid])) ? [...spaces][0] : undefined;
}

/**
 * Read the owner's node-side delegation records and resolve `cid` to its owner space.
 * `undefined` when the query is refused, the grant is absent or fails {@link ownerSpaceFromNodeRecords}.
 */
export async function lookupOwnerSpaceOnNode(
  node: Pick<TinyCloudNode, "delegationManager" | "sessionDid">,
  cid: string,
  ownerDid: string,
): Promise<string | undefined> {
  const records: AccountDelegationRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = await node.delegationManager.query({
      direction: "all", limit: 100, ...(cursor === undefined ? {} : { cursor }),
    });
    if (!query.ok) return undefined;
    records.push(...query.data.items);
    cursor = query.data.nextCursor;
    if (cursor === undefined) break;
  }
  return ownerSpaceFromNodeRecords(records, cid, ownerDid, node.sessionDid);
}
