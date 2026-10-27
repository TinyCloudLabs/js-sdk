import type { AccountDelegationRecord, TinyCloudNode } from "@tinycloud/node-sdk";

/** Records asked for per page. A page that holds more is not trusted. */
const PAGE_LIMIT = 100;
/** Pages read while looking a grant up: past this the lookup fails closed instead of guessing. */
const MAX_PAGES = 50;
/** Records processed in total, whatever the page sizes: past this the lookup fails closed. */
const MAX_RECORDS = PAGE_LIMIT * MAX_PAGES;
/** Hops walked from the grant's issuer up to the account owner. */
const MAX_CHAIN_DEPTH = 8;

function normalizeDid(input: string): string {
  const fragment = input.indexOf("#");
  return (fragment < 0 ? input : input.slice(0, fragment)).trim().toLowerCase();
}

/**
 * A space the node names, exactly `tinycloud:pkh:eip155:<chain>:<address>:<name>`: no other prefix,
 * no extra segments, no control or non-ASCII characters, bounded. Returns the owner it belongs to.
 */
const SPACE = /^tinycloud:pkh:eip155:([1-9]\d{0,17}):(0x[0-9a-fA-F]{40}):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function ownerOfSpace(space: string): string | undefined {
  const match = SPACE.exec(space);
  return match === null ? undefined : `did:pkh:eip155:${match[1]}:${match[2]!.toLowerCase()}`;
}

const ACCOUNT_DID = /^did:pkh:eip155:[1-9]\d{0,17}:0x[0-9a-fA-F]{40}$/;

/** The full account identity (eip155 chain id and lowercased address), or `undefined` when `did` is not an account DID. */
function accountIdentity(did: string): string | undefined {
  const normalized = normalizeDid(did);
  return ACCOUNT_DID.test(normalized) ? normalized : undefined;
}

/**
 * True when EVERY node record of `cid` names the same other account (a well-formed `did:pkh:eip155`
 * DID with a different chain id or address) as its issuer, and none of them covers a space `ownerDid`
 * owns. Such a grant is only held by this account, so the revoke is refused locally. Any other shape
 * (no record, rows that disagree about the issuer, a key issuer, an unparsable issuer, a row that
 * covers a space the owner holds) is `false` and the flow carries on unchanged. `records` must be the
 * complete query result: a partial list cannot show that the rows agree.
 */
export function issuedByAnotherAccount(
  records: readonly AccountDelegationRecord[],
  cid: string,
  ownerDid: string,
): boolean {
  const matches = records.filter((record) => record.cid === cid);
  if (matches.length === 0) return false;
  const owner = accountIdentity(ownerDid);
  const issuer = accountIdentity(matches[0]!.delegatorDid);
  if (issuer === undefined || owner === undefined || issuer === owner) return false;
  return matches.every((record) =>
    accountIdentity(record.delegatorDid) === issuer &&
    !record.resources.some(({ resource }) => {
      const space = /^(tinycloud:[^/]+)\//.exec(resource)?.[1];
      return space !== undefined && ownerOfSpace(space) === owner;
    }));
}

/**
 * The space a node-recorded grant covers, only when that grant is the signed-in owner's to revoke.
 * Both checks must hold; anything else (not found, another issuer, a space the owner does not
 * own or that is not a plain space id, several spaces) is `undefined`, so the caller keeps failing closed.
 *
 *  - Every resource names one `tinycloud:pkh:…:<name>` space owned by `ownerDid`, and they are all the same one.
 *  - The issuer is `ownerDid` itself or the signed-in session key, or a key that holds a delegation
 *    recorded on the node (found through `parents`) whose own issuer is, in turn, one of those:
 *    any holder along an owner-rooted chain counts, whether or not it is a session key.
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
  if (records.length > MAX_RECORDS) return undefined;
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
  const byCid = new Map<string, AccountDelegationRecord[]>();
  for (const record of records) {
    const sameCid = byCid.get(record.cid);
    if (sameCid === undefined) byCid.set(record.cid, [record]);
    else sameCid.push(record);
  }
  // One verdict per record: a crafted web of mutual parents costs one visit each, not one per path.
  const verdicts = new Map<string, boolean>();
  const rooted = (record: AccountDelegationRecord, depth: number): boolean => {
    const issuer = normalizeDid(record.delegatorDid);
    if (issuer === owner || issuer === session) return true;
    const known = verdicts.get(record.cid);
    if (known !== undefined) return known;
    // A record under evaluation that is reached again is a loop, not a proof.
    verdicts.set(record.cid, false);
    const verdict = depth < MAX_CHAIN_DEPTH && record.parents.some((parentCid) =>
      (byCid.get(parentCid) ?? []).some((parent) => normalizeDid(parent.delegateDid) === issuer && rooted(parent, depth + 1)));
    verdicts.set(record.cid, verdict);
    return verdict;
  };
  return rooted(target, 0) ? [...spaces][0] : undefined;
}

/**
 * Read the owner's node-side delegation records and resolve `cid` to its owner space.
 * `undefined` when the query is refused, a page holds more than {@link PAGE_LIMIT} records, more than
 * {@link MAX_RECORDS} records (or {@link MAX_PAGES} pages) would be needed, the grant is absent or it fails
 * {@link ownerSpaceFromNodeRecords}. Reading stops as soon as a running total passes the cap.
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
      direction: "all", limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }),
    });
    if (!query.ok) return undefined;
    if (query.data.items.length > PAGE_LIMIT || records.length + query.data.items.length > MAX_RECORDS) return undefined;
    for (const item of query.data.items) records.push(item);
    cursor = query.data.nextCursor;
    if (cursor === undefined) return ownerSpaceFromNodeRecords(records, cid, ownerDid, node.sessionDid);
  }
  // More records than were read: a duplicate or a parent could be past the cut, so do not decide on part of them.
  return undefined;
}
