import { sha256 } from "@noble/hashes/sha256";
import { toBase64Url } from "@tinycloud/share-envelope";

/**
 * Identifiers and the key classifier for the shared share index
 * (TC-1432 design C §1). All keys here are relative to the vault prefix
 * `sender-history/v2/records/`.
 */

/** Vault key prefix of every share record and of the index documents. */
export const SHARE_RECORDS_VAULT_PREFIX = "sender-history/v2/records/";
/** The main index document key. */
export const INDEX_MAIN_KEY = "_index/main";
/** Length of a DID-derived agent id (132 bits of base64url). */
export const AGENT_ID_LENGTH = 22;
/** Raw key suffixes recorded in `rejectedKeys` are truncated to this length. */
export const REJECTED_KEY_MAX_LENGTH = 64;

const AGENT_ID_DOMAIN = "xyz.tinycloud.share/agent-id/v1|";
const SHARE_ID = /^[A-Za-z0-9_-]{1,512}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{22}$/;
const ARCHIVE_NAME = /^archive-\d{4}$/;

/** `^[A-Za-z0-9_-]{1,512}$`, excluding the reserved first segments `_index` and `agents`. */
export function isShareId(value: unknown): value is string {
  return typeof value === "string" && SHARE_ID.test(value) && value !== "_index" && value !== "agents";
}

export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID.test(value);
}

/** Index document names under `_index/`: `main` and `archive-<yyyy>`. */
export function isIndexDocumentName(value: unknown): value is string {
  return typeof value === "string" && (value === "main" || ARCHIVE_NAME.test(value));
}

/**
 * The first 22 base64url characters of
 * `sha256("xyz.tinycloud.share/agent-id/v1|" + agentDid)`. `agentDid` is the
 * DID of the key that signs the agent's invocations and delegations, so a new
 * key gets a new prefix.
 */
export function agentIdFromDid(agentDid: string): string {
  if (typeof agentDid !== "string" || !agentDid.startsWith("did:") || /[\s#]/.test(agentDid)) throw new TypeError("agent DID is invalid");
  return toBase64Url(sha256(new TextEncoder().encode(AGENT_ID_DOMAIN + agentDid))).slice(0, AGENT_ID_LENGTH);
}

export function agentRecordKey(agentId: string, shareId: string): string {
  if (!isAgentId(agentId) || !isShareId(shareId)) throw new TypeError("agent record key is invalid");
  return `agents/${agentId}/${shareId}`;
}

/** Explicit list prefix (with the trailing slash) of one agent's records, relative to `records/`. */
export function agentRecordPrefix(agentId: string): string {
  if (!isAgentId(agentId)) throw new TypeError("agent id is invalid");
  return `agents/${agentId}/`;
}

export type ClassifiedRecordKey =
  | { readonly kind: "index"; readonly name: string }
  | { readonly kind: "web"; readonly shareId: string }
  | { readonly kind: "agent"; readonly agentId: string; readonly shareId: string }
  /**
   * Never fetched, never rendered. `agentId`/`suffix` are set when the key
   * lies inside an agent prefix (`agents/<valid id>/…`), so it is counted
   * once against that agent; any other key can only be written by owner
   * clients and is skipped without counting.
   */
  | { readonly kind: "rejected"; readonly agentId?: string; readonly suffix?: string };

/** The raw suffix recorded in `rejectedKeys`: at most 64 characters. */
export function rejectedKeyEntry(suffix: string): string {
  return suffix.slice(0, REJECTED_KEY_MAX_LENGTH);
}

function hasUnsafeShape(key: string): boolean {
  if (key.length === 0 || key.startsWith("/") || key.includes("%") || key.includes("\\")) return true;
  return key.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/**
 * Classify one raw listed key (relative to `records/`), before any
 * needs-attention logic. A key containing `%`, `\`, a `.`/`..` segment, an
 * empty segment or a leading `/` is rejected first.
 */
export function classifyRecordKey(key: string): ClassifiedRecordKey {
  if (typeof key !== "string") return { kind: "rejected" };
  const agentPrefix = /^agents\/([A-Za-z0-9_-]{22})\//.exec(key);
  const owner = agentPrefix === null ? {} : { agentId: agentPrefix[1]!, suffix: rejectedKeyEntry(key.slice(agentPrefix[0].length)) };
  if (hasUnsafeShape(key)) return { kind: "rejected", ...owner };
  const segments = key.split("/");
  if (segments.length === 1) return isShareId(key) ? { kind: "web", shareId: key } : { kind: "rejected" };
  if (segments[0] === "_index") return segments.length === 2 && isIndexDocumentName(segments[1]) ? { kind: "index", name: segments[1]! } : { kind: "rejected" };
  if (segments[0] === "agents" && segments.length === 3 && isAgentId(segments[1]) && isShareId(segments[2])) {
    return { kind: "agent", agentId: segments[1]!, shareId: segments[2]! };
  }
  return { kind: "rejected", ...owner };
}
