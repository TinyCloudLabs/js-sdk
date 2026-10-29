import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendFeedResponse, feedCardSchema, feedHandlingSchema, feedResourceNames, feedResponsePayloadSchema,
  getFeedCardState, initializeFeedDatabases, listFeedCards, listFeedResponses,
  listenFeedResponses, newFeedResponseSchema, publishFeedCard, readFeedResponsePayload, recordFeedHandling, resolveFeedCard,
} from "@tinycloud/sdk-services/feed";
import type { Result } from "@tinycloud/sdk-services";
import type { FeedResponsePayload, FeedSource, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { ProfileManager } from "../config/profiles.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { resolveFeedSpace } from "../feed/space.js";
import { parseExpiry } from "../lib/duration.js";
import { outputJson } from "../output/formatter.js";
import { cliErrorFromService, handleError } from "../output/errors.js";
import { openFeedHandoff } from "../feed/local.js";
import type { LocalFeedHandoff } from "../feed/local.js";
import { runFeedRunner } from "../feed/runner.js";
import { connectFeedAgent } from "../feed/connection.js";

const FEED_PREFIX = "xyz.tinycloud.tinychat/feed";
const REGISTRY = "xyz.tinycloud.tinychat/home_feed";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw cliErrorFromService(result.error);
  return result.data;
}

async function context(command: Command) {
  const opts = command.optsWithGlobals();
  const profile = await ProfileManager.resolveContext(opts);
  const node = await ensureAuthenticated(profile);
  const space = await resolveFeedSpace(node.spaceId, opts.space ?? "applications", profile.profile);
  if (!space) throw new Error("Feed requires an explicit owner space");
  const resources = value(feedResourceNames(FEED_PREFIX, opts.agent));
  const sql = node.sqlForSpace(space);
  return {
    profile, node, space, resources, sql,
    output: sql.db(resources.outputResource), responses: sql.db(resources.responseResource),
  };
}

function agentOptions(command: Command): Command {
  return command.requiredOption("--agent <token>", "Stable owner-scoped agent token")
    .option("--space <name|uri>", "Owner space containing the feed resources", "applications");
}

export function registerFeedCommand(program: Command): void {
  const feed = program.command("feed").description("SQLite agent cards, owner responses and durable runtime handoff")
    .addHelpText("after", `
Owner connection provisions separate output and response databases and activates one
bundled delegation. Agent labels and tokens select resources, never confer authority.
Home's owner grant uses ${FEED_PREFIX}/ (trailing slash namespace); agent grants
name exact output, response and response-hook resources. No agent schema or response write.

publish/respond/handling read JSON files carrying full card/revision/issuance and
response IDs. Retain the same response ID when retrying a saved answer. Follow-ups
are new append-only records; saving an answer is not acknowledgement or completion.

watch requires Bun or Node.js 22.13+ (built-in SQLite). --runner is a JSON argv array,
never a shell command. The runner receives allowlisted response-header JSON and must
exit zero only after durable acceptance. Uncertain delivery remains unconfirmed and
is never automatically repeated. Renewal reconciles durable rows at most every five
minutes while connected; hook notifications are wakeups, not replay or execution proof.
Private typed payloads are saved atomically with respond --payload-file and read
explicitly with feed payload. Default notifications include metadata, never payload data.
`);

  agentOptions(feed.command("connect").description("Owner: provision an agent feed and activate its exact bundled grant"))
    .requiredOption("--to <did>", "Authenticated agent DID receiving the grant")
    .requiredOption("--label <label>", "Owner registry display label")
    .option("--expiry <duration>", "Delegation expiry duration", "24h")
    .action(async (options, command) => {
      try {
        const { node, space, sql, resources, output, responses } = await context(command);
        const did = options.to.split("#")[0];
        const source: FeedSource = {
          sourceId: options.agent, agentDid: did, label: options.label,
          output: { spaceId: space, database: resources.outputResource },
          responses: { spaceId: space, database: resources.responseResource },
        };
        const delegation = await connectFeedAgent(sql.db(REGISTRY), source, async () => {
          value(await initializeFeedDatabases({ output, responses }));
          const expiry = parseExpiry(options.expiry).getTime() - Date.now();
          const { delegation } = await node.delegateTo(did, [
            { service: "tinycloud.sql", space, path: resources.outputResource, actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
            { service: "tinycloud.sql", space, path: resources.responseResource, actions: ["tinycloud.sql/read"] },
            { service: "tinycloud.hooks", space, path: `sql/${resources.responseResource}`, actions: ["tinycloud.hooks/subscribe"] },
          ], { expiry, requireActivation: true });
          return delegation;
        });
        outputJson({ source, delegation });
      } catch (error) { return handleError(error); }
    });

  agentOptions(feed.command("publish").description("Agent: publish an immutable card issuance"))
    .requiredOption("--file <path>", "Card JSON file")
    .action(async (options, command) => {
      try {
        const { output } = await context(command);
        const card = feedCardSchema.parse(JSON.parse(await readFile(options.file, "utf8")));
        outputJson(value(await publishFeedCard(output, card)));
      } catch (error) { return handleError(error); }
    });

  agentOptions(feed.command("respond").description("Owner: append a response bound to an exact card revision and issuance"))
    .requiredOption("--file <path>", "Response JSON file including its durable full responseId")
    .option("--payload-file <path>", "Private typed JSON payload envelope, stored separately from the response header")
    .action(async (options, command) => {
      try {
        const { output, responses } = await context(command);
        let response: NewFeedResponse;
        try {
          const parsed = newFeedResponseSchema.safeParse(JSON.parse(await readFile(options.file, "utf8")));
          if (!parsed.success) throw new Error("Invalid response header");
          response = parsed.data;
        } catch {
          throw new Error("Could not read a valid feed response header file");
        }
        let payload: FeedResponsePayload | undefined;
        if (options.payloadFile !== undefined) {
          try {
            const parsed = feedResponsePayloadSchema.safeParse(JSON.parse(await readFile(options.payloadFile, "utf8")));
            if (!parsed.success) throw new Error("Invalid payload envelope");
            payload = parsed.data;
          } catch {
            // JSON parser snippets and nested validation/IO causes can contain private data.
            throw new Error("Could not read a valid private feed response payload file");
          }
        }
        outputJson(value(await appendFeedResponse(output, responses, response, payload)));
      } catch (error) { return handleError(error); }
    });

  agentOptions(feed.command("handling").description("Agent: append response acknowledgement or outcome without changing owner responses"))
    .requiredOption("--file <path>", "Handling JSON including full response and card identities")
    .action(async (options, command) => {
      try {
        const { output } = await context(command);
        const handling = feedHandlingSchema.parse(JSON.parse(await readFile(options.file, "utf8")));
        outputJson(value(await recordFeedHandling(output, handling)));
      } catch (error) { return handleError(error); }
    });

  agentOptions(feed.command("list").description("List current card issuances"))
    .action(async (_options, command) => {
      try { outputJson(value(await listFeedCards((await context(command)).output))); }
      catch (error) { return handleError(error); }
    });

  agentOptions(feed.command("show <reference>").description("Read saved response, acknowledgement and outcome separately"))
    .action(async (reference: string, _options, command) => {
      try {
        const { output, responses } = await context(command);
        const identity = value(await resolveFeedCard(output, reference));
        outputJson(value(await getFeedCardState(output, responses, identity)));
      } catch (error) { return handleError(error); }
    });

  agentOptions(feed.command("responses").description("Read a durable ordered response page"))
    .option("--after <sequence>", "Exclusive sequence cursor", "0")
    .option("--limit <count>", "Maximum rows (1-1000)", "100")
    .action(async (options, command) => {
      try {
        const { responses } = await context(command);
        outputJson(value(await listFeedResponses(responses, { afterSequence: Number(options.after), limit: Number(options.limit) })));
      } catch (error) { return handleError(error); }
    });

  agentOptions(feed.command("payload").description("Explicitly read a private response payload using its full identity"))
    .requiredOption("--response <id>", "Full durable response ID")
    .requiredOption("--card <id>", "Full card ID")
    .requiredOption("--revision <number>", "Exact card revision")
    .requiredOption("--issuance <id>", "Exact card issuance ID")
    .action(async (options, command) => {
      try {
        const { responses } = await context(command);
        const payload = value(await readFeedResponsePayload(responses, {
          responseId: options.response, cardId: options.card,
          revision: Number(options.revision), issuanceId: options.issuance,
        }));
        outputJson(payload ?? null);
      } catch (error) { return handleError(error); }
    });

  agentOptions(feed.command("watch").description("Agent: deliver durable owner responses to an external argv runner"))
    .requiredOption("--recipient <id>", "Stable runtime recipient identity used by the handoff ledger")
    .requiredOption("--runner <json>", "JSON argv array, e.g. '[\"node\",\"agent-handler.js\"]'")
    .option("--handoff <path>", "Durable local SQLite handoff path (default: profile feed ledger)")
    .action(async (options, command) => {
      let local: LocalFeedHandoff | undefined;
      const abort = new AbortController();
      const stop = () => abort.abort();
      try {
        const argv: unknown = JSON.parse(options.runner);
        if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== "string") || !argv[0]) {
          throw new Error("--runner must be a nonempty JSON string argv array");
        }
        const { profile, node, space, responses, resources } = await context(command);
        const directory = await ProfileManager.ensureProfileDir(profile.profile);
        local = await openFeedHandoff(options.handoff ?? join(directory, `feed-${options.agent}.sqlite`));
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        const runner: [string, ...string[]] = [argv[0], ...argv.slice(1)];
        await listenFeedResponses({
          responses, handoff: local.handle, recipient: options.recipient, hooks: node.hooks,
          subscription: { space, service: "sql", pathPrefix: resources.responseResource },
          signal: abort.signal, deliver: (response) => runFeedRunner(runner, response, abort.signal),
        });
      } catch (error) { return handleError(error); }
      finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        local?.close();
      }
    });
}
