import type { PermissionEntry } from "@tinycloud/node-sdk";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";

const kv = (space: string, path: string, actions: string[]): PermissionEntry => ({ service: "tinycloud.kv", space, path, actions: actions.map(a => `tinycloud.kv/${a}`) });
const sql = (path: string, actions = ["read", "write"]): PermissionEntry => ({ service: "tinycloud.sql", space: "applications", path, actions: actions.map(a => `tinycloud.sql/${a}`) });

/** Select tasks before creating a profile or contacting OpenKey. Omitted selector retains the starting apps grant. */
export function onboardingPermissions(selector = "apps"): PermissionEntry[] {
  const tasks = [...new Set(selector.split(",").map(s => s.trim()))].sort();
  if (!tasks.length || tasks.some(task => task !== "apps" && task !== "feed")) {
    throw new CLIError("INVALID_ONBOARD_TASK", "--with accepts apps, feed, or apps,feed.", ExitCode.USAGE_ERROR);
  }
  const entries = [kv("account", "spaces/", ["get", "list"]), kv("account", "applications/", ["get", "list"])];
  if (tasks.includes("apps")) entries.push(kv("applications", "", ["get", "list", "put", "del", "metadata"]), sql(""));
  if (tasks.includes("feed")) {
    const actions = tasks.includes("apps") ? ["schema"] : ["read", "write", "schema"];
    entries.push(sql("xyz.tinycloud.tinychat/home_feed", actions), sql("xyz.tinycloud.tinychat/feed/", actions),
      { service: "tinycloud.hooks", space: "applications", path: "sql/xyz.tinycloud.tinychat/feed/", actions: ["tinycloud.hooks/subscribe"] });
  }
  return entries.sort((a, b) => `${a.space}\0${a.service}\0${a.path}`.localeCompare(`${b.space}\0${b.service}\0${b.path}`));
}
