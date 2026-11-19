import type { PermissionEntry } from "@tinycloud/node-sdk";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { parseDuration } from "../lib/duration.js";

const kv = (space: string, path: string, actions: string[]): PermissionEntry => ({ service: "tinycloud.kv", space, path, actions: actions.map(a => `tinycloud.kv/${a}`) });
const sql = (path: string, actions = ["read", "write"]): PermissionEntry => ({ service: "tinycloud.sql", space: "applications", path, actions: actions.map(a => `tinycloud.sql/${a}`) });

/** The default lifetime of an onboarding approval. When the Feed is among the tasks it is shorter (`FEED_EXPIRY`). */
export const ONBOARD_EXPIRY = "30d";
/** The default lifetime when the Feed is among the tasks. */
const FEED_EXPIRY = "7d";
/** OpenKey's longest approval, and so the longest `--expiry`. */
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** `--expiry` as a lifetime in the owner's words (`7 days`), after checking it is a plain number of minutes, hours, days or weeks, no longer than OpenKey allows. */
function parseOnboardExpiry(raw: unknown): { expiry: string; words: string } | undefined {
  if (raw === undefined) return undefined;
  const match = typeof raw === "string" ? /^([1-9]\d*)([mhdw])$/.exec(raw.trim()) : null;
  if (!match) {
    throw new CLIError("INVALID_EXPIRY", `--expiry takes a number and a unit, such as 12h, 7d or 2w (m, h, d or w), not ${JSON.stringify(raw)}.`, ExitCode.USAGE_ERROR);
  }
  const expiry = match[0];
  if (parseDuration(expiry) > MAX_EXPIRY_MS) {
    throw new CLIError("INVALID_EXPIRY", `--expiry can be at most 30 days (30d), the longest an OpenKey approval lasts.`, ExitCode.USAGE_ERROR);
  }
  const unit = { m: "minute", h: "hour", d: "day", w: "week" }[match[2]!]!;
  return { expiry, words: `${match[1]} ${unit}${match[1] === "1" ? "" : "s"}` };
}

/** Select tasks before creating a profile or contacting OpenKey. Omitted selector retains the starting apps grant. */
export function onboardingPermissions(selector = "apps"): PermissionEntry[] {
  return onboardingPlan(selector).permissions;
}

/**
 * Capability scope, approval text and lifetime share the same normalized task selection.
 * The Feed alone asks for exactly the Feed's databases and notifications, with no account listing; every other
 * selection keeps the read-only account listing. Any selection that includes the Feed lasts 7 days by default,
 * apps alone 30. `--expiry` sets the lifetime, up to 30 days.
 */
export function onboardingPlan(selector = "apps", expiryOption?: unknown): { permissions: PermissionEntry[]; asks: string; expiry: string } {
  const tasks = [...new Set(selector.split(",").map(s => s.trim()))].sort();
  if (!tasks.length || tasks.some(task => task !== "apps" && task !== "feed")) {
    throw new CLIError("INVALID_ONBOARD_TASK", "--with accepts apps, feed or apps,feed.", ExitCode.USAGE_ERROR);
  }
  const feedOnly = tasks.length === 1 && tasks[0] === "feed";
  const requested = parseOnboardExpiry(expiryOption);
  const expiry = requested?.expiry ?? (tasks.includes("feed") ? FEED_EXPIRY : ONBOARD_EXPIRY);
  const lifetime = requested?.words ?? (tasks.includes("feed") ? "7 days" : "30 days");
  const entries: PermissionEntry[] = feedOnly ? [] : [kv("account", "spaces/", ["get", "list"]), kv("account", "applications/", ["get", "list"])];
  if (tasks.includes("apps")) entries.push(kv("applications", "", ["get", "list", "put", "del", "metadata"]), sql(""));
  if (tasks.includes("feed")) {
    const actions = tasks.includes("apps") ? ["schema"] : ["read", "write", "schema"];
    entries.push(sql("xyz.tinycloud.tinychat/home_feed", actions), sql("xyz.tinycloud.tinychat/feed/", actions),
      { service: "tinycloud.hooks", space: "applications", path: "sql/xyz.tinycloud.tinychat/feed/", actions: ["tinycloud.hooks/subscribe"] });
  }
  const asks = feedOnly
    ? `Set up TinyCloud on this computer: use your Feed, for ${lifetime}.`
    : tasks.includes("feed")
      ? `Set up TinyCloud on this computer: use your apps and your Feed, and see your spaces and apps, for ${lifetime}.`
      : `Set up TinyCloud on this computer: use your apps and see your spaces, for ${lifetime}.`;
  return {
    permissions: entries.sort((a, b) => `${a.space}\0${a.service}\0${a.path}`.localeCompare(`${b.space}\0${b.service}\0${b.path}`)),
    asks,
    expiry,
  };
}
