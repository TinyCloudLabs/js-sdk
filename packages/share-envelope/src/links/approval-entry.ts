/**
 * One pending approval request as a requester keeps it on disk: the schema of an entry of `approval-pending.json` (v2) and
 * the two time rules every client shares, the local expiry `E` and the purge time. Pure: no clock, no I/O.
 *
 * An entry HOLDS PRIVATE KEYS (`keys`): the relay key that opens the approved result, and, when this request's signing key is
 * not the profile's stored one (a first sign-in, a key rotation staged by the CLI), that signing key. Nothing here ever
 * prints, logs or copies a key into an error.
 */
import { z } from "zod";

import { parseApprovalRequest, type OpenKeyApprovalRequestV1 } from "./approval-request.js";
import { LINK_ID_PATTERN, LINK_TYPE_SPECS, LINK_WINDOW_SECONDS } from "./constants.js";
import { decodeStrictBase64Url, linkHeaderV1Schema, linkSignatureV1Schema, parseLinkTimestamp } from "./header.js";

/** `R`: how long OpenKey keeps an approved result (production `APPROVAL_RESULT_RETENTION_SECONDS=600`). */
export const RESULT_RETENTION_MS = 600_000;
/** `S`: the allowance added AFTER the signed expiry, never before it: a clock running ahead must not drop an entry OpenKey would still serve. */
export const APPROVAL_CLOCK_SKEW_MS = 30_000;
/** A local clock that differs from the server's HTTP `Date` by MORE than this is measurably off (OpenKey accepts a proof `iat` within 60 s). */
export const CLOCK_DISAGREEMENT_MS = 60_000;
/** How long an approved result may still be fetched after the caller's deadline passed. */
export const COLLECT_GRACE_MS = 30_000;
/** Unmapped replies in a row before a run gives up (exit 7). */
export const MAX_UNEXPECTED_REPLIES = 5;
/** An entry that cannot be read has no expiry to read: it is purged after the longest request life (24 h) plus retention and skew. */
export const QUARANTINE_RETENTION_MS = 86_400_000 + RESULT_RETENTION_MS + APPROVAL_CLOCK_SKEW_MS;

export const APPROVAL_PHASES = ["open", "discovered", "fetched", "committed", "acked"] as const;
/**
 * `open`: created, no result known. `discovered`: OpenKey gave a result reference. `fetched`: the encrypted envelope is held.
 * `committed`: the caller saved the grant durably; only the ack remains. `acked`: acknowledged; kept key-free only until
 * `retainUntil` (a CLI command entry).
 */
export type ApprovalPhase = (typeof APPROVAL_PHASES)[number];
export type ApprovalKeyName = "relayPrivateKey" | "stagedSigningKey";

const isoTime = z.string().refine((text) => parseLinkTimestamp(text) !== null, "not a canonical ISO-8601 UTC timestamp");
const bytes32 = z.string().refine((text) => decodeStrictBase64Url(text)?.length === 32, "not 32 base64url bytes");
/**
 * The CLI's session key as `TCWSessionManager.jwk()` emits it: `{ crv, d, kid, kty, x }`. `kid` (and `alg`/`use`, which a
 * user-imported key.json may carry) are accepted as short strings; anything else is refused.
 */
const jwkLabel = z.string().min(1).max(128);
const ed25519Jwk = z
  .object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: bytes32, d: bytes32, kid: jwkLabel.optional(), alg: jwkLabel.optional(), use: jwkLabel.optional() })
  .strict();
/** The longest an approval request lives (OpenKey refuses more at creation). */
const MAX_REQUEST_LIFE_MS = LINK_TYPE_SPECS["openkey-approval-request"].maxLifeSeconds * 1000;

const request = z.custom<OpenKeyApprovalRequestV1>((value) => {
  try {
    parseApprovalRequest(value);
    return true;
  } catch {
    return false;
  }
}, "not an approval request");

export const approvalEntrySchema = z
  .object({
    requestId: z.string().regex(LINK_ID_PATTERN),
    bodyCid: z.string().min(1),
    /** Carries the content key in its fragment: secret. Absent once `acked`. */
    approvalUrl: z.string().min(1).optional(),
    request,
    /** The signed record that created the request; `header.expiresAt` is THE expiry. */
    record: z.object({ header: linkHeaderV1Schema, signature: linkSignatureV1Schema, body: z.string().optional() }).strict(),
    apiOrigin: z.string().min(1),
    linkApiOrigin: z.string().min(1),
    openkeyOrigin: z.string().min(1),
    /** Absent only once `acked`. */
    keys: z.object({ relayPrivateKey: bytes32, stagedSigningKey: ed25519Jwk.optional() }).strict().optional(),
    phase: z.enum(APPROVAL_PHASES),
    resultRef: z.string().min(1).optional(),
    resultExpiresAt: isoTime.optional(),
    resultEnvelope: z.unknown().optional(),
    /** Sent with the acknowledgement; stable across retries so OpenKey recognises the same ack. */
    ackId: z.string().min(1),
    /** Kept by the clock: the next run retries. It does not extend the purge time. */
    hold: z.object({ kind: z.literal("clock"), since: isoTime }).strict().optional(),
    /** Key-free retention of an acknowledged command entry. */
    retainUntil: isoTime.optional(),
    createdAt: isoTime,
    /** Caller-owned fields (`ext.cli`, `ext.courier`), opaque to the machine and round-tripped untouched. */
    ext: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((entry, context) => {
    const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
    if (entry.phase === "acked") {
      if (entry.keys !== undefined) issue("an acked entry holds no key");
      if (entry.approvalUrl !== undefined) issue("an acked entry holds no approval URL (its fragment holds the content key)");
      if (entry.retainUntil === undefined) issue("an acked entry needs retainUntil");
      if (entry.hold !== undefined) issue("an acked entry cannot be held");
    } else {
      if (entry.keys === undefined) issue("an entry that is not acked holds its relay key");
      if (entry.approvalUrl === undefined) issue("an entry that is not acked holds its approval URL");
    }
    // A key's life is bounded by construction: the signed request life, and the time since this entry was created.
    const { issuedAt, expiresAt } = entry.record.header;
    const expiry = Date.parse(expiresAt);
    if (expiry - Date.parse(issuedAt) > MAX_REQUEST_LIFE_MS) issue("the request life exceeds the maximum");
    if (expiry - Date.parse(entry.createdAt) > MAX_REQUEST_LIFE_MS + LINK_WINDOW_SECONDS * 1000) issue("the request expires too long after its creation");
    if (entry.phase !== "open" && entry.phase !== "acked" && (entry.resultRef === undefined || entry.resultExpiresAt === undefined)) {
      issue("a discovered entry names its result");
    }
    if ((entry.phase === "fetched" || entry.phase === "committed") && entry.resultEnvelope === undefined) issue("a fetched entry holds its envelope");
  });

export type ApprovalEntry = z.infer<typeof approvalEntrySchema>;

/** The names of the private keys an entry holds now (never their values). */
export function heldKeys(entry: ApprovalEntry): ApprovalKeyName[] {
  const names: ApprovalKeyName[] = [];
  if (entry.keys?.relayPrivateKey !== undefined) names.push("relayPrivateKey");
  if (entry.keys?.stagedSigningKey !== undefined) names.push("stagedSigningKey");
  return names;
}

/** `E`: the signed header's `expiresAt`, the expiry OpenKey enforces. The stored copy `requestExpiresAt` of v1 files is not trusted. */
export function localExpiry(entry: ApprovalEntry): number {
  return Date.parse(entry.record.header.expiresAt);
}

/**
 * When the entry, and with it every key it holds, must be gone whatever else happens. `open`: `E + R + S`. Once approved:
 * `min(resultExpiresAt, E + R) + S`; the `E + R` cap comes from the signed header, so a forged `resultExpiresAt` cannot extend a
 * life. `acked`: `retainUntil`.
 */
export function purgeAt(entry: ApprovalEntry): number {
  const expiry = localExpiry(entry);
  const unapproved = expiry + RESULT_RETENTION_MS + APPROVAL_CLOCK_SKEW_MS;
  if (entry.phase === "acked") return entry.retainUntil === undefined ? unapproved : Date.parse(entry.retainUntil);
  if (entry.phase === "open" || entry.resultExpiresAt === undefined) return unapproved;
  const result = Date.parse(entry.resultExpiresAt);
  // An unreadable stored expiry must never make the purge time NaN (a NaN compares false forever): fall back to the open bound.
  return Number.isFinite(result) ? Math.min(result, expiry + RESULT_RETENTION_MS) + APPROVAL_CLOCK_SKEW_MS : unapproved;
}
