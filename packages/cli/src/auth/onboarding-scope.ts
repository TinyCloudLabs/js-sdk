import type { PermissionEntry } from "@tinycloud/node-sdk";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { parseDuration } from "../lib/duration.js";
import { renewalLeaseFor } from "./renewal-lease.js";

const kv = (space: string, path: string, actions: string[]): PermissionEntry => ({ service: "tinycloud.kv", space, path, actions: actions.map(a => `tinycloud.kv/${a}`) });
const sql = (path: string, actions = ["read", "write"]): PermissionEntry => ({ service: "tinycloud.sql", space: "applications", path, actions: actions.map(a => `tinycloud.sql/${a}`) });

/** The default lifetime of an onboarding sign-in, for every selection; its renewal lease carries it to 30 days. */
export const ONBOARD_EXPIRY = "7d";
/** The default lifetime of a grant added to an existing sign-in, which cannot renew. Shorter when the Feed is among the tasks. */
const GRANT_EXPIRY = "30d";
const FEED_GRANT_EXPIRY = "7d";
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
 * selection keeps the read-only account listing. `--expiry` sets the lifetime, up to 30 days.
 *
 * A new sign-in lasts 7 days by default; one shorter than the default renewal lease asks for that lease (as
 * `auth login` does), and `asks` says it renews. `finiteAsks` is the same line for an owner who approves without
 * renewal. `grant` is a grant added to an existing sign-in, which has no lease: 30 days by default, 7 with the Feed.
 */
export function onboardingPlan(selector = "apps", expiryOption?: unknown): {
  permissions: PermissionEntry[]; asks: string; finiteAsks: string; expiry: string; renewalLeaseSeconds?: number;
  grant: { asks: string; expiry: string };
} {
  const tasks = [...new Set(selector.split(",").map(s => s.trim()))].sort();
  if (!tasks.length || tasks.some(task => task !== "apps" && task !== "feed")) {
    throw new CLIError("INVALID_ONBOARD_TASK", "--with accepts apps, feed or apps,feed.", ExitCode.USAGE_ERROR);
  }
  const feedOnly = tasks.length === 1 && tasks[0] === "feed";
  const requested = parseOnboardExpiry(expiryOption);
  const expiry = requested?.expiry ?? ONBOARD_EXPIRY;
  const lifetime = requested?.words ?? "7 days";
  const grantExpiry = requested?.expiry ?? (tasks.includes("feed") ? FEED_GRANT_EXPIRY : GRANT_EXPIRY);
  const grantLifetime = requested?.words ?? (tasks.includes("feed") ? "7 days" : "30 days");
  const renewalLeaseSeconds = renewalLeaseFor(undefined, Math.floor(parseDuration(expiry) / 1000));
  const entries: PermissionEntry[] = feedOnly ? [] : [kv("account", "spaces/", ["get", "list"]), kv("account", "applications/", ["get", "list"])];
  if (tasks.includes("apps")) entries.push(kv("applications", "", ["get", "list", "put", "del", "metadata"]), sql(""));
  if (tasks.includes("feed")) {
    const actions = tasks.includes("apps") ? ["schema"] : ["read", "write", "schema"];
    entries.push(sql("xyz.tinycloud.tinychat/home_feed", actions), sql("xyz.tinycloud.tinychat/feed/", actions),
      { service: "tinycloud.hooks", space: "applications", path: "sql/xyz.tinycloud.tinychat/feed/", actions: ["tinycloud.hooks/subscribe"] });
  }
  const what = feedOnly
    ? "use your Feed"
    : tasks.includes("feed")
      ? "use your apps and your Feed, and see your spaces"
      : "use your apps and see your spaces";
  const line = (words: string) => `Set up TinyCloud on this computer: ${what}, for ${words}`;
  const renewalDays = renewalLeaseSeconds === undefined ? undefined : renewalLeaseSeconds / 86_400;
  return {
    permissions: entries.sort((a, b) => `${a.space}\0${a.service}\0${a.path}`.localeCompare(`${b.space}\0${b.service}\0${b.path}`)),
    // Onboarding asks with renewal on; the owner can turn it off in OpenKey, so the reason says so (TC-4247).
    asks: `${line(lifetime)}.${renewalDays === undefined ? "" : ` It renews for up to ${renewalDays} ${renewalDays === 1 ? "day" : "days"} unless you turn renewal off.`}`,
    finiteAsks: `${line(lifetime)}.`,
    expiry,
    ...(renewalLeaseSeconds === undefined ? {} : { renewalLeaseSeconds }),
    grant: { asks: `${line(grantLifetime)}.`, expiry: grantExpiry },
  };
}
