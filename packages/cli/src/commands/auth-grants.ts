import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { TinyCloudNode, type PermissionEntry } from "@tinycloud/node-sdk";
import { DelegationRequestBindingSchema, PermissionEntrySchema } from "@tinycloud/operations/artifacts";
import {
  inspectStoredDelegation,
  operationSpaceResolver,
  storedDelegationKind,
  storedDelegationForAnotherKey,
  storedDelegationSource,
  withoutBearer,
  type StoredDelegationInspection,
  type StoredDelegationSource,
} from "@tinycloud/operations/delegation-binding";
import { ProfileManager } from "../config/profiles.js";
import { resolveProfilePosture, type CLIContext, type ProfileConfig } from "../config/types.js";
import { ExitCode } from "../config/constants.js";
import { loadAdditionalDelegations, removeStoredDelegations, type StoredAdditionalDelegation } from "../lib/permissions.js";
import { ensureAuthenticated, restoreProfileSessionNode } from "../lib/sdk.js";
import { revokeDelegationOnNode } from "../lib/revoke-delegation.js";
import { discardWarnings } from "../output/warnings.js";
import { CLIError, handleError, wrapError } from "../output/errors.js";
import { formatTable, outputJson, shouldOutputJson } from "../output/formatter.js";
import type { OpenKeyAcquisition } from "./auth.js";

const CID = /^bafkr4i[a-z2-7]{52}$/;

interface ListedGrant {
  index: number;
  cid: string | null;
  expiry: string | null;
  expired: boolean;
  local: StoredDelegationInspection["local"] | "for_another_key";
  reason: string | null;
  node: "not_checked";
  bound: boolean;
  proof: "siwe" | "compact" | "missing" | null;
  source: StoredDelegationSource;
  scope: readonly PermissionEntry[];
  scopeSource: "signed" | "stored";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Resolve a profile without host discovery: `list` must never probe any node. */
async function localContext(options: { profile?: string; host?: string }): Promise<{ ctx: CLIContext; profile: ProfileConfig }> {
  const profileName = options.profile ?? process.env.TC_PROFILE ?? (await ProfileManager.getConfig()).defaultProfile;
  const profile = await ProfileManager.getProfile(profileName);
  const ctx = await ProfileManager.resolveContext({
    ...options,
    profile: profileName,
    host: options.host ?? process.env.TC_HOST ?? profile.host,
  });
  return { ctx, profile };
}

function storedScope(value: unknown): readonly PermissionEntry[] {
  const parsed = PermissionEntrySchema.array().safeParse(record(value)?.permissions);
  return parsed.success ? parsed.data : [];
}

function storedProof(value: unknown): ListedGrant["proof"] {
  const kind = storedDelegationKind(value);
  if (kind === "signed-login") return "siwe";
  if (kind === "compact") return "compact";
  if (kind === "other") return "missing";
  const header = record(record(record(value)?.delegation)?.delegationHeader)?.Authorization;
  if (typeof header !== "string") return null;
  return withoutBearer(header).includes(".") ? "compact" : "missing";
}

async function listedGrant(
  value: unknown,
  index: number,
  options: NonNullable<Parameters<typeof inspectStoredDelegation>[1]>,
): Promise<ListedGrant> {
  const delegation = record(record(value)?.delegation);
  const rawCid = delegation?.cid;
  const expiry = isoDate(delegation?.expiry);
  const forAnotherKey = options.node !== undefined && storedDelegationForAnotherKey(value, options.node);
  const inspection = forAnotherKey ? undefined : await inspectStoredDelegation(value, options);
  const source = storedDelegationSource(value);
  return {
    index,
    cid: typeof rawCid === "string" && CID.test(rawCid) ? rawCid : null,
    expiry,
    expired: expiry !== null && Date.parse(expiry) <= Date.now(),
    local: inspection?.local ?? "for_another_key",
    reason: inspection?.local === "refused" ? inspection.reason : null,
    node: "not_checked",
    bound: DelegationRequestBindingSchema.safeParse(record(value)?.authorityRequest).success,
    proof: storedProof(value),
    source,
    scope: inspection?.local === "verified" ? inspection.effectivePermissions : storedScope(value),
    scopeSource: inspection?.local === "verified" ? "signed" : "stored",
  };
}

function localSessionCid(session: Record<string, unknown>, host: string): string | null {
  const header = record(session.delegationHeader)?.Authorization;
  const cid = session.delegationCid;
  if (typeof header !== "string" || typeof cid !== "string" || !CID.test(cid)) return null;
  try {
    return new TinyCloudNode({ host }).computeDelegationCid(header) === cid ? cid : null;
  } catch {
    return null;
  }
}

function renderList(result: {
  profile: string;
  session: { cid: string | null; expiresAt: string | null } | null;
  localVerification: "available" | "session_missing" | "session_expired" | "session_invalid";
  grants: ListedGrant[];
}): void {
  if (shouldOutputJson()) {
    outputJson(result);
    return;
  }
  process.stdout.write(`Profile: ${result.profile}\n`);
  process.stdout.write(`Session CID: ${result.session?.cid ?? "unavailable"}` +
    (result.session?.cid ? ` (revoke with ${CLI_NAME} delegation revoke ${result.session.cid})\n` : "\n"));
  process.stdout.write(`Local verification: ${result.localVerification}; node validation and revocation are not checked.\n`);
  process.stdout.write(formatTable(
    ["CID", "LOCAL", "EXPIRES", "SOURCE", "BOUND", "SCOPE"],
    result.grants.map((grant) => [
      grant.cid ?? "—",
      grant.local === "refused" ? `refused (${grant.reason})` :
        grant.local === "for_another_key" ? "for another key (not installable here)" : grant.local,
      grant.expiry ?? "—",
      grant.source,
      grant.bound ? "yes" : "no",
      grant.scope.map((permission) => `${permission.service}:${permission.space ?? "default"}:${permission.path}:${permission.actions.join(",")}`).join("; ") || "—",
    ]),
  ) + "\n");
}

/** Register local stored-grant inspection and owner-only revocation below `auth`. */
export function registerAuthGrantsCommand(
  auth: Command,
  options: { openKeyAcquisition?: OpenKeyAcquisition } = {},
): void {
  const grants = auth.command("grants").description("Inspect and remove locally stored grants");

  grants.command("list")
    .description("Inspect locally stored grants without asking the node (node chain and revocation remain unchecked)")
    .action(async (_options, cmd: Command) => {
      try {
        const { ctx, profile } = await localContext(cmd.optsWithGlobals());
        const session = record(await ProfileManager.getSession(ctx.profile));
        const restored = await restoreProfileSessionNode(ctx);
        const node = "node" in restored ? restored.node : undefined;
        const entries: readonly unknown[] = await loadAdditionalDelegations(ctx.profile);
        const grants = await Promise.all(entries.map((entry, index) => listedGrant(entry, index, {
          node,
          host: ctx.host,
          ...(node ? { resolveSpace: operationSpaceResolver(node, profile.spaceId) } : {}),
        })));
        renderList({
          profile: ctx.profile,
          session: session === undefined ? null : {
            cid: localSessionCid(session, ctx.host),
            expiresAt: isoDate(session.expiresAt ?? session.expiry),
          },
          localVerification: "node" in restored ? "available" : restored.unavailable,
          grants,
        });
      } catch (error) {
        handleError(error);
      }
    });

  grants.command("remove <cid>")
    .description("Remove locally stored grants for exactly this CID; optionally revoke as the owner")
    .option("--revoke", "Revoke on the node before removing local grants")
    .option("--yes", "Skip local-key TTY confirmation", false)
    .action(async (cid: string, flags: { revoke?: boolean; yes?: boolean }, cmd: Command) => {
      try {
        const { ctx, profile } = await localContext(cmd.optsWithGlobals());
        // This gate precedes even a local lookup, consent, session restore and node requests.
        if (flags.revoke && resolveProfilePosture(profile) === "delegate-session") {
          throw new CLIError(
            "REVOKE_UNAUTHORIZED",
            "A delegate-session profile cannot revoke a stored grant. Remove it locally or ask its owner to revoke it.",
            ExitCode.PERMISSION_DENIED,
          );
        }
        if (!CID.test(cid)) {
          throw new CLIError("INVALID_ARGUMENT", "Expected a delegation CID.", ExitCode.USAGE_ERROR);
        }
        const entries = await loadAdditionalDelegations(ctx.profile);
        const matched = entries.filter((entry) => record(record(entry)?.delegation)?.cid === cid);
        if (matched.length === 0) {
          throw new CLIError("GRANT_NOT_FOUND", `No locally stored grant has CID ${cid}.`, ExitCode.NOT_FOUND);
        }

        if (flags.revoke) {
          // Unlike list and local removal, revocation uses the same verified
          // local-node discovery as `tc delegation revoke`.
          const revokeCtx = await ProfileManager.resolveContext({ ...cmd.optsWithGlobals(), profile: ctx.profile });
          const node = await ensureAuthenticated(revokeCtx);
          const resolveSpace = operationSpaceResolver(node, profile.spaceId);
          let localTarget: StoredAdditionalDelegation = matched[0]!;
          for (const candidate of matched) {
            const inspection = await inspectStoredDelegation(candidate, { node, host: revokeCtx.host, resolveSpace });
            if (inspection.local === "verified") {
              localTarget = candidate;
              break;
            }
          }
          const revoked = await revokeDelegationOnNode({
            ctx: revokeCtx, profile, node, cid, yes: flags.yes ?? false, localTarget,
            openKeyAcquisition: options.openKeyAcquisition,
          });
          let removed: number;
          try {
            removed = await removeStoredDelegations(ctx.profile, cid);
          } catch (error) {
            const cause = wrapError(error);
            if (cause.code === "GRANT_NOT_FOUND") {
              // Another local remover won the race after the node revoke.
              removed = 0;
            } else {
              throw new CLIError(
                "GRANT_REVOKED_LOCAL_REMOVE_FAILED",
                `Delegation ${cid} was revoked on the node, but its local grant could not be removed (${cause.code}).`,
                ExitCode.ERROR,
                {
                  causeCode: cause.code,
                  hint: `Do not use --revoke again. After fixing local profile storage, run: ${CLI_NAME} --profile ${ctx.profile} auth grants remove ${cid}`,
                },
              );
            }
          }
          discardWarnings(cid);
          const result = { profile: ctx.profile, cid, removed, revoked: true as const,
            targetSpaceSource: revoked.targetSpaceSource,
            authorityScopeSource: revoked.authorityScopeSource,
            authorityScopeReason: revoked.authorityScopeReason };
          if (shouldOutputJson()) outputJson(result);
          else process.stdout.write(`Revoked ${cid} and removed ${removed} local grant${removed === 1 ? "" : "s"}.\n`);
        } else {
          const removed = await removeStoredDelegations(ctx.profile, cid);
          discardWarnings(cid);
          const result = { profile: ctx.profile, cid, removed, revoked: false as const,
            warning: "Only local copies were removed; the node delegation was not revoked." };
          if (shouldOutputJson()) outputJson(result);
          else process.stdout.write(`Removed ${removed} local grant${removed === 1 ? "" : "s"} for ${cid}. The node delegation was not revoked.\n`);
        }
      } catch (error) {
        handleError(error);
      }
    });
}
