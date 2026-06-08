import { Command } from "commander";
import { ProfileManager } from "../config/profiles.js";
import { outputJson } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { parseExpiry } from "../lib/duration.js";
import { principalDidEquals } from "@tinycloud/node-sdk";

function didMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  try {
    return principalDidEquals(actual, expected);
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
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
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
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
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

        const result = await node.delegationManager.revoke(cid);
        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        outputJson({ cid, revoked: true });
      } catch (error) {
        handleError(error);
      }
    });
}
