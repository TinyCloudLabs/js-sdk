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
function normalizeDid(input: string): string {
  const normalized = input.trim();
  const fragmentIndex = normalized.indexOf("#");
  return (fragmentIndex === -1 ? normalized : normalized.slice(0, fragmentIndex)).toLowerCase();
}
function didMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  return normalizeDid(actual) === normalizeDid(expected);
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
        return handleError(error);
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
        return handleError(error);
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
