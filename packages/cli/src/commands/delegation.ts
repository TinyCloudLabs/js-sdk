import { Command } from "commander";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ProfileManager } from "../config/profiles.js";
import { outputJson } from "../output/formatter.js";
import { handleError, CLIError, cliErrorFromService } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { ensureDelegationAuthority } from "./auth.js";
import { parseExpiry } from "../lib/duration.js";
import { readGrantHistory } from "../lib/permissions.js";
function normalizeDid(input: string): string {
  const normalized = input.trim();
  const fragmentIndex = normalized.indexOf("#");
  return (fragmentIndex === -1 ? normalized : normalized.slice(0, fragmentIndex)).toLowerCase();
}

function didMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  try {
    return normalizeDid(actual) === normalizeDid(expected);
  } catch {
    return actual === expected;
  }
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
    .action(async (cid: string, _options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);
        const profile = await ProfileManager.getProfile(ctx.profile);
        const grantHistory = await readGrantHistory(ctx.profile);
        const recordedGrant = [...grantHistory].reverse().find((entry) => entry.delegationCid === cid);
        const delegations = await node.delegationManager.list();
        const listedTarget = delegations.ok
          ? delegations.data.find((delegation) => delegation.cid === cid)
          : undefined;
        let queriedTarget;
        let cursor: string | undefined;
        if (!listedTarget) {
          do {
            const query = await node.delegationManager.query({
              direction: "all",
              limit: 100,
              ...(cursor === undefined ? {} : { cursor }),
            });
            if (!query.ok) break;
            queriedTarget = query.data.items.find((delegation) => delegation.cid === cid);
            cursor = queriedTarget ? undefined : query.data.nextCursor;
          } while (cursor !== undefined);
        }
        const targetDelegation = listedTarget
          ? {
            spaceId: listedTarget.spaceId,
            delegatorDID: listedTarget.delegatorDID,
            delegateDID: listedTarget.delegateDID,
          }
          : queriedTarget
            ? {
              spaceId: queriedTarget.resources
                .map(({ resource }) => {
                  const separator = resource.indexOf("/");
                  return separator > 0 ? resource.slice(0, separator) : undefined;
                })
                .find((space): space is string => space !== undefined),
              delegatorDID: queriedTarget.delegatorDid,
              delegateDID: queriedTarget.delegateDid,
            }
            : undefined;
        const targetSpaceId = targetDelegation?.spaceId ??
          recordedGrant?.addedCaps.find((cap) => cap.space)?.space;
        const targetSpaceSource = targetDelegation?.spaceId ? "node" : "local-grant-history";
        if (targetSpaceId === undefined) {
          throw new CLIError(
            "TARGET_SPACE_UNKNOWN",
            `Cannot resolve the target space for delegation "${cid}"`,
            ExitCode.INVALID_ARGUMENT,
          );
        }
        const revokePermission: PermissionEntry = {
          service: "tinycloud.delegation",
          space: targetSpaceId,
          path: "",
          actions: ["tinycloud.delegation/revoke"],
        };

        if (!node.hasRuntimePermissions([revokePermission])) {
          await ensureDelegationAuthority({
            ctx,
            profile,
            node,
            requested: [revokePermission],
            expiryOption: undefined,
            reason: `Revoke delegation ${cid}`,
            // Running this explicit command is consent to acquire its one
            // required ability; no general session or manifest is widened.
            yes: true,
          });
        }

        const result = await node.delegationManager.revoke(cid, {
          targetSpaceId,
          ...(targetDelegation === undefined ? {} : {
            targetDelegation: {
              delegatorDID: targetDelegation.delegatorDID,
              delegateDID: targetDelegation.delegateDID,
            },
          }),
        });
        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        outputJson({ cid, revoked: true, targetSpaceSource });
      } catch (error) {
        handleError(error);
      }
    });
}
