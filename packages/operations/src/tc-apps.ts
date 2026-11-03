import { appRoot, newApp, TC_APPS_DISCOVERY_ROOT, TC_APPS_ID_PREFIX, TC_APPS_LEGACY_DATABASE, TC_APPS_LEGACY_ROOT } from "./tc-apps/layout.js";

export { TC_APPS_DISCOVERY_ROOT, TC_APPS_LEGACY_DATABASE, TC_APPS_LEGACY_ROOT } from "./tc-apps/layout.js";
export const TC_APPS_RECORDS_ACTIONS = ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"] as const;
export const TC_APPS_DISCOVERY_ACTIONS = ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"] as const;
export const TC_APPS_CATALOG_READ_ACTIONS = ["tinycloud.kv/get", "tinycloud.kv/list"] as const;
export const TC_APPS_COPY_ACTIONS = ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] as const;

/** What one stored or requested permission entry is, when it is one of the connector's own. */
export type TcAppsPermissionKind =
  | { kind: "legacy-records" }
  | { kind: "legacy-read" }
  | { kind: "legacy-catalog-read" }
  | { kind: "legacy-copy" }
  | { kind: "app-records"; app: string }
  | { kind: "discovery" }
  | { kind: "app-copy"; app: string };

const SPACE_ID = /^tinycloud:[^\s*]+:(default|applications)$/;

/** Classify a permission entry; `undefined` when it is not exactly one of the connector's scopes. */
export function tcAppsPermissionKind(permission: unknown): TcAppsPermissionKind | undefined {
  if (typeof permission !== "object" || permission === null) return undefined;
  const entry = permission as Record<string, unknown>;
  if (typeof entry.space !== "string" || typeof entry.path !== "string" || !Array.isArray(entry.actions) || entry.actions.length === 0) return undefined;
  const space = entry.space === "default" || entry.space === "applications" ? entry.space : SPACE_ID.exec(entry.space)?.[1];
  const inside = (allowed: readonly string[]) => (entry.actions as unknown[]).every((action: unknown) => typeof action === "string" && allowed.includes(action));
  const path = entry.path;
  if (entry.service === "tinycloud.kv" && space === "default") {
    if (path === TC_APPS_LEGACY_ROOT && inside(TC_APPS_CATALOG_READ_ACTIONS)) return { kind: "legacy-read" };
    if (path === TC_APPS_LEGACY_ROOT && inside(TC_APPS_RECORDS_ACTIONS)) return { kind: "legacy-records" };
    if (path === `${TC_APPS_LEGACY_ROOT}catalog/` && inside(TC_APPS_CATALOG_READ_ACTIONS)) return { kind: "legacy-catalog-read" };
  }
  if (entry.service === "tinycloud.sql" && space === "default" && path === TC_APPS_LEGACY_DATABASE && inside(TC_APPS_COPY_ACTIONS)) return { kind: "legacy-copy" };
  if (space !== "applications") return undefined;
  if (entry.service === "tinycloud.kv" && path === TC_APPS_DISCOVERY_ROOT && inside(TC_APPS_DISCOVERY_ACTIONS)) return { kind: "discovery" };
  const match = new RegExp(`^${TC_APPS_ID_PREFIX.replace(/\./g, "\\.")}([a-z][a-z0-9-]*)/(index)?$`).exec(path);
  if (!match || !newApp(match[1]!)) return undefined;
  if (entry.service === "tinycloud.kv" && match[2] === undefined && inside(TC_APPS_RECORDS_ACTIONS)) return { kind: "app-records", app: match[1]! };
  // A SQL path with no trailing slash is matched exactly, so the copy's path is the database itself.
  if (entry.service === "tinycloud.sql" && path === `${appRoot(match[1]!)}index` && inside(TC_APPS_COPY_ACTIONS)) return { kind: "app-copy", app: match[1]! };
  return undefined;
}

export function isTcAppsPermission(permission: unknown, copy = false): boolean {
  const kind = tcAppsPermissionKind(permission)?.kind;
  return copy ? kind === "legacy-copy" || kind === "app-copy" : kind !== undefined && kind !== "legacy-copy" && kind !== "app-copy";
}

const LEGACY_RECORDS_REASON = "Lets Claude keep your personal records in your TinyCloud default space (keys under xyz.tinycloud.agent-data/): read, add, change and delete them, for 30 days.";
const LEGACY_CATALOG_REASON = "Lets Claude read, but not change, the list of your older apps in your TinyCloud default space (xyz.tinycloud.agent-data/catalog/), so it keeps an app where it already is.";
const LEGACY_COPY_REASON = "Lets Claude keep a fast, searchable copy of those records (database xyz.tinycloud.agent-data.index) for 30 days.";
const DISCOVERY_REASON = "Lets Claude list your apps and add or change entries in your app list in your TinyCloud applications space (keys under xyz.tinycloud.tinyapps.catalog/), for 30 days.";
const LEGACY_READ_REASON = "Lets Claude read, but not change or delete, your older records in your TinyCloud default space (keys under xyz.tinycloud.agent-data/), so it can copy an app you ask it to move into its new folder. Nothing in your default space is changed or deleted. 30 days.";
const named = (apps: readonly string[]) => apps.join(", ");

interface Approval { legacyRecords: boolean; legacyRead: boolean; legacyCatalog: boolean; legacyCopy: boolean; discovery: boolean; records: string[]; copies: string[] }

function approval(permissions: readonly unknown[]): Approval | undefined {
  const kinds = permissions.map(tcAppsPermissionKind);
  if (kinds.length === 0 || kinds.some((kind) => kind === undefined)) return undefined;
  const has = (name: TcAppsPermissionKind["kind"]) => kinds.some((kind) => kind?.kind === name);
  const apps = (name: "app-records" | "app-copy") => [...new Set(kinds.flatMap((kind) => kind?.kind === name ? [kind.app] : []))].sort();
  return {
    legacyRecords: has("legacy-records"), legacyRead: has("legacy-read"), legacyCatalog: has("legacy-catalog-read"), legacyCopy: has("legacy-copy"),
    discovery: has("discovery"), records: apps("app-records"), copies: apps("app-copy"),
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
  if (kinds.discovery && kinds.records.length === 1 && permissions.length === 2) {
    const changing = permissions.some((permission) => {
      const entry = permission as { actions: string[] };
      return entry.actions.includes("tinycloud.kv/put");
    });
    return changing
      ? `Lets Claude read your app list (keys under ${TC_APPS_DISCOVERY_ROOT}), add ${named(kinds.records)} to it, and read this app's records and add, change or delete them (keys under ${appRoot(kinds.records[0]!)}), for 30 days.`
      : `Lets Claude read your app list (keys under ${TC_APPS_DISCOVERY_ROOT}) and this app's records for ${named(kinds.records)} (keys under ${appRoot(kinds.records[0]!)}), for 30 days. It cannot change them.`;
  }
  return [
    kinds.legacyRecords ? LEGACY_RECORDS_REASON : undefined,
    kinds.legacyRead && !kinds.legacyRecords ? LEGACY_READ_REASON : undefined,
    kinds.records.length > 0 ? recordsReason(kinds.records) : undefined,
    kinds.discovery ? DISCOVERY_REASON : undefined,
    kinds.legacyCatalog && !kinds.legacyRecords && !kinds.legacyRead ? LEGACY_CATALOG_REASON : undefined,
    kinds.legacyCopy ? LEGACY_COPY_REASON : undefined,
    kinds.copies.length > 0 ? copyReason(kinds.copies) : undefined,
  ].filter(Boolean).join(" ");
}

export function tcAppsApprovalMessage(permissions: readonly unknown[]): string | undefined {
  const kinds = approval(permissions);
  if (!kinds) return undefined;
  if (kinds.discovery && kinds.records.length === 1 && permissions.length === 2) {
    return `Open the approval link and approve the request on OpenKey. ${tcAppsApprovalReason(permissions)} I'll carry on after you approve.`;
  }
  const records: string[] = [];
  if (kinds.legacyRecords) records.push("your records under xyz.tinycloud.agent-data/");
  if (kinds.legacyRead && !kinds.legacyRecords) records.push("a read-only look at your older records under xyz.tinycloud.agent-data/, to copy one app into its new folder");
  if (kinds.records.length > 0) records.push(`your records for ${named(kinds.records)} under ${kinds.records.map((app) => appRoot(app)).join(", ")}`);
  if (kinds.discovery) records.push("your app list under xyz.tinycloud.tinyapps.catalog/");
  if (kinds.legacyCatalog && !kinds.legacyRecords && !kinds.legacyRead) records.push("a read-only look at your older app list under xyz.tinycloud.agent-data/catalog/");
  const copies = [...(kinds.legacyCopy ? [TC_APPS_LEGACY_DATABASE] : []), ...kinds.copies.map((app) => `${appRoot(app)}index`)];
  return [
    records.length > 0 ? `Open the approval link and approve the request on OpenKey. It lets Claude keep ${records.join(" and ")} for 30 days. I'll carry on after you approve.` : undefined,
    copies.length > 0 ? `For questions over many records, I can keep a fast, searchable copy of your records. Open the approval link and approve the request on OpenKey. Its page names ${copies.join(", ")}. This lasts 30 days; if you don't approve, I can still answer from your records, only more slowly.` : undefined,
  ].filter(Boolean).join(" ");
}
