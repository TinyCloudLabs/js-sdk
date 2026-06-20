import { Command } from "commander";
import open from "open";
import { readFile } from "node:fs/promises";
import type { AccountDelegation, Manifest, SqlValue } from "@tinycloud/node-sdk";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { CLIError, handleError } from "../output/errors.js";
import { formatTable, outputJson, shouldOutputJson } from "../output/formatter.js";
import { theme } from "../output/theme.js";

const ACCOUNT_BILLING_URL = "https://account.tinycloud.xyz/billing";

export function registerAccountCommand(program: Command): void {
  const account = program.command("account").description("Account applications, delegations, and billing");

  account
    .command("status")
    .description("Show account status")
    .action(async (_options, cmd) => {
      try {
        const node = await authenticatedNode(cmd);
        const status = await node.account.status();
        assertOk(status);
        outputJson(status.data);
      } catch (error) {
        handleError(error);
      }
    });

  const apps = account.command("apps").description("Manage account application registry");

  apps
    .command("list")
    .description("List applications registered under account/applications")
    .option("--index", "Read from the materialized account SQLite index")
    .action(async (_options, cmd) => {
      try {
        const options = _options as { index?: boolean };
        const node = await authenticatedNode(cmd);
        const result = options.index
          ? await node.account.index.applications.list()
          : await node.account.applications.list();
        assertOk(result);
        const payload = { applications: result.data, count: result.data.length };
        if (shouldOutputJson()) {
          outputJson(payload);
          return;
        }
        if (result.data.length === 0) {
          process.stdout.write(theme.muted("No account applications registered.") + "\n");
          return;
        }
        process.stdout.write(
          formatTable(
            ["App ID", "Name", "Manifests", "Updated"],
            result.data.map((app) => [
              app.appId,
              app.name ?? "—",
              String(app.manifests.length),
              app.updatedAt ?? "—",
            ]),
          ) + "\n",
        );
      } catch (error) {
        handleError(error);
      }
    });

  apps
    .command("info <app-id>")
    .description("Show a registered account application")
    .action(async (appId: string, _options, cmd) => {
      try {
        const node = await authenticatedNode(cmd);
        const result = await node.account.applications.get(appId);
        assertOk(result);
        outputJson(result.data);
      } catch (error) {
        handleError(error);
      }
    });

  apps
    .command("register <manifest>")
    .description("Register an app manifest in account/applications")
    .action(async (manifestSource: string, _options, cmd) => {
      try {
        const node = await authenticatedNode(cmd);
        const manifest = await loadManifestSource(manifestSource);
        const result = await node.account.applications.register(manifest);
        assertOk(result);
        outputJson({ application: result.data, registered: true });
      } catch (error) {
        handleError(error);
      }
    });

  apps
    .command("remove <app-id>")
    .alias("delete")
    .description("Remove an application registry entry")
    .action(async (appId: string, _options, cmd) => {
      try {
        const node = await authenticatedNode(cmd);
        const result = await node.account.applications.remove(appId);
        assertOk(result);
        outputJson({ appId, removed: true });
      } catch (error) {
        handleError(error);
      }
    });

  const delegations = account.command("delegations").description("View and revoke account delegations");

  delegations
    .command("list")
    .description("List delegations granted by or to this account")
    .option("--granted", "Show only delegations granted by this account")
    .option("--received", "Show only delegations granted to this account")
    .option("--space <space>", "Filter by space name or ID")
    .option("--index", "Read from the materialized account SQLite index")
    .action(async (options, cmd) => {
      try {
        if (options.granted && options.received) {
          throw new CLIError("USAGE_ERROR", "Use only one of --granted or --received.", ExitCode.USAGE_ERROR);
        }
        const node = await authenticatedNode(cmd);
        const direction = options.granted ? "granted" : options.received ? "received" : "all";
        const result = options.index
          ? await node.account.index.delegations.list({ direction, space: options.space })
          : await node.account.delegations.list({ direction, space: options.space });
        assertOk(result);
        const payload = { delegations: result.data.map(formatDelegation), count: result.data.length };
        if (shouldOutputJson()) {
          outputJson(payload);
          return;
        }
        if (result.data.length === 0) {
          process.stdout.write(theme.muted("No delegations found.") + "\n");
          return;
        }
        process.stdout.write(
          formatTable(
            ["CID", "Direction", "Space", "Counterparty", "Status", "Expiry"],
            result.data.map((delegation) => [
              delegation.cid,
              delegation.direction,
              delegation.spaceName ?? delegation.spaceId,
              delegation.counterpartyDid,
              delegation.status,
              delegation.expiry.toISOString(),
            ]),
          ) + "\n",
        );
      } catch (error) {
        handleError(error);
      }
    });

  delegations
    .command("revoke <cid>")
    .description("Revoke an active delegation granted by this account")
    .requiredOption("--space <space>", "Space name or ID containing the delegation")
    .action(async (cid: string, options, cmd) => {
      try {
        const node = await authenticatedNode(cmd);
        const result = await node.account.delegations.revoke({ cid, space: options.space });
        assertOk(result);
        outputJson({ cid, space: options.space, revoked: true });
      } catch (error) {
        handleError(error);
      }
    });

  const index = account.command("index").description("Manage the materialized account SQLite index");

  index
    .command("rebuild")
    .description("Rebuild account SQLite index from canonical account data")
    .action(async (_options, cmd) => {
      try {
        const node = await authenticatedNode(cmd);
        const result = await node.account.index.rebuild();
        assertOk(result);
        outputJson(result.data);
      } catch (error) {
        handleError(error);
      }
    });

  index
    .command("query <sql>")
    .description("Query the materialized account SQLite index")
    .option("--params <json>", "Bind parameters as a JSON array for ? placeholders")
    .action(async (sql: string, options, cmd) => {
      try {
        const node = await authenticatedNode(cmd);
        const params = parseParams(options.params);
        const result = await node.account.index.query(sql, params);
        assertOk(result);
        outputJson(result.data);
      } catch (error) {
        handleError(error);
      }
    });

  const billing = account.command("billing").description("Open account billing");

  for (const name of ["status", "checkout", "portal"]) {
    billing
      .command(name)
      .description(`${name === "status" ? "Show" : "Open"} account billing page`)
      .option("--open", "Open account.tinycloud.xyz in your browser")
      .action(async (options) => {
        try {
          if (options.open) {
            await open(ACCOUNT_BILLING_URL);
          }
          outputJson({ url: ACCOUNT_BILLING_URL, opened: Boolean(options.open) });
        } catch (error) {
          handleError(error);
        }
      });
  }
}

async function authenticatedNode(cmd: Command) {
  const globalOpts = cmd.optsWithGlobals();
  const ctx = await ProfileManager.resolveContext(globalOpts);
  return ensureAuthenticated(ctx);
}

function assertOk<T>(result: { ok: true; data: T } | { ok: false; error: { code: string; message: string } }): asserts result is { ok: true; data: T } {
  if (!result.ok) {
    throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
  }
}

async function loadManifestSource(source: string): Promise<Manifest | Manifest[]> {
  const raw = /^https?:\/\//i.test(source)
    ? await fetchManifest(source)
    : await readFile(source, "utf8");
  return JSON.parse(raw) as Manifest | Manifest[];
}

async function fetchManifest(source: string): Promise<string> {
  const response = await fetch(source);
  if (!response.ok) {
    throw new CLIError(
      "MANIFEST_FETCH_FAILED",
      `Failed to fetch manifest from ${source}: ${response.status} ${response.statusText}`,
      ExitCode.NETWORK_ERROR,
    );
  }
  return response.text();
}

function parseParams(input: string | undefined): SqlValue[] | undefined {
  if (!input) return undefined;
  const parsed = JSON.parse(input);
  if (!Array.isArray(parsed)) {
    throw new CLIError("INVALID_PARAMS", "--params must be a JSON array.", ExitCode.USAGE_ERROR);
  }
  return parsed as SqlValue[];
}

function formatDelegation(delegation: AccountDelegation) {
  return {
    cid: delegation.cid,
    direction: delegation.direction,
    spaceId: delegation.spaceId,
    spaceName: delegation.spaceName,
    counterpartyDid: delegation.counterpartyDid,
    delegateDid: delegation.delegateDid,
    delegatorDid: delegation.delegatorDid,
    path: delegation.path,
    actions: delegation.actions,
    expiry: delegation.expiry.toISOString(),
    status: delegation.status,
    createdAt: delegation.createdAt?.toISOString(),
  };
}
