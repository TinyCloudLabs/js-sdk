export const TC_APPS_ROOT = "xyz.tinycloud.agent-data/";
export const TC_APPS_DATABASE = "xyz.tinycloud.agent-data.index";
export const TC_APPS_RECORDS_ACTIONS = ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"] as const;
export const TC_APPS_COPY_ACTIONS = ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"] as const;

const RECORDS_REASON = "Lets Claude keep your personal records in your TinyCloud default space (keys under xyz.tinycloud.agent-data/): read, add, change and delete them, for 30 days.";
const COPY_REASON = "Lets Claude keep a fast, searchable copy of those records (database xyz.tinycloud.agent-data.index) for 30 days.";

export function isTcAppsPermission(permission: unknown, copy = false): boolean {
  if (typeof permission !== "object" || permission === null) return false;
  const entry = permission as Record<string, unknown>;
  const actions = copy ? TC_APPS_COPY_ACTIONS : TC_APPS_RECORDS_ACTIONS;
  return entry.service === (copy ? "tinycloud.sql" : "tinycloud.kv") &&
    entry.path === (copy ? TC_APPS_DATABASE : TC_APPS_ROOT) &&
    typeof entry.space === "string" &&
    (entry.space === "default" || /^tinycloud:[^\s*]+:default$/.test(entry.space)) &&
    Array.isArray(entry.actions) && entry.actions.length > 0 &&
    entry.actions.every((action: unknown) => actions.includes(action as never));
}

function approvalKinds(permissions: readonly unknown[]): { records: boolean; copy: boolean } | undefined {
  if (permissions.length === 0 || permissions.some((entry) => !isTcAppsPermission(entry) && !isTcAppsPermission(entry, true))) return undefined;
  return { records: permissions.some((entry) => isTcAppsPermission(entry)), copy: permissions.some((entry) => isTcAppsPermission(entry, true)) };
}

export function tcAppsApprovalReason(permissions: readonly unknown[]): string | undefined {
  const kinds = approvalKinds(permissions);
  if (!kinds) return undefined;
  return [kinds.records ? RECORDS_REASON : undefined, kinds.copy ? COPY_REASON : undefined].filter(Boolean).join(" ");
}

export function tcAppsApprovalMessage(permissions: readonly unknown[]): string | undefined {
  const kinds = approvalKinds(permissions);
  if (!kinds) return undefined;
  return [
    kinds.records ? "Open the approval link and approve the request on OpenKey. It lets Claude keep your records under xyz.tinycloud.agent-data/ for 30 days. I'll carry on after you approve." : undefined,
    kinds.copy ? "For questions over many records, I can keep a fast, searchable copy of your records. Open the approval link and approve the request on OpenKey. Its page names xyz.tinycloud.agent-data.index. This lasts 30 days; if you don't approve, I can still answer from your records, only more slowly." : undefined,
  ].filter(Boolean).join(" ");
}
