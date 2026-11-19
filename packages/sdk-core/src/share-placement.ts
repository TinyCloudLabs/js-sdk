import { verifyMessage } from "viem";
import { z } from "zod";
import {
  parseSpaceUri, exactHttpOrigin, validateLocationRecordV2Payload, decodeBase64Url,
  parseSignedSiweCacao, verifiedDelegationRouting, spaceIdsEqual,
  resolveOwnerHosts, RegistryUnavailableError, type ResolveOwnerHostsOptions,
} from "./share-placement-helpers";

export const SHARE_PLACEMENT_TYPE = "tinycloud/share-placement/v1" as const;
const schema = z.object({
  type: z.literal(SHARE_PLACEMENT_TYPE), ownerDid: z.string(), parentCid: z.string().min(1),
  spaceId: z.string().min(1), nodeDid: z.string(), nodeUrl: z.string(),
  issuedAt: z.string().datetime(), notAfter: z.string().datetime(), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
}).strict();
export type SharePlacement = z.infer<typeof schema>;
export type SharePlacementPayload = Omit<SharePlacement, "signature">;
export interface SharePlacementParent { cid: string; authHeader?: string; spaceId: string; }

export function sharePlacementMessage(payload: SharePlacementPayload): string {
  return SHARE_PLACEMENT_TYPE + "\n" + JSON.stringify({
    type: payload.type, ownerDid: payload.ownerDid, parentCid: payload.parentCid,
    spaceId: payload.spaceId, nodeDid: payload.nodeDid, nodeUrl: payload.nodeUrl,
    issuedAt: payload.issuedAt, notAfter: payload.notAfter,
  });
}

function validatePlacementDestination(record: SharePlacementPayload): void {
  if (exactHttpOrigin(record.nodeUrl, "share node") !== record.nodeUrl) throw new Error("Share node URL must be exact");
  // Reuse the registry's strict destination/space field validation, not its record signature domain.
  validateLocationRecordV2Payload({ version: 2, subject: record.ownerDid,
    nodes: [{ did: record.nodeDid, url: record.nodeUrl }], spaces: [{ space: record.spaceId, nodes: [{ did: record.nodeDid, mode: "read-only" }] }],
    encryptionNode: null, updated_at: record.issuedAt, sequence: 0 });
}

async function parentBinding(parent: SharePlacementParent) {
  if (!parent.authHeader) throw new Error("Share placement requires signed parent bytes");
  const verified = await verifiedDelegationRouting(parent.authHeader, parent.cid);
  if (!verified.resources.some(({ resource }) => spaceIdsEqual(resource, parent.spaceId))) throw new Error("Share placement space is not in the signed parent");
  const ownerDid = parseSpaceUri(parent.spaceId)?.owner;
  if (!ownerDid?.startsWith("did:pkh:eip155:")) throw new Error("Share placement requires the wallet owner");
  const expiry = parent.authHeader.includes(".")
    ? new Date(JSON.parse(new TextDecoder().decode(decodeBase64Url(parent.authHeader.split(".")[1]!))).exp * 1000)
    : new Date((await parseSignedSiweCacao(parent.authHeader, parent.cid)).expiresAt!);
  if (!Number.isFinite(expiry.getTime())) throw new Error("Share placement parent has no finite expiry");
  return { ownerDid, expiry };
}

export async function verifySharePlacement(input: unknown, parent: SharePlacementParent, now = Date.now()): Promise<SharePlacement> {
  try {
    const record = schema.parse(input);
    const binding = await parentBinding(parent);
    if (record.ownerDid.toLowerCase() !== binding.ownerDid.toLowerCase() || record.parentCid !== parent.cid || record.spaceId !== parent.spaceId ||
        Date.parse(record.notAfter) !== binding.expiry.getTime() || Date.parse(record.issuedAt) > now ||
        Date.parse(record.issuedAt) >= Date.parse(record.notAfter) || now >= Date.parse(record.notAfter)) throw new Error("Share placement binding or validity is invalid");
    validatePlacementDestination(record);
    if (!(await verifyMessage({ address: record.ownerDid.slice(record.ownerDid.lastIndexOf(":") + 1) as `0x${string}`,
      message: sharePlacementMessage(record), signature: record.signature as `0x${string}` }))) throw new Error("Share placement owner signature is invalid");
    return record;
  } catch {
    throw new Error("Invalid share placement");
  }
}

export async function signSharePlacement(parent: SharePlacementParent, node: { did: string; url: string },
  signMessage: (message: string) => Promise<string>, now = Date.now()): Promise<SharePlacement> {
  const { ownerDid, expiry } = await parentBinding(parent);
  const payload: SharePlacementPayload = { type: SHARE_PLACEMENT_TYPE, ownerDid, parentCid: parent.cid,
    spaceId: parent.spaceId, nodeDid: node.did, nodeUrl: node.url, issuedAt: new Date(now).toISOString(), notAfter: expiry.toISOString() };
  validatePlacementDestination(payload);
  if (now >= expiry.getTime()) throw new Error("Share placement parent is expired");
  const signature = await signMessage(sharePlacementMessage(payload));
  return verifySharePlacement({ ...payload, signature }, parent, now);
}

/** Resolve only this share's space; carried statements never update global registry state. */
export async function sharePlacementDestinations(record: SharePlacement, parent: SharePlacementParent,
  options: ResolveOwnerHostsOptions = {}) {
  const checked = await verifySharePlacement(record, parent);
  const request = options.fetch ?? globalThis.fetch;
  let failureStatus: number | undefined;
  const observedFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await request(input, init);
    if (response.status !== 200 && response.status !== 404) failureStatus = response.status;
    return response;
  }, { preconnect: request.preconnect });
  const verdict = await resolveOwnerHosts(checked.ownerDid, { ...options, fetch: observedFetch });
  if (failureStatus !== undefined && (failureStatus < 500 || failureStatus > 599)) throw new Error("Share placement registry lookup refused");
  if (verdict.status === "registered") {
    if (!verdict.record) throw new RegistryUnavailableError(checked.ownerDid, undefined);
    const membership = verdict.record.spaces.find(({ space }) => spaceIdsEqual(space, checked.spaceId));
    if (!membership || membership.nodes.length === 0) throw new Error("Current owner placement does not serve this share");
    return membership.nodes.map(({ did }) => {
      const node = verdict.record!.nodes.find(node => node.did === did);
      if (!node) throw new Error("Current owner placement has no destination identity");
      return { nodeDid: node.did, url: node.url };
    });
  }
  if (verdict.status === "unavailable" && !(verdict.reason === "network-error" || verdict.reason === "timeout" ||
      (verdict.reason === "http-status" && failureStatus !== undefined && failureStatus >= 500 && failureStatus <= 599))) {
    throw new RegistryUnavailableError(checked.ownerDid, verdict);
  }
  return [{ nodeDid: checked.nodeDid, url: checked.nodeUrl }];
}
