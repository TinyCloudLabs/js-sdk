import { DEFAULT_EXPIRY, parseExpiry } from "@tinycloud/sdk-core";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import type { PermissionEntry } from "@tinycloud/node-sdk";

import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { normalizePkhIdentifier } from "./space.js";

/**
 * The `auth request --preset apps-agent` grants: the one place that defines
 * what an agent picking up a user's apps may do. The request, the plain-words
 * scope notice and the tests all read the two variants below; nothing else
 * restates them.
 *
 * - `read` (the default): KV get and list, SQL read, on the whole
 *   `applications` space or on named apps (`<app_id>/`).
 * - `write` (`--write`, named apps only): adds KV put and SQL write.
 *
 * Neither grants KV delete, SQL admin or schema, any other service, or any
 * other space. The node lets `tinycloud.sql/write` run CREATE, ALTER and DROP
 * TABLE (only the SDK asks for `tinycloud.sql/schema`), so the write variant
 * says so; the read ability is enforced by the node.
 */
export const APPS_AGENT_PRESET = "apps-agent";
export const APPS_AGENT_SPACE = "applications";
export const APPS_AGENT_EXPIRY_DAYS = 7;
/** ms-format lifetime accepted by `--expiry`. */
export const APPS_AGENT_EXPIRY = `${APPS_AGENT_EXPIRY_DAYS}d`;
/** Most apps one request may name. */
export const APPS_AGENT_MAX_APPS = 5;

const DAY_MS = 86_400_000;

export type AppsAgentMode = "read" | "write";

interface PresetGrant {
  readonly service: "tinycloud.kv" | "tinycloud.sql";
  readonly actions: readonly string[];
}

interface PresetVariant {
  readonly grants: readonly PresetGrant[];
  /** Whether the variant needs named apps (`--app`). */
  readonly perAppOnly: boolean;
  /** Whether the granted actions let the agent change or drop tables, not only rows. */
  readonly changesStructure: boolean;
}

export const APPS_AGENT_VARIANTS: Readonly<Record<AppsAgentMode, PresetVariant>> = {
  read: {
    grants: [
      { service: "tinycloud.kv", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
      { service: "tinycloud.sql", actions: ["tinycloud.sql/read"] },
    ],
    perAppOnly: false,
    changesStructure: false,
  },
  write: {
    grants: [
      { service: "tinycloud.kv", actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"] },
      { service: "tinycloud.sql", actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
    ],
    perAppOnly: true,
    changesStructure: true,
  },
};

/** Plain words for every action a request can carry; unknown actions print as their name. */
const ACTION_WORDS: Readonly<Record<string, string>> = {
  "tinycloud.kv/get": "read files",
  "tinycloud.kv/list": "list files",
  "tinycloud.kv/put": "create and overwrite files",
  "tinycloud.kv/del": "delete files",
  "tinycloud.kv/metadata": "read file metadata",
  "tinycloud.sql/read": "read table rows",
  "tinycloud.sql/write": "add, change and delete table rows",
  "tinycloud.sql/schema": "create, change and drop tables",
  "tinycloud.sql/admin": "do anything in the database",
};

/** SQL actions that let the node run CREATE, ALTER or DROP TABLE. */
const STRUCTURE_ACTIONS: ReadonlySet<string> = new Set([
  "tinycloud.sql/write",
  "tinycloud.sql/schema",
  "tinycloud.sql/admin",
  "tinycloud.sql/*",
]);

/** A valid app id as the knowledge operations accept it; it becomes a key prefix. */
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const APP_ID_RULE =
  "an app id looks like xyz.example.app: letters, digits, dots, hyphens and underscores, no slashes or spaces";

export function isAppId(value: string): boolean {
  return value.length <= 200 && APP_ID.test(value);
}

/** The permission entries to request. No app ids means the whole space (read-only only). */
export function appsAgentPermissions(mode: AppsAgentMode, appIds: readonly string[] = []): PermissionEntry[] {
  const paths = appIds.length === 0 ? [""] : appIds.map((appId) => `${appId}/`);
  return APPS_AGENT_VARIANTS[mode].grants.flatMap(({ service, actions }) =>
    paths.map((path) => ({ service, space: APPS_AGENT_SPACE, path, actions: [...actions] })));
}

function quoteApps(appIds: readonly string[]): string {
  return appIds.map((appId) => `\`${appId}\``).join(", ");
}

function lifetimePhrase(ms: number): string {
  if (ms >= DAY_MS) {
    const days = Math.ceil(ms / DAY_MS);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  const hours = Math.max(1, Math.ceil(ms / 3_600_000));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function revokeSentence(lifetimeMs: number): string {
  return `It lasts up to ${lifetimePhrase(lifetimeMs)}; revoke it any time with \`${CLI_NAME} delegation revoke <id>\`.`;
}

/** Plain-words statement of exactly what a preset grant allows, shown before approval. */
export function appsAgentScopeNotice(mode: AppsAgentMode, appIds: readonly string[] = []): string {
  const variant = APPS_AGENT_VARIANTS[mode];
  const reads = variant.grants.some(({ actions }) => actions.includes("tinycloud.kv/put"))
    ? "read it and add and change its files and table rows"
    : "list and read its files and read its table rows";
  const scope = appIds.length === 0
    ? `ALL your installed apps' data in the \`${APPS_AGENT_SPACE}\` space`
    : `the data of ${quoteApps(appIds)} (everything under ${appIds.map((appId) => `\`${appId}/\``).join(", ")}) in the \`${APPS_AGENT_SPACE}\` space`;
  const lines = [
    variant.changesStructure
      ? `This gives the agent access to ${scope}: it can ${reads}.`
      : `This gives the agent READ-ONLY access to ${scope}: it can ${reads}.`,
  ];
  if (variant.changesStructure) {
    lines.push(
      `Because of how TinyCloud permissions work today, it can also change or delete ${appIds.length === 1 ? "this app's" : "these apps'"} tables (structure) and data.`,
      "It cannot touch other apps, other spaces or secrets.",
    );
  } else {
    lines.push("It cannot create, change or delete anything, and it cannot touch other spaces or secrets.");
  }
  lines.push(revokeSentence(APPS_AGENT_EXPIRY_DAYS * DAY_MS));
  return lines.join("\n");
}

export interface AppsAgentRequestOptions {
  readonly preset?: string;
  readonly app?: readonly string[];
  readonly write?: boolean;
  readonly cap?: readonly string[];
  readonly permission?: string;
  readonly manifest?: string;
  readonly expiry?: string;
  readonly device?: boolean;
}

export interface AppsAgentSelection {
  readonly mode: AppsAgentMode;
  /** Empty: the whole `applications` space. */
  readonly appIds: readonly string[];
}

function usage(message: string): CLIError {
  return new CLIError("INVALID_ARGUMENT", message, ExitCode.USAGE_ERROR);
}

/**
 * Validate the `--preset`/`--app`/`--write` flags of `auth request`. Returns
 * the selected variant, or `undefined` without a preset. The preset is the
 * whole request: any other source of capabilities, its expiry or the KV-only
 * device path would make the printed scope untrue.
 */
export function resolveAppsAgentRequest(options: AppsAgentRequestOptions): AppsAgentSelection | undefined {
  const apps = options.app ?? [];
  if (options.preset === undefined) {
    if (apps.length > 0 || options.write === true) {
      throw usage(`--app and --write require --preset ${APPS_AGENT_PRESET}.`);
    }
    return undefined;
  }
  if (options.preset !== APPS_AGENT_PRESET) {
    throw usage(`Unknown --preset "${options.preset}". Available: ${APPS_AGENT_PRESET}.`);
  }
  if ((options.cap?.length ?? 0) > 0 || options.permission !== undefined || options.manifest !== undefined ||
    options.expiry !== undefined) {
    throw usage(
      `--preset ${APPS_AGENT_PRESET} is the whole request (${APPS_AGENT_EXPIRY}); it cannot be combined with --cap, --permission, --manifest or --expiry.`,
    );
  }
  if (options.device === true) {
    throw usage(`--preset ${APPS_AGENT_PRESET} includes SQL, which device approval cannot grant. Use browser or --paste approval.`);
  }
  const mode: AppsAgentMode = options.write === true ? "write" : "read";
  const appIds = [...new Set(apps)];
  for (const appId of appIds) {
    if (!isAppId(appId)) throw usage(`Invalid --app "${appId}": ${APP_ID_RULE}.`);
  }
  if (appIds.length > APPS_AGENT_MAX_APPS) {
    throw usage(`--app can be repeated at most ${APPS_AGENT_MAX_APPS} times; for more apps, ask for read-only access to the whole space (leave --app off).`);
  }
  if (APPS_AGENT_VARIANTS[mode].perAppOnly && appIds.length === 0) {
    throw usage("--write needs --app <app_id>: write access is only given for named apps, never for the whole space.");
  }
  return { mode, appIds };
}

/** A `requestedExpiry` (or an entry's `expiry`) in milliseconds; `undefined` when it is not a duration. */
function lifetimeMs(value: string | number | undefined): number | undefined {
  try {
    if (value === undefined) return parseExpiry(DEFAULT_EXPIRY);
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
    return /^\d+$/.test(value.trim()) ? Number(value.trim()) : parseExpiry(value);
  } catch {
    return undefined;
  }
}

function inApplicationsSpace(entry: PermissionEntry, applicationsSpace: string): boolean {
  return normalizePkhIdentifier(entry.space ?? "") === normalizePkhIdentifier(applicationsSpace);
}

function sameActions(have: readonly string[], want: readonly string[]): boolean {
  return have.length === want.length && want.every((action) => have.includes(action));
}

/**
 * Whether `requested` is exactly a preset variant, with the preset's lifetime,
 * in the owner's own `applications` space (compared by full space id). Only
 * then may the owner-side notice use the preset wording.
 */
export function matchAppsAgentRequest(
  requested: readonly PermissionEntry[],
  requestedExpiry: string | number | undefined,
  applicationsSpace: string,
): AppsAgentSelection | undefined {
  if (lifetimeMs(requestedExpiry) !== APPS_AGENT_EXPIRY_DAYS * DAY_MS) return undefined;
  if (requested.some((entry) => entry.expiry !== undefined || entry.caveats !== undefined)) return undefined;
  const kvPaths = requested.filter((entry) => entry.service === "tinycloud.kv").map((entry) => entry.path);
  const appIds: string[] = [];
  for (const path of new Set(kvPaths)) {
    if (path === "") continue;
    if (!path.endsWith("/") || !isAppId(path.slice(0, -1))) return undefined;
    appIds.push(path.slice(0, -1));
  }
  if (appIds.length > APPS_AGENT_MAX_APPS || (appIds.length > 0 && kvPaths.includes(""))) return undefined;
  for (const mode of ["read", "write"] as const) {
    if (APPS_AGENT_VARIANTS[mode].perAppOnly && appIds.length === 0) continue;
    const expected = appsAgentPermissions(mode, appIds);
    const exact = requested.length === expected.length && expected.every((want) =>
      requested.some((have) =>
        have.service === want.service &&
        inApplicationsSpace(have, applicationsSpace) &&
        have.path === want.path &&
        sameActions(have.actions, want.actions)));
    if (exact) return { mode, appIds };
  }
  return undefined;
}

function describePath(path: string): string {
  return path === "" ? "everything in the space" : `\`${path}\``;
}

/**
 * The scope the owner is about to sign, in plain words, derived from the
 * request as it will be signed: the preset wording when the request is exactly
 * a preset variant, otherwise a description of each entry and the requested
 * lifetime. `undefined` when the request does not touch an `applications`
 * space's KV or SQL.
 */
export function describeGrantScope(
  requested: readonly PermissionEntry[],
  requestedExpiry: string | number | undefined,
  applicationsSpace: string,
): string | undefined {
  const preset = matchAppsAgentRequest(requested, requestedExpiry, applicationsSpace);
  if (preset !== undefined) return appsAgentScopeNotice(preset.mode, preset.appIds);
  const touched = requested.filter((entry) =>
    (entry.service === "tinycloud.kv" || entry.service === "tinycloud.sql") &&
    ((entry.space ?? "").split(":").at(-1) === APPS_AGENT_SPACE));
  if (touched.length === 0) return undefined;

  const lines = ["This request is not the standard apps-agent grant. It asks for:"];
  for (const entry of touched) {
    const words = entry.actions.map((action) => ACTION_WORDS[action] ?? action).join(", ");
    lines.push(`- ${words} on ${describePath(entry.path)} (${entry.service} in \`${entry.space}\`)`);
  }
  if (touched.some((entry) => entry.actions.some((action) => STRUCTURE_ACTIONS.has(action)))) {
    lines.push("Because of how TinyCloud permissions work today, SQL write access can also change or delete tables (structure).");
  }
  const entryLifetimes = requested.filter((entry) => entry.expiry !== undefined).map((entry) => lifetimeMs(entry.expiry));
  const durations = [lifetimeMs(requestedExpiry), ...entryLifetimes]
    .filter((ms): ms is number => ms !== undefined);
  const longest = Math.max(...durations);
  lines.push(
    durations.length === 0 || !Number.isFinite(longest)
      ? "Its lifetime could not be read from the request."
      : `It lasts up to ${lifetimePhrase(longest)}${requestedExpiry === undefined ? " (no lifetime was requested; this is the default)" : ""}; revoke it any time with \`${CLI_NAME} delegation revoke <id>\`.`,
  );
  return lines.join("\n");
}
