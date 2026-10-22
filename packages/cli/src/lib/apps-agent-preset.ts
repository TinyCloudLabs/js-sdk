import { DEFAULT_EXPIRY, parseExpiry, SERVICE_LONG_TO_SHORT, VAULT_PERMISSION_SERVICE } from "@tinycloud/sdk-core";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import type { PermissionEntry } from "@tinycloud/node-sdk";

import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { safeClipped, safeClippedList, safeInline } from "../output/safe-text.js";
import { isRawEncryptionPermission } from "./raw-encryption.js";
import { normalizePkhIdentifier } from "./space.js";
import { DECRYPT_CONSENT_NOTE, includesDecrypt } from "./decrypt-cap.js";

/**
 * The `auth request --preset apps-agent` grants: the one place that defines
 * what an agent picking up a user's apps may do. The request, the plain-words
 * scope notice and the tests all read the two variants below; nothing else
 * restates them.
 *
 * - `read` (the default): KV get and list, SQL read, on the whole
 *   `applications` space or on named apps (`<app_id>/`).
 * - `write` (`--write`, named apps only): adds KV put on the app's
 *   `knowledge/` and `prefs/` folders (the two the sample apps' own manifests
 *   write to) and SQL write. Every other file under `<app_id>/` stays
 *   read-only, so the app's code and its stored `manifest.json` and
 *   `install.json` cannot be changed through it. The share runner keeps the
 *   last two under `<app_id>/app/`; the root-level keys are refused as well.
 *
 * Neither grants KV delete, SQL admin, any other service, or any other space.
 * CREATE, ALTER and DROP TABLE need `tinycloud.sql/schema`, which SQL write does
 * not request. Nodes before 1.21.6 do not enforce that split: SQL write can run
 * those statements there too. The write variant adds `tinycloud.sql/schema` only
 * for an app listed in `APPS_AGENT_SCHEMA_DATABASES`, on that app's one database,
 * at the exact path with no trailing slash (the node matches a SQL path exactly
 * unless it ends in `/`).
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

/**
 * The app folders an agent may write files to. A stored `manifest.json` is
 * user-writable, so these are fixed here, never read from it.
 */
export const APPS_AGENT_WRITE_FOLDERS: readonly string[] = ["knowledge/", "prefs/"];

interface PresetGrant {
  readonly service: "tinycloud.kv" | "tinycloud.sql";
  readonly actions: readonly string[];
  /** Folders inside an app the actions cover: `""` is the whole app (`<app_id>/`). */
  readonly within: readonly string[];
}

interface PresetVariant {
  readonly grants: readonly PresetGrant[];
  /** Whether the variant needs named apps (`--app`). */
  readonly perAppOnly: boolean;
  /** Whether named apps listed in `APPS_AGENT_SCHEMA_DATABASES` also get `tinycloud.sql/schema` on their database. */
  readonly schemaForCatalogApps: boolean;
}

export const APPS_AGENT_VARIANTS: Readonly<Record<AppsAgentMode, PresetVariant>> = {
  read: {
    grants: [
      { service: "tinycloud.kv", actions: ["tinycloud.kv/get", "tinycloud.kv/list"], within: [""] },
      { service: "tinycloud.sql", actions: ["tinycloud.sql/read"], within: [""] },
    ],
    perAppOnly: false,
    schemaForCatalogApps: false,
  },
  write: {
    grants: [
      { service: "tinycloud.kv", actions: ["tinycloud.kv/get", "tinycloud.kv/list"], within: [""] },
      { service: "tinycloud.kv", actions: ["tinycloud.kv/put"], within: APPS_AGENT_WRITE_FOLDERS },
      { service: "tinycloud.sql", actions: ["tinycloud.sql/read", "tinycloud.sql/write"], within: [""] },
    ],
    perAppOnly: true,
    schemaForCatalogApps: true,
  },
};

/**
 * The one database each catalog app declares for `tinycloud.sql/schema` in its
 * manifest. Only the write variant gives it, and only on that database; an app
 * not listed here gets no table-structure grant.
 */
const APPS_AGENT_SCHEMA_DATABASES: Readonly<Record<string, string>> = {
  "xyz.tinycloud.sample.healthlog": "healthlog",
};
const SCHEMA_ACTION = "tinycloud.sql/schema";

/**
 * Plain words for every action a request can carry; anything else prints as
 * `unrecognised: grants <ability>`.
 */
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
  "tinycloud.delegation/create": "can give other people or agents access on your behalf",
  "tinycloud.delegation/revoke": "can cancel access you gave",
  "tinycloud.delegation/*": "can do everything the delegation permissions allow, including giving access on to others",
  "tinycloud.kv/*": "do anything with files (read, write, delete)",
  "tinycloud.sql/*": "do anything in the database",
  "tinycloud.capabilities/read": "see which permissions this key holds",
};

/** SQL actions that let the node run CREATE, ALTER or DROP TABLE. SQL write is not one of them. */
const STRUCTURE_ACTIONS: Readonly<Record<string, true>> = {
  "tinycloud.sql/schema": true,
  "tinycloud.sql/admin": true,
  "tinycloud.sql/*": true,
};

/** A valid app id as the knowledge operations accept it; it becomes a key prefix. */
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const APP_ID_RULE =
  "an app id looks like xyz.example.app: letters, digits, dots, hyphens and underscores, no slashes or spaces";

export function isAppId(value: string): boolean {
  return value.length <= 200 && APP_ID.test(value);
}

/** The permission entries to request. No app ids means the whole space (read-only only). */
export function appsAgentPermissions(mode: AppsAgentMode, appIds: readonly string[] = []): PermissionEntry[] {
  const bases = appIds.length === 0 ? [""] : appIds.map((appId) => `${appId}/`);
  const grants = APPS_AGENT_VARIANTS[mode].grants.flatMap(({ service, actions, within }) =>
    within.flatMap((folder) =>
      bases.map((base) => ({ service, space: APPS_AGENT_SPACE, path: `${base}${folder}`, actions: [...actions] }))));
  const schema: PermissionEntry[] = APPS_AGENT_VARIANTS[mode].schemaForCatalogApps
    ? schemaPathsFor(appIds).map((path) => ({ service: "tinycloud.sql", space: APPS_AGENT_SPACE, path, actions: [SCHEMA_ACTION] }))
    : [];
  return [...grants, ...schema];
}

/** The `<app_id>/<db>` paths the write variant grants `tinycloud.sql/schema` on, for the listed apps that have one. */
function schemaPathsFor(appIds: readonly string[]): string[] {
  return appIds.flatMap((appId) => {
    if (!Object.hasOwn(APPS_AGENT_SCHEMA_DATABASES, appId)) return [];
    return [`${appId}/${APPS_AGENT_SCHEMA_DATABASES[appId]}`];
  });
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
  const writes = variant.grants.some(({ actions }) => actions.includes("tinycloud.kv/put"));
  const writableFolders = appIds.flatMap((appId) => APPS_AGENT_WRITE_FOLDERS.map((folder) => `\`${appId}/${folder}\``)).join(", ");
  const reads = writes
    ? `read everything there, write knowledge and data files (${writableFolders}), and add, change and delete table rows`
    : "list and read its files and read its table rows";
  const scope = appIds.length === 0
    ? `ALL your installed apps' data in the \`${APPS_AGENT_SPACE}\` space`
    : `the data of ${quoteApps(appIds)} (everything under ${appIds.map((appId) => `\`${appId}/\``).join(", ")}) in the \`${APPS_AGENT_SPACE}\` space`;
  const lines = [
    writes
      ? `This gives the agent access to ${scope}: it can ${reads}.`
      : `This gives the agent READ-ONLY access to ${scope}: it can ${reads}.`,
  ];
  if (writes) {
    const schemaPaths = schemaPathsFor(appIds).map((path) => `\`${path}\``);
    lines.push(
      `It cannot change ${appIds.length === 1 ? "the app's" : "the apps'"} code, manifest or install record: files outside those folders are read-only for it.`,
      `SQL write is separate from that: it can add, change and delete ${appIds.length === 1 ? "this app's" : "these apps'"} table rows.`,
      variant.schemaForCatalogApps && schemaPaths.length > 0
        ? `It can also create, change and drop the tables in ${schemaPaths.join(", ")}, which the app needs to set itself up. That grant names no other database for table changes. Nodes before 1.21.6 do not enforce that database limit, so the write grant may still let it change tables elsewhere there.`
        : "This grant does not include permission to create, change or drop tables (tinycloud.sql/schema). Nodes before 1.21.6 do not enforce that split, so the write grant may still let it do so there.",
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
    throw usage(`Unknown --preset "${safeClipped(options.preset)}". Available: ${APPS_AGENT_PRESET}.`);
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
    if (!isAppId(appId)) throw usage(`Invalid --app "${safeClipped(appId)}": ${APP_ID_RULE}.`);
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
  for (const path of kvPaths) {
    if (path === "") continue;
    // The app is the first folder; whether the rest is a folder the preset grants is checked against the exact list below.
    const slash = path.indexOf("/");
    const appId = path.slice(0, slash);
    if (slash < 1 || !isAppId(appId)) return undefined;
    if (!appIds.includes(appId)) appIds.push(appId);
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

/** What `auth grant` prints before signing, and what the owner must confirm. */
export interface GrantScope {
  /** Plain-words text for stderr: every entry once, entries beyond the preset first and marked `!`. */
  readonly text: string;
  /** The entries described, exactly the resolved list that is signed. */
  readonly entries: readonly PermissionEntry[];
  /** Entries outside what the apps-agent preset can ever grant; they need an explicit confirmation. */
  readonly extras: readonly PermissionEntry[];
}

const RAW_ENCRYPTION_SPACE = "encryption";

function badRequest(message: string): CLIError {
  return new CLIError("INVALID_AUTH_REQUEST", `${message} Nothing was signed.`, ExitCode.USAGE_ERROR);
}

/** A DID as it appears in a request: method and identifier characters only, no control or bidi characters. */
const DID_SHAPE = /^did:[a-z0-9]+:[A-Za-z0-9._:%#-]+$/;

/**
 * The top-level fields of a request file that are echoed in signer and parser
 * errors: `sessionDid` and `requestedExpiry`. A value of the wrong shape is
 * refused here with fixed text, before anything is printed or signed.
 */
export function assertRequestFields(request: { sessionDid?: unknown; requestedExpiry?: unknown }): void {
  if (typeof request.sessionDid !== "string" || request.sessionDid.length > 300 || !DID_SHAPE.test(request.sessionDid)) {
    throw badRequest("The request's sessionDid is not a valid DID.");
  }
  if (request.requestedExpiry !== undefined &&
    (typeof request.requestedExpiry !== "string" && typeof request.requestedExpiry !== "number" ||
      lifetimeMs(request.requestedExpiry as string | number) === undefined)) {
    throw badRequest("The request's requestedExpiry is not a duration such as 7d or 12h.");
  }
}

/**
 * Step 1 of preparing a request file for signing: check its shape and apply
 * the signer's default for an entry with no `space` (the owner's
 * `applications` space). An empty space is refused rather than guessed.
 */
export function entriesForSigning(requested: readonly PermissionEntry[]): PermissionEntry[] {
  return requested.map((entry, index) => {
    const label = `Entry ${index + 1} of the request`;
    if (typeof entry !== "object" || entry === null || typeof entry.service !== "string" || entry.service === "" ||
      typeof entry.path !== "string" || !Array.isArray(entry.actions) || entry.actions.length === 0 ||
      entry.actions.some((action) => typeof action !== "string" || action === "")) {
      throw badRequest(`${label} is malformed: it needs a service, a path and at least one action.`);
    }
    // `tinycloud.vault` is an SDK shorthand the signer turns into KV access on `vault/` for the vault actions listed:
    // what would be printed is not what would be signed, and an app-picking agent has no business there.
    if (entry.service === VAULT_PERMISSION_SERVICE || entry.service === "vault") {
      throw badRequest(`${label} asks for the vault (\`tinycloud.vault\`). This command does not sign vault access from a request file: the signer turns it into KV access on \`vault/\` for the vault actions you listed, so the printed list would not show what is signed.`);
    }
    if (entry.space !== undefined && (typeof entry.space !== "string" || entry.space === "")) {
      throw badRequest(`${label} has an empty space: name the space, or leave it out to mean your \`${APPS_AGENT_SPACE}\` space.`);
    }
    return entry.space === undefined && !isRawEncryptionPermission(entry) ? { ...entry, space: APPS_AGENT_SPACE } : entry;
  });
}

/**
 * Step 3, after the profile has turned names into space ids and expanded
 * action names: require a service the signer can sign and a concrete space on
 * every entry, one space for the whole request, then merge entries with the
 * same service, space, path, lifetime and caveats (actions are unioned and
 * sorted), exactly as the signer would. The result is the one list that is
 * described, gated and signed. Everything echoed from the request in a
 * refusal is escaped.
 */
export function finalizeSigningEntries(resolved: readonly PermissionEntry[]): PermissionEntry[] {
  const merged = new Map<string, PermissionEntry>();
  const spaces = new Set<string>();
  const spellings = new Map<string, string>();
  resolved.forEach((entry, index) => {
    const label = `Entry ${index + 1} of the request`;
    if (SERVICE_LONG_TO_SHORT[entry.service] === undefined) {
      throw badRequest(`${label} names the service "${safeClipped(entry.service)}", which the signer cannot sign.`);
    }
    const space = entry.space;
    const raw = isRawEncryptionPermission(entry);
    const concrete = typeof space === "string" &&
      (space.startsWith("tinycloud:") || (space === RAW_ENCRYPTION_SPACE && raw));
    if (!concrete) {
      throw badRequest(`${label} does not resolve to a concrete space (got "${safeClipped(String(space))}").`);
    }
    const normalized = normalizePkhIdentifier(space);
    if (!raw) spaces.add(normalized);
    // One spelling per space (the signer compares them byte for byte): the first one seen.
    const spelled = spellings.get(normalized) ?? space;
    spellings.set(normalized, spelled);
    const unified = { ...entry, space: spelled };
    const key = JSON.stringify([entry.service, normalized, entry.path, entry.expiry ?? null, entry.caveats ?? null]);
    const existing = merged.get(key);
    merged.set(key, existing === undefined ? unified : { ...existing, actions: [...existing.actions, ...entry.actions] });
  });
  if (spaces.size > 1) {
    throw badRequest(`The request names ${spaces.size} different spaces (${safeClippedList([...spaces])}); a grant covers one space, so make one request per space.`);
  }
  return [...merged.values()].map((entry) => ({ ...entry, actions: [...new Set(entry.actions)].sort() }));
}

/** Plain words for one ability; anything unknown is printed raw and marked unrecognised. */
export function describeAction(action: string): string {
  if (Object.prototype.hasOwnProperty.call(ACTION_WORDS, action)) return ACTION_WORDS[action]!;
  return action.endsWith("/*")
    ? `ALL abilities of ${safeInline(action.slice(0, -2))} (unrecognised: grants ${safeInline(action)})`
    : `unrecognised: grants ${safeInline(action)}`;
}

/** One line for one entry: its actions in words, where, and the raw service. */
function describeEntry(entry: PermissionEntry, applicationsSpace: string): string {
  const inApplications = inApplicationsSpace(entry, applicationsSpace);
  const space = inApplications ? "your `applications` space" : `space \`${safeInline(entry.space ?? "")}\``;
  const wholeSpace = entry.path === "" || entry.path === "/";
  const where = wholeSpace
    ? (inApplications ? `ALL apps in ${space}` : `everything in ${space}`)
    : `\`${safeInline(entry.path)}\` in ${space}`;
  const known = entry.service === "tinycloud.kv" || entry.service === "tinycloud.sql" ||
    entry.service === "tinycloud.delegation" || entry.service === "tinycloud.capabilities";
  const service = known ? safeInline(entry.service) : `unrecognised service ${safeInline(entry.service)}`;
  return `${entry.actions.map(describeAction).join(", ")} on ${where} (${service})`;
}

/**
 * Whether every action of `entry` is one the preset can grant at that path:
 * reads anywhere, writes only in a named app's write folders (SQL write in
 * the whole named app). Schema is never within it: the preset grants it only inside the exact write variant, which `matchAppsAgentRequest` recognises first.
 * A path with a `.` or `..` segment is never within it.
 */
function withinPresetSet(entry: PermissionEntry, applicationsSpace: string): boolean {
  if (!inApplicationsSpace(entry, applicationsSpace) || entry.caveats !== undefined) return false;
  if (entry.path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  if (entry.actions.includes(SCHEMA_ACTION)) return false;
  const slash = entry.path.indexOf("/");
  const folder = slash > 0 && isAppId(entry.path.slice(0, slash)) ? entry.path.slice(slash + 1) : undefined;
  const grants = Object.values(APPS_AGENT_VARIANTS).flatMap(({ grants: variantGrants }) =>
    variantGrants.filter((grant) => grant.service === entry.service));
  return entry.actions.length > 0 && entry.actions.every((action) =>
    grants.some((grant) => grant.actions.includes(action) && (
      !(action.endsWith("/put") || action.endsWith("/write")) ||
      (folder !== undefined && grant.within.some((within) => folder.startsWith(within))))));
}

/**
 * The scope the owner is about to sign, in plain words. `requested` must be
 * the resolved list from `entriesForSigning` + the profile + `finalizeSigningEntries`,
 * the same list that is then signed. Every entry is described once, whatever
 * its service or space, with text from the request escaped. The preset wording
 * is used only when the list is exactly a preset variant. When the list
 * touches an `applications` space and holds any entry the preset could never
 * grant (another service or space, delete, any schema entry outside the exact write variant, delegation, a write outside
 * a named app's write folders), those entries come first, marked `!`, and need a confirmation.
 */
export function describeGrantScope(
  requested: readonly PermissionEntry[],
  requestedExpiry: string | number | undefined,
  applicationsSpace: string,
  /** Longest lifetime the grant can actually have; the notice states the capped duration. */
  maxLifetimeMs?: number,
): GrantScope {
  const preset = matchAppsAgentRequest(requested, requestedExpiry, applicationsSpace);
  if (preset !== undefined) {
    return { text: appsAgentScopeNotice(preset.mode, preset.appIds), entries: requested, extras: [] };
  }
  const touchesApplications = requested.some((entry) => (entry.space ?? "").split(":").at(-1) === APPS_AGENT_SPACE);
  const extras = touchesApplications
    ? requested.filter((entry) => !withinPresetSet(entry, applicationsSpace))
    : [];
  const others = requested.filter((entry) => !extras.includes(entry));

  const lines: string[] = [
    extras.length > 0
      ? "This request asks for MORE than the apps-agent preset. Entries marked ! go beyond it:"
      : touchesApplications
      ? "This request is not the standard apps-agent grant (other paths or lifetime). It asks for:"
      : "This request asks for:",
    ...extras.map((entry) => `! ${describeEntry(entry, applicationsSpace)}`),
    ...others.map((entry) => `- ${describeEntry(entry, applicationsSpace)}`),
  ];
  if (requested.some((entry) => entry.service === "tinycloud.sql" && entry.actions.some((action) => Object.hasOwn(STRUCTURE_ACTIONS, action)))) {
    lines.push("This request can create, change and drop tables (an SQL schema, admin or wildcard entry).");
  }
  const entryLifetimes = requested.filter((entry) => entry.expiry !== undefined).map((entry) => lifetimeMs(entry.expiry));
  const durations = [lifetimeMs(requestedExpiry), ...entryLifetimes]
    .filter((ms): ms is number => ms !== undefined)
    .map((ms) => Math.min(ms, maxLifetimeMs ?? Number.POSITIVE_INFINITY));
  const longest = Math.max(...durations);
  const revoke = `revoke it any time with \`${CLI_NAME} delegation revoke <id>\`.`;
  lines.push(
    durations.length === 0 || !Number.isFinite(longest)
      ? "Its lifetime could not be read from the request."
      : includesDecrypt(requested)
      ? `It lasts up to ${lifetimePhrase(longest)}. ${DECRYPT_CONSENT_NOTE} ${revoke}`
      : `It lasts up to ${lifetimePhrase(longest)}${requestedExpiry === undefined ? " (no lifetime was requested; this is the default)" : ""}; ${revoke}`,
  );
  return { text: lines.join("\n"), entries: requested, extras };
}
