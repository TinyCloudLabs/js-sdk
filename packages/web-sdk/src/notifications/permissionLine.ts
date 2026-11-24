/**
 * The plain-words line the permission prompt shows for each requested entry, and the app's optional caption beneath
 * the lines (TC-4222). The line is built only from the request: the exact resource, each action and the grant's
 * lifetime. It is never broader or vaguer than the request; an action it has no words for is shown verbatim.
 *
 * Every user-visible string is in {@link PERMISSION_LINE_COPY}.
 */

import type { PermissionEntry } from "@tinycloud/sdk-core";
import { EXPIRY, SERVICE_SHORT_TO_LONG } from "@tinycloud/sdk-core";

const ENCRYPTION = "tinycloud.encryption";

/** All user-visible wording of the derived line and the caption label. */
export const PERMISSION_LINE_COPY = {
  /** One entry's line: `{actions} {resource}, for up to {lifetime}.` */
  line: (actions: string, resource: string, lifetime: string) => `${actions} ${resource}, for up to ${lifetime}.`,
  /** An action with no words of its own, named verbatim. */
  unknownAction: (action: string) => `use “${action}” on`,
  /** Joins the last two actions or lifetime parts. */
  and: "and",
  resource: {
    key: (keyPath: string) => `the key ${keyPath} (only this key)`,
    keyPrefix: (prefix: string) => `any key under ${prefix}`,
    network: (name: string) => `the whole encryption network ${name}, not just one key`,
    exactPath: (path: string) => path,
    pathPrefix: (path: string) => `everything under ${path}`,
    everything: "everything",
    inSpace: (what: string, space: string) => `${what} in the ${space} space`,
  },
  /**
   * Action words per service, in the order a line lists them. Each reads before the resource phrase
   * ("decrypt with" + "the key …"). Encryption actions have one set for a key or key prefix and one for a whole network.
   */
  actions: {
    encryptionKey: {
      "key.create": "create",
      decrypt: "decrypt with",
      "key.block": "block",
      "key.unblock": "unblock",
    },
    encryptionNetwork: {
      "network.create": "create",
      "network.revoke": "revoke",
      decrypt: "decrypt data encrypted to",
      "key.create": "create keys on",
      "key.block": "block keys on",
      "key.unblock": "unblock keys on",
    },
    "tinycloud.kv": {
      get: "read",
      list: "list",
      metadata: "read the metadata of",
      put: "write",
      del: "delete",
      delete: "delete",
    },
    "tinycloud.sql": {
      read: "read",
      select: "read",
      write: "write to",
      schema: "change the schema of",
      admin: "administer",
      execute: "run statements on",
      export: "export",
      "*": "fully use",
    },
    "tinycloud.duckdb": {
      read: "read",
      select: "read",
      describe: "describe",
      write: "write to",
      import: "import data into",
      export: "export",
      admin: "administer",
      execute: "run statements on",
      "*": "fully use",
    },
    "tinycloud.capabilities": { read: "read the capability records of" },
    "tinycloud.hooks": {
      subscribe: "subscribe to hooks on",
      list: "list hooks on",
      register: "register hooks on",
      unregister: "remove hooks on",
    },
    "tinycloud.delegation": {
      list: "see the delegations of",
      status: "check the delegations of",
    },
  } as Record<string, Record<string, string>>,
  units: {
    day: ["day", "days"],
    hour: ["hour", "hours"],
    minute: ["minute", "minutes"],
    second: ["second", "seconds"],
  },
  /** Precedes the app's caption, naming the app that wrote it. */
  captionSource: (appName: string) => `Label from ${appName}:`,
  /** Technical details of an encryption entry narrower than its network. */
  details: {
    key: { scope: "This key only", summary: "This permission covers only the key shown below." },
    keyPrefix: {
      scope: "Keys under this prefix only",
      summary: "This permission covers only the keys under the prefix shown below.",
    },
  },
} as const;

/** Longest caption shown, in characters; a longer one is cut and ends with "…". */
export const CAPTION_MAX_LENGTH = 120;

const DAY_MS = 24 * 60 * 60 * 1000;
// The node's runtime-grant lifetime (node-sdk `secretKeyGrantExpiryMs` and `resolveExpiryMs`, applied in
// runtime-grants): a grant that touches any secret's key lasts 1 hour unless asked and never over 7 days; any other
// grant lasts 7 days unless asked. Every grant also ends with the session, hence "for up to".
const SECRET_KEY_GRANT_DEFAULT_MS = 60 * 60_000;
const SECRET_KEY_GRANT_MAX_MS = 7 * DAY_MS;
const SECRET_KEY_RESOURCE = /^urn:tinycloud:encryption:[^/]+\/secrets(?:\/|$)/;

/** Encryption entries' reach: a whole network, keys under a prefix, or one key. Undefined for other services. */
export type EncryptionReach =
  | { kind: "network"; name: string }
  | { kind: "keyPrefix"; prefix: string }
  | { kind: "key"; keyPath: string };

export function encryptionReach(entry: PermissionEntry): EncryptionReach | undefined {
  if (longService(entry.service) !== ENCRYPTION) return undefined;
  const slash = entry.path.indexOf("/");
  const rest = slash === -1 ? "" : entry.path.slice(slash + 1);
  if (rest === "") {
    const network = slash === -1 ? entry.path : entry.path.slice(0, slash);
    return { kind: "network", name: network.slice(network.lastIndexOf(":") + 1) };
  }
  return rest.endsWith("/") ? { kind: "keyPrefix", prefix: rest } : { kind: "key", keyPath: rest };
}

/** The lifetime the node gives the grant for `entries`, before it is cut to the session's end. */
export function grantLifetimeMs(entries: readonly PermissionEntry[], expiryMs: number | undefined): number {
  const secretKey = entries.some((entry) => longService(entry.service) === ENCRYPTION && SECRET_KEY_RESOURCE.test(entry.path));
  if (!secretKey) return expiryMs ?? EXPIRY.SESSION_MS;
  return Math.min(expiryMs ?? SECRET_KEY_GRANT_DEFAULT_MS, SECRET_KEY_GRANT_MAX_MS);
}

/** The plain-words line for one entry, granted for `lifetimeMs`. */
export function derivePermissionLine(entry: PermissionEntry, lifetimeMs: number): string {
  const reach = encryptionReach(entry);
  const words = reach === undefined
    ? PERMISSION_LINE_COPY.actions[longService(entry.service)] ?? {}
    : PERMISSION_LINE_COPY.actions[reach.kind === "network" ? "encryptionNetwork" : "encryptionKey"]!;
  const actions = actionPhrases(entry, words);
  const sentence = PERMISSION_LINE_COPY.line(
    joinWithAnd(actions),
    reach === undefined ? spaceResource(entry) : encryptionResource(reach),
    formatLifetime(lifetimeMs),
  );
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * The caption as shown: a string with control and direction-override characters removed, whitespace folded to
 * single spaces, trimmed and cut to {@link CAPTION_MAX_LENGTH} characters. Undefined when nothing is left.
 */
export function normalizeCaption(caption: unknown): string | undefined {
  if (typeof caption !== "string") return undefined;
  const folded = caption
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(folded);
  if (chars.length === 0) return undefined;
  return chars.length > CAPTION_MAX_LENGTH ? `${chars.slice(0, CAPTION_MAX_LENGTH - 1).join("")}…` : folded;
}

function longService(service: string): string {
  return SERVICE_SHORT_TO_LONG[service] ?? service;
}

/** Known actions in the copy table's order, then unknown ones verbatim in request order; each phrase once. */
function actionPhrases(entry: PermissionEntry, words: Readonly<Record<string, string>>): string[] {
  const service = longService(entry.service);
  const requested = entry.actions.map((action) => {
    if (action.startsWith(`${service}/`)) return action.slice(service.length + 1);
    if (action.startsWith(`${entry.service}/`)) return action.slice(entry.service.length + 1);
    return action;
  });
  const known = Object.keys(words).filter((action) => requested.includes(action)).map((action) => words[action]!);
  const unknown = requested
    .filter((action) => !Object.prototype.hasOwnProperty.call(words, action))
    .map(PERMISSION_LINE_COPY.unknownAction);
  return [...new Set([...known, ...unknown])];
}

function encryptionResource(reach: EncryptionReach): string {
  switch (reach.kind) {
    case "network":
      return PERMISSION_LINE_COPY.resource.network(reach.name);
    case "keyPrefix":
      return PERMISSION_LINE_COPY.resource.keyPrefix(reach.prefix);
    case "key":
      return PERMISSION_LINE_COPY.resource.key(reach.keyPath);
  }
}

function spaceResource(entry: PermissionEntry): string {
  const { resource } = PERMISSION_LINE_COPY;
  const what = entry.path === "" || entry.path === "/"
    ? resource.everything
    : entry.path.endsWith("/") ? resource.pathPrefix(entry.path) : resource.exactPath(entry.path);
  return entry.space === undefined || entry.space === "" ? what : resource.inSpace(what, entry.space);
}

/** Days, hours, minutes and seconds, largest first; a part second counts as a whole one. */
function formatLifetime(ms: number): string {
  let seconds = Math.ceil(ms / 1000);
  const parts: string[] = [];
  for (const [unit, size] of [["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]] as const) {
    const count = Math.floor(seconds / size);
    seconds -= count * size;
    if (count > 0) parts.push(`${count} ${PERMISSION_LINE_COPY.units[unit][count === 1 ? 0 : 1]}`);
  }
  return joinWithAnd(parts);
}

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} ${PERMISSION_LINE_COPY.and} ${parts[parts.length - 1]}`;
}
