import { appRoot, newApp, TC_APPS_DISCOVERY_ROOT, TC_APPS_ID_PREFIX } from "./tc-apps/layout.js";
import { HEALTHLOG_DATABASE } from "./tc-apps/preamble.js";

export { TC_APPS_DISCOVERY_ROOT } from "./tc-apps/layout.js";
export const TC_APPS_RECORDS_ACTIONS = ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"] as const;
export const TC_APPS_DISCOVERY_ACTIONS = ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"] as const;
export const TC_APPS_CATALOG_READ_ACTIONS = ["tinycloud.kv/get", "tinycloud.kv/list"] as const;
export const TC_APPS_COPY_ACTIONS = ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] as const;

/** Only the pinned catalog targets; Recipes learns its database from its notes. */
export const TC_APPS_CATALOG_PERMISSIONS: Readonly<Record<string, { service: string; path: string; actions: readonly string[] }>> = {
  healthlog: { service: "tinycloud.sql", path: HEALTHLOG_DATABASE, actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
  recipes: { service: "tinycloud.kv", path: "xyz.tinycloud.sample.recipes/knowledge/", actions: TC_APPS_CATALOG_READ_ACTIONS },
};

/** What one stored or requested permission entry is, when it is one of the connector's own. */
export type TcAppsPermissionKind =
  | { kind: "app-records"; app: string }
  | { kind: "discovery" }
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
  if (!inApplications) return undefined;
  for (const [app, catalog] of Object.entries(TC_APPS_CATALOG_PERMISSIONS)) {
    if (entry.service === catalog.service && path === catalog.path && inside(catalog.actions)) {
      return { kind: "catalog", app, change: entry.actions.includes("tinycloud.sql/write") };
    }
  }
  if (entry.service === "tinycloud.kv" && path === TC_APPS_DISCOVERY_ROOT && inside(TC_APPS_DISCOVERY_ACTIONS)) return { kind: "discovery" };
  const match = new RegExp(`^${TC_APPS_ID_PREFIX.replace(/\./g, "\\.")}([a-z][a-z0-9-]*)/(index)?$`).exec(path);
  if (!match || !newApp(match[1]!)) return undefined;
  if (entry.service === "tinycloud.kv" && match[2] === undefined && inside(TC_APPS_RECORDS_ACTIONS)) return { kind: "app-records", app: match[1]! };
  // A SQL path with no trailing slash is matched exactly, so the copy's path is the database itself.
  if (entry.service === "tinycloud.sql" && path === `${appRoot(match[1]!)}index` && inside(TC_APPS_COPY_ACTIONS)) return { kind: "app-copy", app: match[1]! };
  return undefined;
}

const DISCOVERY_REASON = "Lets Claude list your apps and add or change entries in your app list in your TinyCloud applications space (keys under xyz.tinycloud.tinyapps.catalog/), for 30 days.";
const named = (apps: readonly string[]) => apps.join(", ");

interface Approval { discovery: boolean; discoveryRead: boolean; records: string[]; copies: string[]; catalog: { app: string; change: boolean }[]; bundle: "change" | "read" | undefined }

function approval(permissions: readonly unknown[]): Approval | undefined {
  const kinds = permissions.map(tcAppsPermissionKind);
  if (kinds.length === 0 || kinds.some((kind) => kind === undefined)) return undefined;
  const has = (name: TcAppsPermissionKind["kind"]) => kinds.some((kind) => kind?.kind === name);
  const apps = (name: "app-records" | "app-copy") => [...new Set(kinds.flatMap((kind) => kind?.kind === name ? [kind.app] : []))].sort();
  // A task bundle is exactly the app list plus one app folder; it is "change" only when both entries can write, "read" only when neither can.
  const listAt = kinds.findIndex((kind) => kind?.kind === "discovery");
  const folderAt = kinds.findIndex((kind) => kind?.kind === "app-records");
  // Adding, changing or deleting is a write: a folder entry that can only delete is not a read bundle.
  const writes = (index: number) => (permissions[index] as { actions: string[] }).actions.some((action) => action === "tinycloud.kv/put" || action === "tinycloud.kv/del");
  const bundle = kinds.length === 2 && listAt >= 0 && folderAt >= 0
    ? writes(listAt) && writes(folderAt) ? "change" : !writes(listAt) && !writes(folderAt) ? "read" : undefined
    : undefined;
  return {
    discovery: has("discovery"), records: apps("app-records"), copies: apps("app-copy"), bundle,
    discoveryRead: !permissions.some((permission, index) => {
      const entry = permission as { actions: string[] };
      return kinds[index]?.kind === "discovery" && entry.actions.includes("tinycloud.kv/put");
    }),
    catalog: kinds.flatMap((kind) => kind?.kind === "catalog" ? [{ app: kind.app, change: kind.change }] : []),
  };
}

function recordsReason(apps: readonly string[]): string {
  return `Lets Claude keep your personal records for ${named(apps)} in your TinyCloud applications space (keys under ${apps.map((app) => appRoot(app)).join(", ")}): read, add, change and delete them, for 30 days.`;
}
function copyReason(apps: readonly string[]): string {
  return `Lets Claude keep a fast, searchable copy of the records for ${named(apps)} (database ${apps.map((app) => `${appRoot(app)}index`).join(", ")}) for 30 days.`;
}

export function tcAppsApprovalReason(permissions: readonly unknown[]): string | undefined {
  const kinds = approval(permissions);
  if (!kinds) return undefined;
  if (kinds.bundle !== undefined) {
    return kinds.bundle === "change"
      ? `Lets Claude read your app list (keys under ${TC_APPS_DISCOVERY_ROOT}), add ${named(kinds.records)} to it, and read this app's records and add, change or delete them (keys under ${appRoot(kinds.records[0]!)}), for 30 days.`
      : `Lets Claude read your app list (keys under ${TC_APPS_DISCOVERY_ROOT}) and this app's records for ${named(kinds.records)} (keys under ${appRoot(kinds.records[0]!)}), for 30 days. It cannot change them.`;
  }
  return [
    kinds.records.length > 0 ? recordsReason(kinds.records) : undefined,
    kinds.discovery ? kinds.discoveryRead ? "Lets Claude read your app list, for 30 days." : DISCOVERY_REASON : undefined,
    ...kinds.catalog.map((app) => app.app === "healthlog"
      ? app.change
        ? "Lets Claude read your Health Log and add, change or delete entries in it, for 30 days. This covers the whole Health Log database."
        : "Lets Claude read your Health Log, for 30 days. This covers the whole Health Log database, without changing it."
      : "Lets Claude read your Recipes app's notes, for 30 days. It cannot change them. Reading recipe records may need a separate approval."),
    kinds.copies.length > 0 ? copyReason(kinds.copies) : undefined,
  ].filter(Boolean).join(" ");
}

export function tcAppsApprovalMessage(permissions: readonly unknown[]): string | undefined {
  const kinds = approval(permissions);
  if (!kinds) return undefined;
  if (kinds.catalog.length > 0 || kinds.bundle !== undefined) {
    return `Open the approval link and approve the request on OpenKey. ${tcAppsApprovalReason(permissions)} I'll carry on after you approve.`;
  }
  const records: string[] = [];
  if (kinds.records.length > 0) records.push(`your records for ${named(kinds.records)} under ${kinds.records.map((app) => appRoot(app)).join(", ")}`);
  if (kinds.discovery) records.push("your app list under xyz.tinycloud.tinyapps.catalog/");
  const copies = kinds.copies.map((app) => `${appRoot(app)}index`);
  return [
    records.length > 0 ? `Open the approval link and approve the request on OpenKey. It lets Claude keep ${records.join(" and ")} for 30 days. I'll carry on after you approve.` : undefined,
    copies.length > 0 ? `For questions over many records, I can keep a fast, searchable copy of your records. Open the approval link and approve the request on OpenKey. Its page names ${copies.join(", ")}. This lasts 30 days; if you don't approve, I can still answer from your records, only more slowly.` : undefined,
  ].filter(Boolean).join(" ");
}
