import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import type { PermissionEntry } from "@tinycloud/node-sdk";

/**
 * The `auth request --preset apps-agent` grant: the one place that defines
 * what an agent picking up a user's apps may do. The request, the plain-words
 * scope notice and the tests all read this module; nothing else restates it.
 *
 * Whole space: `<app_id>/` prefixes are not enumerated, so the grant covers
 * every installed app (an empty path covers the whole space for KV and SQL).
 * With an app id it is narrowed to that app's `<app_id>/` prefix. KV
 * `del`, SQL `admin` (schema changes) and every other service and space are
 * deliberately absent.
 */
export const APPS_AGENT_PRESET = "apps-agent";
export const APPS_AGENT_SPACE = "applications";
export const APPS_AGENT_EXPIRY_DAYS = 7;
/** ms-format lifetime accepted by `--expiry`. */
export const APPS_AGENT_EXPIRY = `${APPS_AGENT_EXPIRY_DAYS}d`;

export const APPS_AGENT_GRANTS = [
  { service: "tinycloud.kv", actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"] },
  { service: "tinycloud.sql", actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
] as const;

type AppsAgentAction = (typeof APPS_AGENT_GRANTS)[number]["actions"][number];

/**
 * What each granted action lets the agent do, in plain words. Typed over the
 * grant list: adding an action without describing it does not compile.
 */
const ACTION_WORDS: Record<AppsAgentAction, string> = {
  "tinycloud.kv/get": "read files",
  "tinycloud.kv/list": "list files",
  "tinycloud.kv/put": "create and overwrite files",
  "tinycloud.sql/read": "read table rows",
  "tinycloud.sql/write": "add, change and delete table rows",
};

/** A valid app id as the knowledge operations accept it; it becomes a key prefix. */
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isAppId(value: string): boolean {
  return value.length <= 200 && APP_ID.test(value);
}

/** The permission entries to request. `appId` narrows the grant to `<appId>/`. */
export function appsAgentPermissions(appId?: string): PermissionEntry[] {
  return APPS_AGENT_GRANTS.map(({ service, actions }) => ({
    service,
    space: APPS_AGENT_SPACE,
    path: appId === undefined ? "" : `${appId}/`,
    actions: [...actions],
  }));
}

/** Plain-words statement of exactly what the grant allows, shown before approval. */
export function appsAgentScopeNotice(appId?: string): string {
  const can = APPS_AGENT_GRANTS.flatMap(({ actions }) => actions.map((action) => ACTION_WORDS[action])).join(", ");
  const scope = appId === undefined
    ? `ALL your installed apps' data in the \`${APPS_AGENT_SPACE}\` space`
    : `the data of \`${appId}\` (everything under \`${appId}/\`) in the \`${APPS_AGENT_SPACE}\` space`;
  return [
    `This gives the agent access to ${scope}.`,
    `It can: ${can}.`,
    `It cannot delete files, change a table's structure, or touch any other space.`,
    `It lasts ${APPS_AGENT_EXPIRY_DAYS} days, and you can revoke it any time with \`${CLI_NAME} delegation revoke <id>\`.`,
  ].join("\n");
}

export interface AppsAgentRequestOptions {
  readonly preset?: string;
  readonly app?: string;
  readonly cap?: readonly string[];
  readonly permission?: string;
  readonly manifest?: string;
  readonly expiry?: string;
  readonly device?: boolean;
}

/**
 * Validate the `--preset`/`--app` flags of `auth request`. Returns the app the
 * grant is narrowed to (`{}` for the whole space), or `undefined` without a
 * preset. The preset is the whole request: any other source of capabilities,
 * its expiry or the KV-only device path would make the printed scope untrue.
 */
export function resolveAppsAgentRequest(options: AppsAgentRequestOptions): { appId?: string } | undefined {
  if (options.preset === undefined) {
    if (options.app !== undefined) {
      throw new CLIError("INVALID_ARGUMENT", "--app requires --preset apps-agent.", ExitCode.USAGE_ERROR);
    }
    return undefined;
  }
  if (options.preset !== APPS_AGENT_PRESET) {
    throw new CLIError(
      "INVALID_ARGUMENT",
      `Unknown --preset "${options.preset}". Available: ${APPS_AGENT_PRESET}.`,
      ExitCode.USAGE_ERROR,
    );
  }
  if ((options.cap?.length ?? 0) > 0 || options.permission !== undefined || options.manifest !== undefined ||
    options.expiry !== undefined) {
    throw new CLIError(
      "INVALID_ARGUMENT",
      `--preset ${APPS_AGENT_PRESET} is the whole request (${APPS_AGENT_EXPIRY}); it cannot be combined with --cap, --permission, --manifest or --expiry.`,
      ExitCode.USAGE_ERROR,
    );
  }
  if (options.device === true) {
    throw new CLIError(
      "INVALID_ARGUMENT",
      `--preset ${APPS_AGENT_PRESET} includes SQL, which device approval cannot grant. Use browser or --paste approval.`,
      ExitCode.USAGE_ERROR,
    );
  }
  if (options.app === undefined) return {};
  if (!isAppId(options.app)) {
    throw new CLIError("INVALID_ARGUMENT", `Invalid --app "${options.app}": expected an app id such as xyz.tinycloud.health.`, ExitCode.USAGE_ERROR);
  }
  return { appId: options.app };
}

/**
 * Whether `requested` is exactly the preset, whole-space or for one app, so
 * the approving side can show the same scope notice. Compared as sets, on the
 * space's name, so a re-ordered or fully-qualified request still matches.
 */
export function matchAppsAgentRequest(requested: readonly PermissionEntry[]): { appId?: string } | undefined {
  if (requested.length !== APPS_AGENT_GRANTS.length) return undefined;
  const first = requested[0];
  if (first === undefined) return undefined;
  const appId = first.path === "" ? undefined : first.path.endsWith("/") ? first.path.slice(0, -1) : null;
  if (appId === null || (appId !== undefined && !isAppId(appId))) return undefined;
  const expected = appsAgentPermissions(appId);
  const matches = expected.every((want) => requested.some((have) =>
    have.service === want.service &&
    (have.space ?? "").split(":").at(-1) === want.space &&
    have.path === want.path &&
    have.actions.length === want.actions.length &&
    want.actions.every((action) => have.actions.includes(action)) &&
    have.caveats === undefined));
  return matches ? (appId === undefined ? {} : { appId }) : undefined;
}
