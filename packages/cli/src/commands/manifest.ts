import { resolveManifestKnowledgeRoot } from "@tinycloud/sdk-core";
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { ProfileManager } from "../config/profiles.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { resolveSpaceUri } from "../lib/space.js";
import { outputJson, shouldOutputJson, formatTable } from "../output/formatter.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { theme } from "../output/theme.js";

interface ManifestPermission {
  service: string;
  path: string;
  actions: string[];
  skipPrefix?: boolean;
  description?: string;
}

interface Manifest {
  manifest_version?: number;
  app_id?: string;
  name?: string;
  description?: string;
  space?: string;
  defaults?: boolean;
  knowledge?: true | string;
  permissions?: ManifestPermission[];
}

/**
 * Default space for app data when the manifest omits `space`.
 * Mirrors the manifest spec at repositories/listen/SPEC-manifest-and-capability-chain.md.
 */
const DEFAULT_APP_SPACE = "applications";

export function registerManifestCommand(program: Command): void {
  const manifest = program
    .command("manifest")
    .description("Inspect TinyCloud app manifests");

  manifest
    .command("resolve <source>")
    .description("Resolve a manifest file or URL to its effective space, paths, and DB basenames")
    .addHelpText("after", `

Examples:
  $ tc manifest resolve ./manifest.json
  $ tc manifest resolve https://app.example.com/manifest.json --json

What it shows:
  - app_id, name, manifest_version
  - effective space name (default: "applications") and full space URI for the active profile
  - per-permission: service, fully-qualified path, actions
  - inferred SQL database basenames for sql/<db>/... paths

This command is read-only and does NOT contact the node — it just resolves
the manifest against the active profile's address/chain so you know which
\`--space\` and \`--db\` values to pass to other tc commands.
`)
    .action(async (source: string, _options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);

        const raw = await loadManifestSource(source);
        const parsed: Manifest = JSON.parse(raw);

        if (!parsed.app_id) {
          throw new CLIError(
            "INVALID_MANIFEST",
            `Manifest is missing required field "app_id".`,
            ExitCode.ERROR,
          );
        }

        // Make sure we have an authenticated profile so we can resolve
        // the user's space URI. We don't use the node — just the profile.
        await ensureAuthenticated(ctx);

        const spaceName = parsed.space ?? DEFAULT_APP_SPACE;
        const spaceUri = await resolveSpaceUri(spaceName, ctx.profile);
        const knowledgeRoot = resolveManifestKnowledgeRoot(parsed.knowledge);

        const permissions = (parsed.permissions ?? []).map((p) => {
          const resolvedPath = p.skipPrefix ? p.path : prefixWithAppId(p.path, parsed.app_id!);
          return {
            service: p.service,
            path: resolvedPath,
            actions: p.actions,
            sqlDb: extractSqlDbName(resolvedPath),
          };
        });

        const sqlDbs = unique(
          permissions
            .map((p) => p.sqlDb)
            .filter((db): db is string => Boolean(db)),
        );

        const summary = {
          source,
          app_id: parsed.app_id,
          name: parsed.name,
          manifest_version: parsed.manifest_version,
          knowledgeRoot,
          space: {
            name: spaceName,
            uri: spaceUri,
          },
          permissions,
          sqlDatabases: sqlDbs,
        };

        if (shouldOutputJson()) {
          outputJson(summary);
          return;
        }

        process.stdout.write(`${theme.heading("Manifest")}: ${theme.value(parsed.app_id)}`);
        if (parsed.name) process.stdout.write(theme.muted(` (${parsed.name})`));
        process.stdout.write("\n");

        process.stdout.write(`${theme.label("Space")}: ${theme.value(spaceName)}\n`);
        if (spaceUri) {
          process.stdout.write(`${theme.label("Space URI")}: ${theme.value(spaceUri)}\n`);
        }
        if (knowledgeRoot) {
          process.stdout.write(`${theme.label("Knowledge")}: ${theme.value(knowledgeRoot)}\n`);
        }

        if (sqlDbs.length > 0) {
          process.stdout.write(`\n${theme.heading("SQL databases")}\n`);
          for (const db of sqlDbs) {
            process.stdout.write(`  ${theme.value(db)}\n`);
          }
          process.stdout.write(theme.muted(`\nUse with: tc sql query --space ${spaceName} --db <db> "..."\n`));
        }

        if (permissions.length > 0) {
          process.stdout.write(`\n${theme.heading("Permissions")}\n`);
          const rows = permissions.map((p) => [p.service, p.path, p.actions.join(", ")]);
          process.stdout.write(formatTable(["service", "path", "actions"], rows) + "\n");
        }
      } catch (error) {
        handleError(error);
      }
    });
}

async function loadManifestSource(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
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
  return readFile(source, "utf8");
}

function prefixWithAppId(path: string, appId: string): string {
  // Manifest paths are usually `<service-prefix>/<resource>`, e.g. `sql/foo/bar`.
  // When skipPrefix is false the app_id is inserted between the service prefix
  // and the resource, matching how resolveAppPath() lays out keys at runtime.
  const slash = path.indexOf("/");
  if (slash === -1) return `${appId}/${path}`;
  const head = path.slice(0, slash);
  const tail = path.slice(slash + 1);
  return `${head}/${appId}/${tail}`;
}

/**
 * For a path like `sql/<db-name>/<table>/...`, return `<db-name>`.
 * `<db-name>` itself may contain slashes when the app namespaces it
 * (e.g. `sql/xyz.tinycloud.listen/conversations/conversation`), so we drop
 * the trailing table segment(s) and reassemble.
 */
function extractSqlDbName(path: string): string | undefined {
  if (!path.startsWith("sql/")) return undefined;
  const rest = path.slice(4);
  const segments = rest.split("/");
  if (segments.length < 2) return rest;
  // Drop the last segment (table name); the rest is the db name.
  return segments.slice(0, -1).join("/");
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
