import type { PermissionEntry } from "@tinycloud/node-sdk";
import { FEED_PREFIX, FEED_REGISTRY } from "../feed/resources.js";

/**
 * `tinycloud onboard --preset feed`: the one approval an owner needs to run an agent feed.
 *
 * It replaces the default onboarding's whole-`applications`-space read, change and delete of every app's data (and its
 * second, `account` approval) with exactly what `feed connect` and `feed watch` use, all in the one `applications` space
 * so OpenKey signs it as a single approval, which also signs the owner in:
 *
 * - SQL read, write and schema on the registry database and on the feed namespace (`feed_output_*`, `feed_responses_*`).
 *   Schema is needed because connecting an agent creates its tables. The registry is one exact database; the namespace
 *   ends in `/`, which the node matches as a prefix (an exact SQL path would not cover the per-agent databases).
 * - Hooks subscribe on `sql/` of that namespace: `feed connect` delegates it to the agent so `feed watch` can follow the
 *   owner's answers. Register, list and unregister (the `--notify-url` webhook and the `hooks` command) are not on master; they
 *   are added to this list with the change that introduces them.
 *
 * It grants no KV, no other database, and no other space. The default onboarding stays the starting grant for the owner's
 * own apps; this preset is for an owner who only wants the feed.
 */
export const FEED_PRESET = "feed";

/**
 * Lifetime of the approval: 7 days, the agent-preset policy (auth.ts: a preset keeps the 7-day lifetime, the owner may
 * shorten it but not extend it). The feed guide says 30 days; this is the one constant to change if Sam picks that.
 */
export const FEED_PRESET_EXPIRY = "7d";

const SPACE = "applications";
const sql = (actions: string[]) => actions.map((action) => `tinycloud.sql/${action}`);
const hooks = (actions: string[]) => actions.map((action) => `tinycloud.hooks/${action}`);

export const FEED_PRESET_PERMISSIONS: readonly PermissionEntry[] = [
  { service: "tinycloud.sql", space: SPACE, path: FEED_REGISTRY, actions: sql(["read", "write", "schema"]) },
  { service: "tinycloud.sql", space: SPACE, path: `${FEED_PREFIX}/`, actions: sql(["read", "write", "schema"]) },
  { service: "tinycloud.hooks", space: SPACE, path: `sql/${FEED_PREFIX}/`, actions: hooks(["subscribe"]) },
];

/** What the approval gives, in the owner's words. */
export const FEED_PRESET_ASKS =
  "Run your agent feed for 7 days: read and write the feed's tables, create them, and let your agents watch for your answers. Nothing else in your apps.";
