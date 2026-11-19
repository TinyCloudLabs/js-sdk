import { Command } from "commander";
import { ProfileManager } from "../config/profiles.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { resolveFeedSpace } from "../feed/space.js";
import { outputJson } from "../output/formatter.js";
import { handleError } from "../output/errors.js";
import {
  listHookWebhooks, registerHookWebhook, removeHookWebhook, resolveHooksRegister,
} from "../hooks/webhooks.js";

function collectOption(next: string, previous: string[]): string[] {
  return [...previous, next];
}

async function context(command: Command) {
  const opts = command.optsWithGlobals();
  const profile = await ProfileManager.resolveContext(opts);
  const node = await ensureAuthenticated(profile);
  // Without --space the webhook is on the primary space.
  const space = opts.space === undefined ? node.spaceId : await resolveFeedSpace(node.spaceId, opts.space, profile.profile);
  if (!space) throw new Error("Hooks need an explicit space (--space)");
  return { node, space };
}

export function registerHooksCommand(program: Command): void {
  const hooks = program.command("hooks").description("Webhooks that call a URL when data in a space changes")
    .addHelpText("after", `
Header values are credentials: they are stored encrypted by the node, listed by name only and never shown
again. Prefer --header-env, --header-file or --header-stdin to --header, because command lines are visible
to other processes. Names the transport owns (Host, Content-Length, Content-Type, Cookie, X-TinyCloud-*, ...)
are refused.

Examples:
  tinycloud hooks register --service sql --path-prefix <db> --url https://example.com/wake \\
    --header-env "Authorization=WAKE_AUTH" --space applications
  tinycloud hooks list --space applications
  tinycloud hooks remove <id>
`);

  hooks.command("register").description("Register a webhook; custom headers are sent with every delivery")
    .requiredOption("--service <service>", "Service to watch: kv, sql or duckdb")
    .requiredOption("--url <url>", "https URL to call")
    .option("--path-prefix <prefix>", "Only writes under this key or database prefix")
    .option("--space <name|uri>", "Space to watch (default: the primary space)")
    .option("--header <name:value>", "Header to send with each delivery, repeatable (e.g. 'Authorization: Bearer KEY')", collectOption, [])
    .option("--header-env <name=ENV_VAR>", "Header whose value is read from an environment variable, repeatable", collectOption, [])
    .option("--header-file <name=path>", "Header whose value is read from a file, repeatable", collectOption, [])
    .option("--header-stdin <name>", "Header whose value is read from stdin (one header only)", collectOption, [])
    .option("--secret-env <ENV_VAR>", "Environment variable holding the HMAC signing secret (default: generate one and show it once)")
    .action(async (options, command) => {
      try {
        // Every check and every header value is resolved before anything is sent.
        const input = await resolveHooksRegister(options);
        const { node, space } = await context(command);
        outputJson(await registerHookWebhook(node.hooks, space, input));
      } catch (error) { return handleError(error); }
    });

  hooks.command("list").description("List webhooks: header names are shown, values never are")
    .option("--space <name|uri>", "Space to list (default: the primary space)")
    .option("--service <service>", "Only this service: kv, sql or duckdb")
    .option("--path-prefix <prefix>", "Only this prefix (needs --service)")
    .action(async (options, command) => {
      try {
        const { node, space } = await context(command);
        outputJson(await listHookWebhooks(node.hooks, space, options));
      } catch (error) { return handleError(error); }
    });

  hooks.command("remove <id>").description("Remove a webhook")
    .option("--space <name|uri>", "Space of the webhook (default: the primary space)")
    .option("--service <service>", "Service the webhook watches: kv, sql or duckdb")
    .option("--path-prefix <prefix>", "Prefix the webhook watches (needs --service)")
    .action(async (id: string, options, command) => {
      try {
        const { node, space } = await context(command);
        outputJson(await removeHookWebhook(node.hooks, space, id, options));
      } catch (error) { return handleError(error); }
    });
}
