import { Command } from "commander";
import { createInterface } from "node:readline";
import { finishProfileLogout, prepareProfileRemoteLogout, type OpenKeyAcquisition } from "./auth.js";
import { ProfileManager } from "../config/profiles.js";
import { isInteractive, outputJson } from "../output/formatter.js";
import { handleError, CLIError, cliErrorFromService } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { revokeDelegationOnNode } from "../lib/revoke-delegation.js";
import { parseExpiry } from "../lib/duration.js";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { PermissionNotInManifestError, type AccountDelegationRecord, type TinyCloudNode } from "@tinycloud/node-sdk";

type DelegationQueryOptions = { direction: "granted" | "received" | "all"; space?: string };

/** Every page of the account delegation query, stopping early once `until` is seen. */
async function queryDelegations(
  node: TinyCloudNode,
  options: DelegationQueryOptions,
  until?: string,
): Promise<AccountDelegationRecord[]> {
  const found: AccountDelegationRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await node.account.delegations.query({ ...options, limit: 100, cursor });
    if (!page.ok) {
      if (page.error.code === "PERMISSION_DENIED") {
        throw new CLIError(
          "PERMISSION_DENIED",
          `This session cannot read delegations: it lacks tinycloud.delegation/list. Run \`${CLI_NAME} auth login\` again to grant it.`,
          ExitCode.PERMISSION_DENIED,
        );
      }
      throw cliErrorFromService(page.error);
    }
    found.push(...page.data.items);
    cursor = page.data.nextCursor;
  } while (cursor && !(until && found.some((d) => d.cid === until)));
  return found;
}

function listedDelegation(d: AccountDelegationRecord) {
  const resources = d.resources.map((r) => {
    const [space, service, ...path] = r.resource.split("/");
    return { space, service, path: path.join("/"), actions: r.actions };
  });
  return {
    cid: d.cid,
    delegatee: d.delegateDid,
    delegator: d.delegatorDid,
    direction: d.direction,
    status: d.status,
    expiry: d.expiresAt?.toISOString() ?? null,
    resources,
  };
}

const ISSUED_ORDER_NOTE = "Delegations are ordered by id, not by time.";
const ALREADY_REVOKED_NOTE = "This delegation was already revoked; nothing changed.";

/** Maps the SDK's issued-delegation errors to CLI errors; everything else takes the common mapping. */
function issuedFailure(
  error: { code: string; message: string; meta?: Record<string, unknown> },
  host: string,
): CLIError {
  if (error.code === "UNSUPPORTED_OPERATION") {
    return new CLIError(
      "ISSUED_DELEGATIONS_UNAVAILABLE",
      `${host} does not support listing the delegations you issued yet.`,
      ExitCode.NODE_ERROR,
    );
  }
  if (error.code === "CHAIN_TOO_DEEP") {
    return new CLIError(
      "CHAIN_TOO_DEEP",
      "A delegation chain is too deep for the node to evaluate right now. Try again later.",
      ExitCode.NODE_ERROR,
      { status: 503 },
    );
  }
  if (error.code === "INVALID_CURSOR") {
    return new CLIError(
      "INVALID_CURSOR",
      "The node rejected the page cursor while listing delegations. Run the command again.",
      ExitCode.NODE_ERROR,
      { status: 400 },
    );
  }
  return cliErrorFromService(error);
}

/**
 * Revokes a delegation this profile's own key issued, with a revocation signed by that key and no
 * proof. A delegation already listed as revoked is reported as such without a second revocation.
 */
async function revokeIssuedDelegation(node: TinyCloudNode, ctx: { profile: string; host: string }, cid: string) {
  // Best effort: a node without the issued listing still revokes, it just cannot say "already revoked".
  const known = await node.delegationManager.queryAllIssued({ untilCid: cid });
  if (known.ok && known.data.find((d) => d.cid === cid)?.status === "revoked") {
    return { cid, revoked: true as const, alreadyRevoked: true, note: ALREADY_REVOKED_NOTE };
  }
  const result = await node.delegationManager.revokeIssued(cid);
  if (result.ok) return { cid: result.data.cid, revoked: true as const };
  if (result.error.code === "PERMISSION_DENIED") {
    throw new CLIError(
      "REVOKE_UNAUTHORIZED",
      `The node rejected this revocation: ${result.error.message}.`,
      ExitCode.PERMISSION_DENIED,
      {
        status: 403,
        hint: `A delegate profile can revoke only delegations its own key issued. List them with \`${CLI_NAME} --profile ${ctx.profile} delegation list --granted\`.`,
      },
    );
  }
  if (result.error.code === "NOT_FOUND") {
    throw new CLIError("TARGET_NOT_FOUND", `Delegation "${cid}" was not found by the node.`, ExitCode.NOT_FOUND);
  }
  throw issuedFailure(result.error, ctx.host);
}

async function confirmCurrentSessionRevoke(yes: boolean): Promise<void> {
  if (yes) return;
  const warning = "This is your current sign-in session; revoking it signs you out";
  if (!isInteractive() || !process.stdin.isTTY) {
    throw new CLIError("CONFIRMATION_REQUIRED", `${warning}. Re-run with --yes to confirm.`, ExitCode.USAGE_ERROR);
  }
  process.stderr.write(`${warning}.\n`);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => prompt.question("Revoke this session? [y/N] ", resolve));
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new CLIError("REQUEST_CANCELLED", "Current session revocation cancelled.", ExitCode.ERROR);
    }
  } finally {
    prompt.close();
  }
}

export function registerDelegationCommand(
  program: Command,
  configuration: { openKeyAcquisition?: OpenKeyAcquisition } = {},
): void {
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

        const actions: string[] = options.actions.split(",").map((a: string) => {
          const trimmed = a.trim();
          return trimmed.startsWith("tinycloud.") ? trimmed : `tinycloud.${trimmed}`;
        });
        const byService: Record<string, string[]> = {};
        for (const action of actions) {
          const slash = action.indexOf("/");
          if (slash <= "tinycloud.".length || slash === action.length - 1) {
            throw new CLIError("USAGE_ERROR", `Invalid action "${action}"; use service/action, e.g. kv/get`, ExitCode.USAGE_ERROR);
          }
          (byService[action.slice(0, slash)] ??= []).push(action);
        }

        const expiry = parseExpiry(options.expiry);
        // `tc profile show` prints a did:key with a #fragment; the node wants the bare DID.
        const recipient = options.to.split("#")[0];

        // delegateTo signs the delegation and activates it with the node
        // (POST /delegate); the node does not serve tinycloud.delegation/create.
        // The space must be explicit: an entry without one targets the
        // "applications" space, not the session's default space.
        const { delegation: created } = await node.delegateTo(
          recipient,
          Object.entries(byService).map(([service, serviceActions]) => ({
            service,
            space: "default",
            path: options.path,
            actions: serviceActions,
          })),
          { expiry: expiry.getTime() - Date.now(), requireActivation: true },
        ).catch((error: unknown) => {
          if (error instanceof PermissionNotInManifestError) {
            const needed = error.missing
              .map((m) => `${m.actions.join(", ")} on space "${m.space ?? "default"}" path "${m.path}"`)
              .join("; ");
            throw new CLIError(
              "PERMISSION_DENIED",
              `This session cannot delegate what was requested. Missing: ${needed}. Sign in again with these permissions.`,
              ExitCode.PERMISSION_DENIED,
            );
          }
          throw error;
        });

        // Read back through the node before reporting success.
        const confirmed = (await queryDelegations(node, { direction: "granted" }, created.cid)).find((d) => d.cid === created.cid);
        if (confirmed?.status !== "active") {
          throw new CLIError(
            "DELEGATION_NOT_CONFIRMED",
            confirmed
              ? `The node lists delegation ${created.cid} as ${confirmed.status}, not active; treat it as not created.`
              : `The node accepted delegation ${created.cid} but does not list it; treat it as not created.`,
            ExitCode.ERROR,
          );
        }

        outputJson({
          cid: created.cid,
          delegateDid: recipient,
          delegatorDid: confirmed.delegatorDid,
          path: options.path,
          actions,
          expiry: created.expiry.toISOString(),
          status: confirmed.status,
        });
      } catch (error) {
        return handleError(error);
      }
    });

  delegation
    .command("list")
    .description("List delegations")
    .option("--granted", "Show only delegations I've granted")
    .option("--received", "Show only delegations I've received")
    .option("--space <space>", "Filter by space name or ID")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        if (options.granted && options.received) {
          throw new CLIError("USAGE_ERROR", "Use only one of --granted or --received.", ExitCode.USAGE_ERROR);
        }
        if (options.granted && ctx.posture === "delegate-session") {
          // A delegate's `--granted` is what its own key issued: the node answers it for that key alone.
          const issued = await node.delegationManager.queryAllIssued({ space: options.space });
          if (!issued.ok) throw issuedFailure(issued.error, ctx.host);
          outputJson({
            delegations: issued.data.map(listedDelegation),
            count: issued.data.length,
            note: ISSUED_ORDER_NOTE,
          });
          return;
        }
        // The node's account delegation query (POST /delegation/query). Unlike
        // `account delegations list`, it includes delegations signed by a session key.
        const delegations = await queryDelegations(node, {
          direction: options.granted ? "granted" : options.received ? "received" : "all",
          space: options.space,
        });

        outputJson({
          delegations: delegations.map(listedDelegation),
          count: delegations.length,
        });
      } catch (error) {
        return handleError(error);
      }
    });

  delegation
    .command("info <cid>")
    .description("Get delegation details")
    .option("--space <space>", "Filter by space name or ID")
    .action(async (cid: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx);

        // The node has no per-CID read; look the CID up in the account delegation query.
        const found = (await queryDelegations(node, { direction: "all", space: options.space })).find((d) => d.cid === cid);
        if (!found) {
          throw new CLIError("NOT_FOUND", `Delegation "${cid}" not found in this account's delegations`, ExitCode.NOT_FOUND);
        }

        outputJson(listedDelegation(found));
      } catch (error) {
        return handleError(error);
      }
    });

  delegation
    .command("revoke <cid>")
    .description("Revoke a delegation")
    .option("--yes", "Confirm revoking the current sign-in session or skip local-key TTY permission confirmation", false)
    .action(async (cid: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        if (ctx.posture === "delegate-session") {
          // A delegate revokes what its own key issued; it never asks its owner for revoke authority.
          outputJson(await revokeIssuedDelegation(await ensureAuthenticated(ctx), ctx, cid));
          return;
        }
        const session = await ProfileManager.getSession(ctx.profile);
        const currentSession = session && "delegationCid" in session && session.delegationCid === cid;
        if (currentSession) await confirmCurrentSessionRevoke(options.yes === true);
        const prepared = currentSession ? await prepareProfileRemoteLogout(ctx, cid) : undefined;
        // The prepared node restored the exact retained session without a
        // replica runtime; ordinary SDK creation must not bypass the marker.
        const node = prepared?.node ?? await ensureAuthenticated(ctx);
        const profile = prepared?.profile ?? await ProfileManager.getProfile(ctx.profile);
        const revoked = await revokeDelegationOnNode({
          ctx, node, profile, cid, yes: options.yes === true || Boolean(currentSession),
          openKeyAcquisition: configuration.openKeyAcquisition,
        });
        const replicasRemoved = prepared
          ? await finishProfileLogout(ctx, { online: prepared, expectedSessionCid: cid })
          : undefined;
        outputJson({
          ...revoked,
          ...(replicasRemoved === undefined ? {} : { signedOut: true, replicasRemoved }),
        });
      } catch (error) {
        return handleError(error);
      }
    });
}
