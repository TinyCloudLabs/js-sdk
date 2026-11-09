import { z } from "zod";
import { ResourceNotRoutedError, routingResourceOf, type FetchFunction, type FetchResponse, type ResourceAccess, type ResourceTransport } from "@tinycloud/sdk-services";
import type { DelegatedResource } from "./types";
import { createCompactPolicyDescendant, parseSignedCompactUcanAttenuation } from "../policy/unified";
import { httpResponseError } from "../http-error";
import { parseSignedSiweCacao } from "./cacao";
import { principalDid } from "../identity";

export function spaceIdsEqual(left: string, right: string): boolean {
  const normalizeOwnerAddress = (space: string): string => {
    const match = /^(tinycloud:pkh:eip155:\d+:)(0x[0-9a-fA-F]{40})(:.+)$/.exec(space);
    return match === null ? space : `${match[1]}${match[2]!.toLowerCase()}${match[3]}`;
  };
  return normalizeOwnerAddress(left) === normalizeOwnerAddress(right);
}

/** Read routing scope from a grant whose signature and exact CID both verify. */
export async function verifiedDelegationRouting(authorization: string, cid: string): Promise<{
  audienceDid: string;
  resources: readonly { resource: string; access: ResourceAccess }[];
}> {
  let audienceDid: string;
  let attenuation: Readonly<Record<string, unknown>>;
  if (authorization.includes(".")) {
    const verified = parseSignedCompactUcanAttenuation(authorization, cid);
    audienceDid = principalDid(verified.payload.aud);
    attenuation = verified.payload.att;
  } else {
    const verified = await parseSignedSiweCacao(authorization, cid);
    audienceDid = principalDid(verified.audience);
    attenuation = verified.attenuation;
  }
  const resources: { resource: string; access: ResourceAccess }[] = [];
  const seen = new Set<string>();
  for (const uri of Object.keys(attenuation)) {
    const resource = routingResourceOf(uri.startsWith("urn:tinycloud:encryption:") ? uri.split("/", 1)[0]! : uri);
    const access = resource.startsWith("urn:tinycloud:encryption:") ? "encryption" : "host";
    if (!seen.has(resource)) {
      seen.add(resource);
      resources.push({ resource, access });
    }
  }
  if (resources.length === 0) throw new ResourceNotRoutedError("delegation");
  return { audienceDid, resources };
}

/** Transport form shared by addressed-share recipients and normal agents. */
export interface PortableDelegation {
  readonly cid: string;
  readonly delegationHeader: { readonly Authorization: string };
  readonly ownerAddress: string;
  readonly chainId: number;
  readonly host?: string;
  readonly spaceId: string;
  readonly path: string;
  readonly actions: readonly string[];
  readonly caveats?: readonly Record<string, unknown>[];
  readonly expiry: Date;
  readonly delegateDID: string;
  readonly delegatorDID?: string;
  readonly parentCid?: string;
  readonly disableSubDelegation?: boolean;
  readonly resources?: readonly DelegatedResource[];
}

const ResourceSchema = z
  .object({
    service: z.string().min(1),
    space: z.string().min(1),
    path: z.string(),
    actions: z.array(z.string().min(1)).min(1),
    caveats: z.array(z.record(z.unknown())).optional(),
  })
  .strict();

const PortableDelegationSchema = z
  .object({
    cid: z.string().min(1),
    delegationHeader: z.object({ Authorization: z.string().min(1) }).strict(),
    ownerAddress: z.string().min(1),
    chainId: z.number().int().nonnegative(),
    host: z.string().url().optional(),
    spaceId: z.string().min(1),
    path: z.string(),
    actions: z.array(z.string().min(1)).min(1),
    caveats: z.array(z.record(z.unknown())).optional(),
    expiry: z.coerce.date(),
    delegateDID: z.string().min(1),
    delegatorDID: z.string().min(1).optional(),
    parentCid: z.string().min(1).optional(),
    disableSubDelegation: z.boolean().optional(),
    resources: z.array(ResourceSchema).min(1).optional(),
  })
  .strict();

/** Validate a normal delegation received from a v3 claim/admission response. */
export function parsePortableDelegation(input: unknown): PortableDelegation {
  const parsed = PortableDelegationSchema.parse(input);
  if (parsed.resources !== undefined && parsed.resources.length === 0)
    throw new Error("portable delegation resources must not be empty");
  return parsed;
}

export function serializePortableDelegation(
  delegation: PortableDelegation,
): string {
  return JSON.stringify({
    ...delegation,
    expiry: delegation.expiry.toISOString(),
  });
}

export interface PortableDelegationImportReceipt {
  readonly activated?: readonly string[];
  readonly skipped?: readonly string[];
  readonly [key: string]: unknown;
}

/**
 * Admit a normal delegation through POST /delegate.
 * Without resourceTransport, sends to the explicit host you pass and does not consult the registry.
 * Received-share callers must supply resourceTransport; use Node/Web objects for registry routing.
 */
export async function importPortableDelegation(
  fetchFn: FetchFunction,
  host: string,
  delegation: PortableDelegation,
  resourceTransport?: ResourceTransport,
): Promise<PortableDelegationImportReceipt> {
  const parsed = parsePortableDelegation(delegation);
  const responses: FetchResponse[] = [];
  if (resourceTransport) {
    const verified = await verifiedDelegationRouting(parsed.delegationHeader.Authorization, parsed.cid);
    await resourceTransport(verified.resources, async (target) => {
      const response = await target.fetch(`${target.url}/delegate`, {
        method: "POST", headers: { Authorization: parsed.delegationHeader.Authorization },
      });
      responses.push(response);
      return response;
    }, { independentResources: true });
  } else {
    responses.push(await fetchFn(`${host.replace(/\/+$/, "")}/delegate`, {
      method: "POST",
      headers: { Authorization: parsed.delegationHeader.Authorization },
    }));
  }
  const response = responses[0]!;
  if (!response.ok)
    throw await httpResponseError(response, "node rejected delegation import");
  const receipts: PortableDelegationImportReceipt[] = [];
  for (const response of responses) {
    const body: unknown = await response.json().catch(() => ({}));
    if (body !== null && typeof body === "object" && !Array.isArray(body)) receipts.push(body as PortableDelegationImportReceipt);
  }
  if (receipts.length < 2) return receipts[0] ?? {};
  const activated = [...new Set(receipts.flatMap((receipt) => receipt.activated ?? []))];
  const skipped = [...new Set(receipts.flatMap((receipt) => receipt.skipped ?? []))].filter((space) => !activated.includes(space));
  return { ...receipts[0], activated, skipped };
}

/**
 * Create and admit an ordinary protected descendant below a v3 policy
 * session. This is the recipient-to-agent path; it deliberately bypasses the
 * legacy `prepareSession`/`rawAbilities` builder because that builder cannot
 * preserve the signed policy fact or the exact immediate-parent proof.
 */
export async function delegatePortablePolicySession(input: {
  readonly fetch: FetchFunction;
  readonly host: string;
  readonly resourceTransport?: ResourceTransport;
  readonly parent: PortableDelegation;
  readonly issuerPrivateKey: Uint8Array;
  readonly delegateDID: string;
  readonly attenuation: Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>;
  readonly now?: number;
  readonly expiresAt?: number;
  readonly nonce?: string;
}): Promise<PortableDelegation> {
  const parent = parsePortableDelegation(input.parent);
  const descendant = createCompactPolicyDescendant({
    parentAuthorization: parent.delegationHeader.Authorization.replace(/^Bearer\s+/i, ""),
    parentCid: parent.cid,
    issuerDid: parent.delegateDID,
    audienceDid: input.delegateDID,
    attenuation: input.attenuation,
    privateKey: input.issuerPrivateKey,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
  });
  const resources: DelegatedResource[] = Object.entries(descendant.payload.att).map(([resource, abilities]) => {
    const actions = Object.keys(abilities);
    if (resource.startsWith("urn:tinycloud:encryption:")) {
      return { service: "encryption", space: "encryption", path: resource, actions };
    }
    const match = /^tinycloud:\/\/([^/]+)\/kv\/(.+)$/.exec(resource);
    if (match === null) throw new Error("policy descendant resource is invalid");
    const caveats = Object.values(abilities).flat().filter((value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value));
    return { service: "kv", space: match[1]!, path: match[2]!, actions, ...(caveats.length === 0 ? {} : { caveats }) };
  });
  const primary = resources.find((resource) => resource.service === "kv") ?? resources[0];
  if (primary === undefined) throw new Error("policy descendant attenuation is empty");
  const portable: PortableDelegation = {
    cid: descendant.cid,
    delegationHeader: { Authorization: descendant.authorization },
    ownerAddress: parent.ownerAddress,
    chainId: parent.chainId,
    host: input.host,
    spaceId: primary.space,
    path: primary.path,
    actions: primary.actions,
    expiry: new Date(descendant.payload.exp * 1000),
    delegateDID: input.delegateDID,
    delegatorDID: parent.delegateDID,
    parentCid: parent.cid,
    disableSubDelegation: descendant.payload.fct[0]?.remainingRedelegationDepth === 0,
    resources,
  };
  await importPortableDelegation(input.fetch, input.host, portable, input.resourceTransport);
  return portable;
}
