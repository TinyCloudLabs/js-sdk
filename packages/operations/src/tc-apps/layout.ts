/**
 * Where personal records live, the same place the tc-apps skill puts a new app: the owner's `applications` space, one root
 * per app `xyz.tinycloud.tinyapps.<app>/`, a discovery entry under `xyz.tinycloud.tinyapps.catalog/`, and one SQL copy per
 * app at `<root>index`. Records under the older `xyz.tinycloud.agent-data/` folder are not read or written here.
 */
export const TC_APPS_ID_PREFIX = "xyz.tinycloud.tinyapps.";
export const TC_APPS_DISCOVERY_ROOT = `${TC_APPS_ID_PREFIX}catalog/`;
/** Generic apps may not use these names; `healthlog` and `recipes` belong to catalog apps. */
export const TC_APPS_RESERVED_APPS: readonly string[] = ["catalog", "index-stale", "healthlog", "recipes"];

const CHARS = /^[A-Za-z0-9/._~:+@=,-]+$/;
const NAME = /^[a-z0-9-]+$/;
const NEW_APP = /^[a-z][a-z0-9-]*$/;

export function newApp(value: string): boolean { return NEW_APP.test(value) && !TC_APPS_RESERVED_APPS.includes(value); }
function kindName(value: string): boolean { return NAME.test(value) && value !== "catalog" && value !== "index-stale"; }

export function appId(app: string): string { return `${TC_APPS_ID_PREFIX}${app}`; }
export function appRoot(app: string): string { return `${appId(app)}/`; }
export function discoveryKey(app: string): string { return `${TC_APPS_DISCOVERY_ROOT}${app}/entry`; }
export function catalogKey(app: string, kind?: string): string {
  const base = `${appRoot(app)}catalog`;
  return kind === undefined ? base : `${base}/${kind}`;
}
export function catalogPrefix(app: string): string { return `${catalogKey(app)}/`; }
export function recordPrefix(app: string, kind: string): string { return `${appRoot(app)}${kind}/`; }
export function staleKey(app: string, kind: string): string { return `${appRoot(app)}index-stale/${kind}`; }
export function stalePrefix(app: string): string { return `${appRoot(app)}index-stale/`; }
export function indexDatabase(app: string): string { return `${appRoot(app)}index`; }
/** The key as stored in the SQL copy: relative to the app root. */
export function copyKey(app: string, key: string): string { return key.slice(appRoot(app).length); }

export type KeyParts =
  | { area: "catalog"; app: string; kind?: string }
  | { area: "record"; app: string; kind: string; folder: string; id: string }
  | { area: "stale"; app: string; kind: string }
  | { area: "discovery"; app: string };

function segments(key: string, prefix: boolean): string[] | undefined {
  if (!CHARS.test(key)) return undefined;
  const parts = (prefix && key.endsWith("/") ? key.slice(0, -1) : key).split("/");
  return parts.some((part) => part === "." || part === "..") ? undefined : parts;
}

/** Split `xyz.tinycloud.tinyapps.<app>/<rest>` into the app (or the discovery folder) and the rest. */
function locate(key: string): { app: string; rest: string } | undefined {
  if (!key.startsWith(TC_APPS_ID_PREFIX)) return undefined;
  const slash = key.indexOf("/");
  if (slash < 0) return undefined;
  const app = key.slice(TC_APPS_ID_PREFIX.length, slash);
  return app === "catalog" || newApp(app) ? { app, rest: key.slice(slash + 1) } : undefined;
}

/** Parse one exact record, catalog, discovery or stale-marker key; `undefined` when it is not a valid personal-record key. */
export function parseKey(key: string): KeyParts | undefined {
  const where = locate(key);
  if (!where || segments(key, false) === undefined) return undefined;
  const parts = where.rest.split("/");
  if (parts.some((part) => part === "")) return undefined;
  if (where.app === "catalog") {
    return parts.length === 2 && parts[1] === "entry" && newApp(parts[0]!) ? { area: "discovery", app: parts[0]! } : undefined;
  }
  const app = where.app;
  const [first, second, third] = parts;
  if (first === "catalog") {
    if (parts.length === 1) return { area: "catalog", app };
    return parts.length === 2 && kindName(second!) ? { area: "catalog", app, kind: second! } : undefined;
  }
  if (first === "index-stale") return parts.length === 2 && kindName(second!) ? { area: "stale", app, kind: second! } : undefined;
  if (parts.length !== 3 || !kindName(first!) || !NAME.test(second!)) return undefined;
  return { area: "record", app, kind: first!, folder: second!, id: third! };
}

/** The app a prefix lists, when it is a valid personal-record prefix; the app is absent for the whole discovery folder. */
export function parsePrefix(prefix: string): { app?: string; discovery?: true } | undefined {
  const where = locate(prefix);
  if (!where) return undefined;
  const parts = segments(prefix, true);
  if (parts === undefined) return undefined;
  const rest = where.rest === "" ? [] : (where.rest.endsWith("/") ? where.rest.slice(0, -1) : where.rest).split("/");
  if (rest.some((part) => part === "")) return undefined;
  if (!prefix.endsWith("/")) return undefined;
  if (where.app === "catalog") {
    if (rest.length > 1 || (rest[0] !== undefined && !newApp(rest[0]))) return undefined;
    return { discovery: true, ...(rest[0] === undefined ? {} : { app: rest[0] }) };
  }
  const [first, second] = rest;
  if (rest.length === 0) return { app: where.app };
  if (first === "catalog") return rest.length === 1 ? { app: where.app } : undefined;
  if (rest.length > 2 || !kindName(first!) || (second !== undefined && !NAME.test(second))) return undefined;
  return { app: where.app };
}
