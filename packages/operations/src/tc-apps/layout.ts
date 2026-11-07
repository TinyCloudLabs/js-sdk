/**
 * The two places personal records can live, chosen per app (the same rule as the tc-apps skill's `layout.sh`):
 * - `legacy`: space `default`, root `xyz.tinycloud.agent-data/`, one shared SQL copy.
 * - `new`: space `applications`, one root per app `xyz.tinycloud.tinyapps.<app>/`, a discovery entry under
 *   `xyz.tinycloud.tinyapps.catalog/`, and one SQL copy per app at `<root>index`.
 */
export type Layout = "legacy" | "new";

export const TC_APPS_LEGACY_ROOT = "xyz.tinycloud.agent-data/";
export const TC_APPS_LEGACY_DATABASE = "xyz.tinycloud.agent-data.index";
export const TC_APPS_ID_PREFIX = "xyz.tinycloud.tinyapps.";
export const TC_APPS_DISCOVERY_ROOT = `${TC_APPS_ID_PREFIX}catalog/`;
/** Generic apps may not use these names; `healthlog` and `recipes` belong to catalog apps. */
export const TC_APPS_RESERVED_APPS: readonly string[] = ["catalog", "index-stale", "healthlog", "recipes"];

const CHARS = /^[A-Za-z0-9/._~:+@=,-]+$/;
const NAME = /^[a-z0-9-]+$/;
const NEW_APP = /^[a-z][a-z0-9-]*$/;

export function spaceName(layout: Layout): "default" | "applications" {
  return layout === "legacy" ? "default" : "applications";
}
export function legacyApp(value: string): boolean { return NAME.test(value) && value !== "catalog" && value !== "index-stale"; }
export function newApp(value: string): boolean { return NEW_APP.test(value) && !TC_APPS_RESERVED_APPS.includes(value); }
function kindName(value: string): boolean { return NAME.test(value) && value !== "catalog" && value !== "index-stale"; }

export function appId(app: string): string { return `${TC_APPS_ID_PREFIX}${app}`; }
export function appRoot(app: string): string { return `${appId(app)}/`; }
export function discoveryKey(app: string): string { return `${TC_APPS_DISCOVERY_ROOT}${app}/entry`; }
export function catalogKey(layout: Layout, app: string, kind?: string): string {
  const base = layout === "legacy" ? `${TC_APPS_LEGACY_ROOT}catalog/${app}` : `${appRoot(app)}catalog`;
  return kind === undefined ? base : `${base}/${kind}`;
}
export function catalogPrefix(layout: Layout, app: string): string { return `${catalogKey(layout, app)}/`; }
export function recordPrefix(layout: Layout, app: string, kind: string): string {
  return layout === "legacy" ? `${TC_APPS_LEGACY_ROOT}${app}/${kind}/` : `${appRoot(app)}${kind}/`;
}
export function staleKey(layout: Layout, app: string, kind: string): string {
  return layout === "legacy" ? `${TC_APPS_LEGACY_ROOT}index-stale/${app}/${kind}` : `${appRoot(app)}index-stale/${kind}`;
}
export function stalePrefix(layout: Layout, app: string): string {
  return layout === "legacy" ? `${TC_APPS_LEGACY_ROOT}index-stale/` : `${appRoot(app)}index-stale/`;
}
export function indexDatabase(layout: Layout, app: string): string {
  return layout === "legacy" ? TC_APPS_LEGACY_DATABASE : `${appRoot(app)}index`;
}
/** The key as stored in the SQL copy: legacy rows keep the full key, per-app rows drop the app root. */
export function copyKey(layout: Layout, app: string, key: string): string {
  return layout === "legacy" ? key : key.slice(appRoot(app).length);
}

export type KeyParts =
  | { layout: Layout; area: "catalog"; app: string; kind?: string }
  | { layout: Layout; area: "record"; app: string; kind: string; folder: string; id: string }
  | { layout: Layout; area: "stale"; app: string; kind: string }
  | { layout: "new"; area: "discovery"; app: string };

function segments(key: string, prefix: boolean): string[] | undefined {
  if (!CHARS.test(key)) return undefined;
  const parts = (prefix && key.endsWith("/") ? key.slice(0, -1) : key).split("/");
  return parts.some((part) => part === "." || part === "..") ? undefined : parts;
}

/** Split `<root>/<rest>` into the layout, app (new layout only) and the segments after it. */
function locate(key: string): { layout: Layout; app?: string; rest: string } | undefined {
  if (key.startsWith(TC_APPS_LEGACY_ROOT)) return { layout: "legacy", rest: key.slice(TC_APPS_LEGACY_ROOT.length) };
  if (!key.startsWith(TC_APPS_ID_PREFIX)) return undefined;
  const slash = key.indexOf("/");
  if (slash < 0) return undefined;
  const app = key.slice(TC_APPS_ID_PREFIX.length, slash);
  if (app === "catalog") return { layout: "new", app, rest: key.slice(slash + 1) };
  return newApp(app) ? { layout: "new", app, rest: key.slice(slash + 1) } : undefined;
}

/** Parse one exact record, catalog, discovery or stale-marker key; `undefined` when it is not a valid personal-record key. */
export function parseKey(key: string): KeyParts | undefined {
  const where = locate(key);
  if (!where || segments(key, false) === undefined) return undefined;
  const parts = where.rest.split("/");
  if (parts.some((part) => part === "")) return undefined;
  if (where.layout === "legacy") {
    const [first, second, third, fourth] = parts;
    if (first === "catalog") {
      if (parts.length === 2 && legacyApp(second!)) return { layout: "legacy", area: "catalog", app: second! };
      if (parts.length === 3 && legacyApp(second!) && NAME.test(third!)) return { layout: "legacy", area: "catalog", app: second!, kind: third! };
      return undefined;
    }
    if (first === "index-stale") {
      return parts.length === 3 && legacyApp(second!) && NAME.test(third!) ? { layout: "legacy", area: "stale", app: second!, kind: third! } : undefined;
    }
    if (parts.length !== 4 || !legacyApp(first!) || !NAME.test(second!) || !NAME.test(third!)) return undefined;
    return { layout: "legacy", area: "record", app: first!, kind: second!, folder: third!, id: fourth! };
  }
  if (where.app === "catalog") {
    return parts.length === 2 && parts[1] === "entry" && newApp(parts[0]!) ? { layout: "new", area: "discovery", app: parts[0]! } : undefined;
  }
  const app = where.app!;
  const [first, second, third] = parts;
  if (first === "catalog") {
    if (parts.length === 1) return { layout: "new", area: "catalog", app };
    return parts.length === 2 && kindName(second!) ? { layout: "new", area: "catalog", app, kind: second! } : undefined;
  }
  if (first === "index-stale") return parts.length === 2 && kindName(second!) ? { layout: "new", area: "stale", app, kind: second! } : undefined;
  if (parts.length !== 3 || !kindName(first!) || !NAME.test(second!)) return undefined;
  return { layout: "new", area: "record", app, kind: first!, folder: second!, id: third! };
}

/** The layout and app a prefix lists, when it is a valid personal-record prefix; the app is absent for a whole root. */
export function parsePrefix(prefix: string): { layout: Layout; app?: string; discovery?: true } | undefined {
  const where = locate(prefix);
  if (!where) return undefined;
  const parts = segments(prefix, true);
  if (parts === undefined) return undefined;
  const rest = where.rest === "" ? [] : (where.rest.endsWith("/") ? where.rest.slice(0, -1) : where.rest).split("/");
  if (rest.some((part) => part === "")) return undefined;
  if (where.layout === "legacy") {
    const [first, second, third] = rest;
    if (rest.length === 0) return { layout: "legacy" };
    if (first === "catalog" || first === "index-stale") {
      if (rest.length > 3 || (second !== undefined && !legacyApp(second)) || (third !== undefined && !NAME.test(third))) return undefined;
      return { layout: "legacy", ...(second === undefined ? {} : { app: second }) };
    }
    if (!legacyApp(first!) || rest.length > 4 || (second !== undefined && !NAME.test(second)) || (third !== undefined && !NAME.test(third))) return undefined;
    return { layout: "legacy", app: first! };
  }
  if (!prefix.endsWith("/")) return undefined;
  if (where.app === "catalog") {
    if (rest.length > 1 || (rest[0] !== undefined && !newApp(rest[0]))) return undefined;
    return { layout: "new", discovery: true, ...(rest[0] === undefined ? {} : { app: rest[0] }) };
  }
  const [first, second] = rest;
  if (rest.length === 0) return { layout: "new", app: where.app! };
  if (first === "catalog") return rest.length === 1 ? { layout: "new", app: where.app! } : undefined;
  if (rest.length > 2 || !kindName(first!) || (second !== undefined && !NAME.test(second))) return undefined;
  return { layout: "new", app: where.app! };
}

/** Where a legacy catalog or record key of `app` goes in the new layout (the same mapping as the skill's `migrate.sh`). */
export function moveKey(app: string, legacyKey: string): string {
  const catalog = catalogKey("legacy", app);
  if (legacyKey === catalog) return catalogKey("new", app);
  if (legacyKey.startsWith(`${catalog}/`)) return `${catalogKey("new", app)}/${legacyKey.slice(catalog.length + 1)}`;
  return `${appRoot(app)}${legacyKey.slice(`${TC_APPS_LEGACY_ROOT}${app}/`.length)}`;
}
