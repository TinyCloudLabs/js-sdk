import { appRoot, newApp, parseKey, TC_APPS_DISCOVERY_ROOT, TC_APPS_ID_PREFIX, TC_APPS_LEGACY_DATABASE, TC_APPS_LEGACY_ROOT } from "./tc-apps/layout.js";
import { HEALTHLOG_DATABASE } from "./tc-apps/preamble.js";

export { TC_APPS_DISCOVERY_ROOT, TC_APPS_LEGACY_DATABASE, TC_APPS_LEGACY_ROOT, type Layout } from "./tc-apps/layout.js";
export const TC_APPS_RECORDS_ACTIONS = ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"] as const;
export const TC_APPS_DISCOVERY_ENTRY_ACTIONS = ["tinycloud.kv/get", "tinycloud.kv/put"] as const;
export const TC_APPS_CATALOG_READ_ACTIONS = ["tinycloud.kv/get", "tinycloud.kv/list"] as const;
export const TC_APPS_COPY_ACTIONS = ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] as const;

/** Only the pinned catalog targets; Recipes learns its database from its notes. */
export const TC_APPS_CATALOG_PERMISSIONS: Readonly<Record<string, { service: string; path: string; actions: readonly string[] }>> = {
  healthlog: { service: "tinycloud.sql", path: HEALTHLOG_DATABASE, actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
  recipes: { service: "tinycloud.kv", path: "xyz.tinycloud.sample.recipes/knowledge/", actions: TC_APPS_CATALOG_READ_ACTIONS },
};

/** What one stored or requested permission entry is, when it is one of the connector's own. */
export type TcAppsPermissionKind =
  | { kind: "legacy-records" }
  | { kind: "legacy-read" }
  | { kind: "legacy-catalog-read" }
  | { kind: "legacy-copy" }
  | { kind: "app-records"; app: string }
  | { kind: "discovery" }
  | { kind: "app-discovery"; app: string }
  | { kind: "catalog"; app: string; change: boolean }
  | { kind: "app-copy"; app: string };

const SPACE_ID = /^tinycloud:[^\s*]+:applications$/;

/** Classify a permission entry; `undefined` when it is not exactly one of the connector's scopes. */
export function tcAppsPermissionKind(permission: unknown): TcAppsPermissionKind | undefined {
  if (typeof permission !== "object" || permission === null) return undefined;
  const entry = permission as Record<string, unknown>;
  if (typeof entry.space !== "string" || typeof entry.path !== "string" || !Array.isArray(entry.actions) || entry.actions.length === 0) return undefined;
  const inApplications = entry.space === "applications" || SPACE_ID.test(entry.space);
  const inside = (allowed: readonly string[]) => (entry.actions as unknown[]).every((action: unknown) => typeof action === "string" && allowed.includes(action));
  const path = entry.path;
  const inDefault = entry.space === "default" || /^tinycloud:[^\s*]+:default$/.test(entry.space);
  if (inDefault && entry.service === "tinycloud.kv") {
    if (path === TC_APPS_LEGACY_ROOT && inside(TC_APPS_CATALOG_READ_ACTIONS)) return { kind: "legacy-read" };
    if (path === TC_APPS_LEGACY_ROOT && inside(TC_APPS_RECORDS_ACTIONS)) return { kind: "legacy-records" };
    if (path === `${TC_APPS_LEGACY_ROOT}catalog/` && inside(TC_APPS_CATALOG_READ_ACTIONS)) return { kind: "legacy-catalog-read" };
  }
  if (inDefault && entry.service === "tinycloud.sql" && path === TC_APPS_LEGACY_DATABASE && inside(TC_APPS_COPY_ACTIONS)) return { kind: "legacy-copy" };
  if (!inApplications) return undefined;
  for (const [app, catalog] of Object.entries(TC_APPS_CATALOG_PERMISSIONS)) {
    if (entry.service === catalog.service && path === catalog.path && inside(catalog.actions)) {
      return { kind: "catalog", app, change: entry.actions.includes("tinycloud.sql/write") };
    }
  }
  if (entry.service === "tinycloud.kv" && path === TC_APPS_DISCOVERY_ROOT && inside(TC_APPS_CATALOG_READ_ACTIONS)) return { kind: "discovery" };
  const discovery = parseKey(path);
  if (entry.service === "tinycloud.kv" && discovery?.area === "discovery" && newApp(discovery.app) && inside(TC_APPS_DISCOVERY_ENTRY_ACTIONS)) return { kind: "app-discovery", app: discovery.app };
  const match = new RegExp(`^${TC_APPS_ID_PREFIX.replace(/\./g, "\\.")}([a-z][a-z0-9-]*)/(index)?$`).exec(path);
  if (!match || !newApp(match[1]!)) return undefined;
  if (entry.service === "tinycloud.kv" && match[2] === undefined && inside(TC_APPS_RECORDS_ACTIONS)) return { kind: "app-records", app: match[1]! };
  // A SQL path with no trailing slash is matched exactly, so the copy's path is the database itself.
  if (entry.service === "tinycloud.sql" && path === `${appRoot(match[1]!)}index` && inside(TC_APPS_COPY_ACTIONS)) return { kind: "app-copy", app: match[1]! };
  return undefined;
}

/** Aggregate only identical scopes, preserving partial and mixed action sets. */
function approval(permissions: readonly unknown[]) {
  const scopes = new Map<string, { kind: TcAppsPermissionKind; path: string; actions: Set<string> }>();
  if (permissions.length === 0) return undefined;
  for (const permission of permissions) {
    const kind = tcAppsPermissionKind(permission);
    if (!kind) return undefined;
    const entry = permission as { space: string; service: string; path: string; actions: string[] };
    const key = `${entry.space}|${entry.service}|${entry.path}`;
    const scope = scopes.get(key) ?? { kind, path: entry.path, actions: new Set<string>() };
    for (const action of entry.actions) scope.actions.add(action);
    scopes.set(key, scope);
  }
  return [...scopes.values()];
}

export function tcAppsApprovalReason(permissions: readonly unknown[]): string | undefined {
  const scopes = approval(permissions);
  if (!scopes) return undefined;
  return scopes.map(({ kind, path, actions }) => {
    const authority: string[] = [];
    if (actions.has("tinycloud.kv/get") || actions.has("tinycloud.sql/read")) authority.push("read");
    if (actions.has("tinycloud.kv/list")) authority.push("list");
    if (actions.has("tinycloud.kv/put")) authority.push("add or change");
    if (actions.has("tinycloud.kv/del")) authority.push("delete");
    if (actions.has("tinycloud.sql/write")) authority.push("add, change or delete");
    if (actions.has("tinycloud.sql/schema")) authority.push("change the database schema for");
    const target = kind.kind === "legacy-copy" ? "the searchable copy of your personal records"
      : kind.kind === "legacy-catalog-read" ? "your existing app catalog"
      : kind.kind === "legacy-records" || kind.kind === "legacy-read" ? "your personal records"
      : kind.kind === "discovery" ? "your app list"
      : kind.kind === "app-discovery" ? `the app-list entry for ${kind.app}`
      : kind.kind === "app-records" ? `your personal records for ${kind.app}`
      : kind.kind === "app-copy" ? `the searchable copy of your records for ${kind.app}`
      : kind.app === "healthlog" ? "your whole Health Log database"
      : "your Recipes app's notes";
    return `Lets the TinyCloud connector ${authority.join(", ")} ${target} (${path}) in your TinyCloud ${kind.kind.startsWith("legacy-") ? "default" : "applications"} space, for 30 days.`;
  }).join(" ");
}

export function tcAppsApprovalMessage(permissions: readonly unknown[]): string | undefined {
  const reason = tcAppsApprovalReason(permissions);
  return reason === undefined ? undefined : `Open the approval link and approve the request on OpenKey. ${reason} I'll carry on after you approve.`;
}
