import { Command } from "commander";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ProfileManager } from "../config/profiles.js";
import { outputJson } from "../output/formatter.js";
import { handleError, CLIError, cliErrorFromService } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { ensureDelegationAuthority, requirePermissionConsent } from "./auth.js";
import { parseExpiry } from "../lib/duration.js";
import { loadLocalGrantArtifacts, readGrantHistory } from "../lib/permissions.js";
import { parseSignedCompactUcanAttenuation } from "@tinycloud/sdk-core";
function normalizeDid(input: string): string {
  const normalized = input.trim();
  const fragmentIndex = normalized.indexOf("#");
  return (fragmentIndex === -1 ? normalized : normalized.slice(0, fragmentIndex)).toLowerCase();
}
function didMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  return normalizeDid(actual) === normalizeDid(expected);
}
function ownerDidFromSpace(spaceId: string | undefined): string | undefined {
  const owner = /^tinycloud:((?:did:)?pkh:eip155:[1-9]\d*:0x[0-9a-fA-F]{40})(?::|\/|$)/.exec(spaceId ?? "")?.[1];
  if (!owner) return undefined;
  return owner.startsWith("did:") ? owner : `did:${owner}`;
}


async function resolveCidBoundTargetSpace(params: {
  profileName: string;
  ownerDid?: string;
  cid: string;
}): Promise<string | undefined> {
  if (!params.ownerDid) return undefined;
  const grants = await loadLocalGrantArtifacts(params.profileName);
  for (const grant of grants) {
    const delegation = grant.delegation;
    if (grant.delegationCid !== params.cid || delegation.cid !== params.cid) continue;
    try {
      const authorization = delegation.delegationHeader.Authorization.replace(/^Bearer /i, "");
      const signed = parseSignedCompactUcanAttenuation(authorization, params.cid);
      for (const resource of Object.keys(signed.payload.att)) {
        const space = /^(tinycloud:[^/]+)\/[^/]+\/.*$/.exec(resource)?.[1];
        if (!space) continue;
        const ownerMatch = /^tinycloud:((?:did:)?pkh:eip155:[1-9]\d*:0x[0-9a-fA-F]{40}):/.exec(space);
        const owner = ownerMatch?.[1];
        const ownerDid = owner?.startsWith("did:") ? owner : owner ? `did:${owner}` : undefined;
        if (ownerDid && normalizeDid(ownerDid) === normalizeDid(params.ownerDid)) return space;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function registerDelegationCommand(program: Command): void {
  const delegation = program.command("delegation").description("Manage delegations");

  delegation
    .command("create")
    .description("Create a delegation")
    .requiredOption("--to <did>", "Recipient DID")
    .requiredOption("--path <path>", "KV path scope")
    .requiredOption("--actions <actions>", "Comma-separated actions (e.g., kv/get,kv/list)")
    .option("--expiry <duration>", "Expiry duration (e.g., 1h, 7d, ISO date)", "1h")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const actions = options.actions.split(",").map((a: string) => {
          const trimmed = a.trim();
          return trimmed.startsWith("tinycloud.") ? trimmed : `tinycloud.${trimmed}`;
        });

        const expiry = parseExpiry(options.expiry);

        const result = await node.delegationManager.create({
          delegateDID: options.to,
          path: options.path,
          actions,
          expiry,
        });

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        outputJson({
          cid: result.data.cid,
          delegateDid: options.to,
          path: options.path,
          actions,
          expiry: expiry.toISOString(),
        });
      } catch (error) {
        handleError(error);
      }
    });

  delegation
    .command("list")
    .description("List delegations")
    .option("--granted", "Show only delegations I've granted")
    .option("--received", "Show only delegations I've received")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const result = await node.delegationManager.list();
        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        let delegations: any[] = result.data;

        // Filter if requested
        if (options.granted) {
          const myDid = node.did;
          delegations = delegations.filter((d: any) => didMatches(d.delegatorDID, myDid));
        } else if (options.received) {
          const myDid = node.did;
          delegations = delegations.filter((d: any) => didMatches(d.delegateDID, myDid));
        }

        outputJson({
          delegations: delegations.map((d: any) => ({
            cid: d.cid,
            delegatee: d.delegateDID,
            delegator: d.delegatorDID,
            path: d.path,
            actions: d.actions,
            expiry: d.expiry instanceof Date ? d.expiry.toISOString() : d.expiry,
          })),
          count: delegations.length,
        });
      } catch (error) {
        handleError(error);
      }
    });

  delegation
    .command("info <cid>")
    .description("Get delegation details")
    .action(async (cid: string, _options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        const result = await node.delegationManager.get(cid);
        if (!result.ok) {
          throw new CLIError("NOT_FOUND", `Delegation "${cid}" not found`, ExitCode.NOT_FOUND);
        }

        outputJson(result.data);
      } catch (error) {
        handleError(error);
      }
    });

  delegation
    .command("revoke <cid>")
    .description("Revoke a delegation")
    .option("--yes", "Skip local-key TTY confirmation", false)
    .action(async (cid: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);
        const profile = await ProfileManager.getProfile(ctx.profile);

        const revokePermission: PermissionEntry = {
          service: "tinycloud.delegation",
          space: `urn:cid:${cid}`,
          path: "",
          actions: ["tinycloud.delegation/revoke"],
        };
        const rawAuthorityCovered = node.hasRuntimePermissions([revokePermission]);
        if (!rawAuthorityCovered) await requirePermissionConsent([revokePermission], options.yes);

        let targetFound = false;
        let targetSpaceSource: "node" | "local-grant-history" | "local-signed-grant-artifact";
        let queryDenied = false;
        let boundSpace: string | undefined;
        const accountSpaceId = node.accountSpaceId;
        if (!accountSpaceId) {
          throw new CLIError(
            "DELEGATION_QUERY_AUTHORITY_UNAVAILABLE",
            "Cannot determine the account space needed to query delegation records.",
            ExitCode.AUTH_REQUIRED,
          );
        }
        let cursor: string | undefined;
        do {
          const query = await node.delegationManager.query({
            direction: "all",
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
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

        targetSpaceSource = "node";
        if (!targetFound) {
          const grantHistory = await readGrantHistory(ctx.profile);
          const recordedGrant = [...grantHistory].reverse().find((entry) => entry.delegationCid === cid);
          if (recordedGrant) {
            targetSpaceSource = "local-grant-history";
          } else if (queryDenied) {
            boundSpace = await resolveCidBoundTargetSpace({
              profileName: ctx.profile,
              ownerDid: profile.ownerDid ?? ownerDidFromSpace(node.accountSpaceId) ?? ownerDidFromSpace(profile.spaceId),
              cid,
            });
            if (boundSpace) {
              targetSpaceSource = "local-signed-grant-artifact";
            } else {
              throw new CLIError(
                "TARGET_NOT_FOUND",
                `Delegation "${cid}" was not found by the node or local grant sources.`,
                ExitCode.NOT_FOUND,
              );
            }
          } else {
            throw new CLIError(
              "TARGET_NOT_FOUND",
              `Delegation "${cid}" was not found by the node or local grant history.`,
              ExitCode.NOT_FOUND,
            );
          }
        }


        let authorityScopeSource: "cid-resource" | "local-signed-grant-artifact" = "cid-resource";
        let authorityScopeReason = "The revoke authority is scoped to the exact delegation CID.";
        let fallbackSpaceId: string | undefined;
        let commandAuthorityCid: string | undefined;
        const authorizeFallbackSpace = async (spaceId: string) => {
          fallbackSpaceId = spaceId;
          authorityScopeSource = "local-signed-grant-artifact";
          authorityScopeReason =
            "Raw-CID revoke authority could not be issued; the fallback space came from an owner-signed local grant whose Authorization recomputes to this CID.";
          targetSpaceSource = "local-signed-grant-artifact";
          const acquired = await ensureDelegationAuthority({
            ctx,
            profile,
            node,
            requested: [{
              service: "tinycloud.delegation",
              space: spaceId === node.accountSpaceId ? "default" : spaceId,
              path: "",
              actions: ["tinycloud.delegation/revoke"],
            }],
            expiryOption: undefined,
            reason: `Revoke delegation ${cid} using its CID-bound owner-signed grant artifact`,
            yes: options.yes,
            consentAlreadyGiven: true,
            persist: false,
          });
          commandAuthorityCid = acquired?.cid;
        };
        if (!rawAuthorityCovered) {
          try {
            const acquired = await ensureDelegationAuthority({
              ctx,
              profile,
              node,
              requested: [revokePermission],
              expiryOption: undefined,
              reason: `Revoke delegation ${cid}`,
              yes: options.yes,
              consentAlreadyGiven: true,
              persist: false,
            });
            commandAuthorityCid = acquired?.cid;
          } catch (error) {
            if (
              error === null || typeof error !== "object" ||
              !("code" in error) || error.code !== "RAW_RECAP_RESOURCE_UNSUPPORTED"
            ) {
              throw error;
            }
            const fallbackSpace = boundSpace ?? await resolveCidBoundTargetSpace({
              profileName: ctx.profile,
              ownerDid: profile.ownerDid ?? ownerDidFromSpace(node.accountSpaceId) ?? ownerDidFromSpace(profile.spaceId),
              cid,
            });
            if (!fallbackSpace) {
              throw new CLIError(
                "RAW_RECAP_RESOURCE_UNSUPPORTED",
                `Cannot safely revoke "${cid}": raw CID ReCap resources are unavailable and no matching owner-signed local grant artifact binds its space to the CID.`,
                ExitCode.PERMISSION_DENIED,
              );
            }
            await authorizeFallbackSpace(fallbackSpace);
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
          if (
            result.error.meta?.status === 403 &&
            result.error.message.endsWith("403 - Unauthorized Revoker")
          ) {
            const profileDid = profile.ownerDid ??
              ownerDidFromSpace(node.accountSpaceId) ??
              ownerDidFromSpace(profile.spaceId) ??
              "unknown";
            throw new CLIError(
              "REVOKE_UNAUTHORIZED",
              "The node rejected this revocation: Unauthorized Revoker.",
              ExitCode.PERMISSION_DENIED,
              {
                status: 403,
                hint: `Only the delegation's grantor, its recipient, or the owner of a space it covers can revoke it. Run \`tc --profile ${ctx.profile} delegation revoke ${cid}\` from that profile (current profile: ${ctx.profile}, DID ${profileDid}).`,
              },
            );
          }
          throw cliErrorFromService(result.error);
        }
        outputJson({ cid, revoked: true, targetSpaceSource, authorityScopeSource, authorityScopeReason });
      } catch (error) {
        handleError(error);
      }
    });
}
