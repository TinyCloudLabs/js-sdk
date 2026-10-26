import type { PermissionEntry, PortableDelegation, TinyCloudNode } from "@tinycloud/node-sdk";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { parseSignedCompactUcanAttenuation } from "@tinycloud/sdk-core";
import { inspectStoredDelegation, withoutBearer } from "@tinycloud/operations/delegation-binding";
import type { ProfileConfig } from "../config/types.js";
import { ExitCode } from "../config/constants.js";
import { CLIError, cliErrorFromService } from "../output/errors.js";
import { ensureDelegationAuthority, requirePermissionConsent, type OpenKeyAcquisition } from "../commands/auth.js";
import { loadLocalGrantArtifacts, readGrantHistory, type StoredAdditionalDelegation } from "./permissions.js";
import { lookupOwnerSpaceOnNode } from "./revoke-node-record.js";

/**
 * Lifetime of the one-use authority a revoke requests. It only has to outlast
 * the revoke call; OpenKey's minimum is 60 seconds and its default is 7 days.
 */
export const REVOKE_AUTHORITY_EXPIRY = "5m";

type ScopeSource = "local-signed-grant-artifact" | "local-stored-grant" | "node-delegation-record";
type TargetSource = "node" | "local-grant-history" | ScopeSource;

export interface RevocationResult {
  cid: string;
  revoked: true;
  targetSpaceSource: TargetSource;
  authorityScopeSource: "cid-resource" | ScopeSource;
  authorityScopeReason: string;
}

function normalizeDid(input: string): string {
  const trimmed = input.trim();
  const fragment = trimmed.indexOf("#");
  return (fragment < 0 ? trimmed : trimmed.slice(0, fragment)).toLowerCase();
}

function ownerDidFromSpace(spaceId: string | undefined): string | undefined {
  const owner = /^tinycloud:((?:did:)?pkh:eip155:[1-9]\d*:0x[0-9a-fA-F]{40})(?::|\/|$)/.exec(spaceId ?? "")?.[1];
  if (!owner) return undefined;
  return owner.startsWith("did:") ? owner : `did:${owner}`;
}

/** Only signed resources may choose the fallback space; portable metadata never does. */
export async function cidBoundOwnerSpace(
  record: { delegation: PortableDelegation },
  ownerDid: string,
  node?: TinyCloudNode,
  host?: string,
): Promise<string | undefined> {
  const { delegation } = record;
  const authorization = delegation.delegationHeader?.Authorization;
  if (typeof authorization !== "string" || typeof delegation.cid !== "string") return undefined;
  if (!delegation.siweProof && withoutBearer(authorization).split(".").length === 3) {
    try {
      const signed = parseSignedCompactUcanAttenuation(withoutBearer(authorization), delegation.cid);
      for (const resource of Object.keys(signed.payload.att)) {
        const space = /^(tinycloud:[^/]+)\/[^/]+(?:\/.*)?$/.exec(resource)?.[1];
        if (space && ownerDidFromSpace(space) && normalizeDid(ownerDidFromSpace(space)!) === normalizeDid(ownerDid)) {
          return space;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (!node || !delegation.siweProof) return undefined;
  const inspected = await inspectStoredDelegation(record, { node, host: host ?? delegation.host });
  if (inspected.local !== "verified" || inspected.cid !== delegation.cid) return undefined;
  for (const permission of inspected.effectivePermissions) {
    const space = permission.space;
    if (space && ownerDidFromSpace(space) && normalizeDid(ownerDidFromSpace(space)!) === normalizeDid(ownerDid)) {
      return space;
    }
  }
  return undefined;
}

async function resolveCidBoundTargetSpace(params: {
  profileName: string;
  ownerDid?: string;
  cid: string;
  node: TinyCloudNode;
  host?: string;
  localTarget?: StoredAdditionalDelegation;
}): Promise<{ space: string; source: ScopeSource } | undefined> {
  if (!params.ownerDid) return undefined;
  if (params.localTarget?.delegation?.cid === params.cid) {
    const space = await cidBoundOwnerSpace(params.localTarget, params.ownerDid, params.node, params.host);
    if (space) return { space, source: "local-stored-grant" };
  }
  for (const artifact of await loadLocalGrantArtifacts(params.profileName)) {
    if (artifact.delegationCid !== params.cid || artifact.delegation.cid !== params.cid) continue;
    const space = await cidBoundOwnerSpace(artifact, params.ownerDid, params.node, params.host);
    if (space) return { space, source: "local-signed-grant-artifact" };
  }
  return undefined;
}

/** Revokes first; callers remove local rows only after this completes successfully. */
export async function revokeDelegationOnNode(params: {
  ctx: { profile: string; host: string };
  node: TinyCloudNode;
  profile: ProfileConfig;
  cid: string;
  yes: boolean;
  localTarget?: StoredAdditionalDelegation;
  openKeyAcquisition?: OpenKeyAcquisition;
}): Promise<RevocationResult> {
  const { ctx, node, profile, cid } = params;
  const revokePermission: PermissionEntry = {
    service: "tinycloud.delegation", space: `urn:cid:${cid}`, path: "", actions: ["tinycloud.delegation/revoke"],
  };
  const rawAuthorityCovered = node.hasRuntimePermissions([revokePermission]);
  if (!rawAuthorityCovered) await requirePermissionConsent([revokePermission], params.yes);

  let targetFound = params.localTarget?.delegation?.cid === cid;
  let targetSpaceSource: TargetSource = targetFound ? "local-stored-grant" : "node";
  let boundSpace: { space: string; source: ScopeSource } | undefined;
  if (!targetFound) {
    const accountSpaceId = node.accountSpaceId;
    if (!accountSpaceId) {
      throw new CLIError("DELEGATION_QUERY_AUTHORITY_UNAVAILABLE", "Cannot determine the account space needed to query delegation records.", ExitCode.AUTH_REQUIRED);
    }
    let queryDenied = false;
    let cursor: string | undefined;
    do {
      const query = await node.delegationManager.query({
        direction: "all", limit: 100, ...(cursor === undefined ? {} : { cursor }),
      });
      if (!query.ok) {
        if (query.error.meta?.status === 403) {
          queryDenied = true;
          break;
        }
        throw cliErrorFromService(query.error);
      }
      targetFound = query.data.items.some((delegation) => delegation.cid === cid);
      cursor = targetFound ? undefined : query.data.nextCursor;
    } while (cursor !== undefined);
    if (!targetFound) {
      const recordedGrant = [...await readGrantHistory(ctx.profile)].reverse().find((entry) => entry.delegationCid === cid);
      if (recordedGrant) {
        targetSpaceSource = "local-grant-history";
      } else if (queryDenied) {
        boundSpace = await resolveCidBoundTargetSpace({
          profileName: ctx.profile, ownerDid: profile.ownerDid ?? ownerDidFromSpace(node.accountSpaceId) ?? ownerDidFromSpace(profile.spaceId),
          cid, node, host: ctx.host,
        });
        if (!boundSpace) {
          throw new CLIError(
            "TARGET_NOT_FOUND",
            `This profile cannot list the owner's delegations on the node, so it cannot look up "${cid}", and it has no local record of that grant. Use the profile that created the grant, or revoke it from the Delegations screen of the account site (https://account.tinycloud.xyz).`,
            ExitCode.NOT_FOUND,
          );
        }
        targetSpaceSource = boundSpace.source;
      } else {
        throw new CLIError("TARGET_NOT_FOUND", `Delegation "${cid}" was not found by the node or local grant history.`, ExitCode.NOT_FOUND);
      }
    }
  }

  let authorityScopeSource: RevocationResult["authorityScopeSource"] = "cid-resource";
  let authorityScopeReason = "The revoke authority is scoped to the exact delegation CID.";
  let fallbackSpaceId: string | undefined;
  let commandAuthorityCid: string | undefined;
  if (!rawAuthorityCovered) {
    try {
      const acquired = await ensureDelegationAuthority({
        ctx, profile, node, requested: [revokePermission], expiryOption: REVOKE_AUTHORITY_EXPIRY,
        reason: `Revoke delegation ${cid}`, yes: params.yes, consentAlreadyGiven: true,
        persist: false, openKeyAcquisition: params.openKeyAcquisition,
      });
      commandAuthorityCid = acquired?.cid;
    } catch (error) {
      if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "RAW_RECAP_RESOURCE_UNSUPPORTED") {
        throw error;
      }
      const ownerDid = profile.ownerDid ?? ownerDidFromSpace(node.accountSpaceId) ?? ownerDidFromSpace(profile.spaceId);
      let fallback = boundSpace ?? await resolveCidBoundTargetSpace({
        profileName: ctx.profile, ownerDid, cid, node, host: ctx.host, localTarget: params.localTarget,
      });
      if (!fallback && ownerDid) {
        // No local record of the grant (another profile or machine signed it): the owner's node-side record may name it.
        const space = await lookupOwnerSpaceOnNode(node, cid, ownerDid);
        if (space) fallback = { space, source: "node-delegation-record" };
      }
      if (!fallback) {
        throw new CLIError(
          "RAW_RECAP_RESOURCE_UNSUPPORTED",
          `Cannot revoke "${cid}": this CLI profile has no record of this grant and the node's record does not match the signed-in owner.`,
          ExitCode.PERMISSION_DENIED,
          profile.authMethod === "openkey" ? { hint: "Revoke the delegation on the account site: https://account.tinycloud.xyz/delegations." } : undefined,
        );
      }
      fallbackSpaceId = fallback.space;
      authorityScopeSource = fallback.source;
      authorityScopeReason = fallback.source === "local-signed-grant-artifact"
        ? "Raw-CID revoke authority could not be issued; the fallback space came from an owner-signed local grant whose Authorization recomputes to this CID."
        : fallback.source === "node-delegation-record"
          ? "Raw-CID revoke authority could not be issued; the fallback space came from the node's delegation record, whose issuer chains to the signed-in owner and whose space the owner holds."
          : "Raw-CID revoke authority could not be issued; the fallback space came from a locally verified owner-signed stored grant bound to this CID.";
      targetSpaceSource = fallback.source;
      const acquired = await ensureDelegationAuthority({
        ctx, profile, node,
        requested: [{ service: "tinycloud.delegation",
          space: profile.authMethod !== "openkey" && fallback.space === node.accountSpaceId ? "default" : fallback.space,
          path: "", actions: ["tinycloud.delegation/revoke"] }],
        expiryOption: REVOKE_AUTHORITY_EXPIRY,
        reason: fallback.source === "node-delegation-record"
          ? `Revoke delegation ${cid} using the node's record of the owner's grant`
          : `Revoke delegation ${cid} using its CID-bound owner-signed grant ${fallback.source === "local-stored-grant" ? "record" : "artifact"}`,
        yes: params.yes, consentAlreadyGiven: true, persist: false,
        openKeyAcquisition: params.openKeyAcquisition,
      });
      commandAuthorityCid = acquired?.cid;
    }
  }

  const result = fallbackSpaceId
    ? await node.delegationManager.revoke(cid, {
      targetSpaceId: fallbackSpaceId,
      ...(commandAuthorityCid === undefined ? {} : { authorityCid: commandAuthorityCid }),
    })
    : commandAuthorityCid === undefined
      ? await node.revokeDelegation(cid)
      : await node.delegationManager.revoke(cid, { authorityCid: commandAuthorityCid });
  if (!result.ok) {
    if (result.error.meta?.status === 403 && result.error.message === "Failed to revoke delegation: 403 - Unauthorized Revoker") {
      const profileDid = profile.ownerDid ?? ownerDidFromSpace(node.accountSpaceId) ?? ownerDidFromSpace(profile.spaceId) ?? "unknown";
      throw new CLIError(
        "REVOKE_UNAUTHORIZED", "The node rejected this revocation: Unauthorized Revoker.", ExitCode.PERMISSION_DENIED,
        { status: 403, hint: `Use a different profile belonging to the delegation's grantor, its recipient, or the owner of a space it covers; the rejected profile was "${ctx.profile}" (DID ${profileDid}). Retry with \`${CLI_NAME} --profile <profile-name> delegation revoke ${cid}\`.` },
      );
    }
    throw cliErrorFromService(result.error);
  }
  return { cid, revoked: true, targetSpaceSource, authorityScopeSource, authorityScopeReason };
}
