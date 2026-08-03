import { z } from "zod";
import type { FetchFunction } from "@tinycloud/sdk-services";
import type { DelegatedResource } from "./types";
import { createCompactPolicyDescendant } from "../policy/unified";

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

/** Admit a normal delegation through POST /delegate. */
export async function importPortableDelegation(
  fetchFn: FetchFunction,
  host: string,
  delegation: PortableDelegation,
): Promise<PortableDelegationImportReceipt> {
  const parsed = parsePortableDelegation(delegation);
  const response = await fetchFn(`${host.replace(/\/+$/, "")}/delegate`, {
    method: "POST",
    headers: { Authorization: parsed.delegationHeader.Authorization },
  });
  if (!response.ok)
    throw new Error(`node rejected delegation import (${response.status})`);
  const body: unknown = await response.json().catch(() => ({}));
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return {};
  return body as PortableDelegationImportReceipt;
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
  await importPortableDelegation(input.fetch, input.host, portable);
  return portable;
}
