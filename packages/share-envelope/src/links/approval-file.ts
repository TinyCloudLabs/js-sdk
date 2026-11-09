/**
 * `approval-pending.json`, version 2: the ONE file format of pending approval requests for the CLI and Courier, and the readers
 * of the two v1 shapes it replaces (the CLI's ARRAY of entries, Courier's single OBJECT). Pure: the adapter reads the file, calls
 * `parseApprovalFile`, applies events, and writes `serializeApprovalFile` (v2 only). A pending entry holds private keys, so an
 * entry that cannot be read is QUARANTINED with its raw content, never silently dropped, and is purged by `sweepApprovalFile`
 * after the longest possible request life.
 */
import { z } from "zod";

import {
  QUARANTINE_RETENTION_MS,
  RESULT_RETENTION_MS,
  APPROVAL_CLOCK_SKEW_MS,
  approvalEntrySchema,
  type ApprovalEntry,
} from "./approval-entry.js";
import { reduce, requesterState, type Outcome } from "./approval-requester.js";
import { parseLinkTimestamp } from "./header.js";

export interface QuarantinedEntry {
  /** The unread content exactly as found. It may hold private keys; it is purged, never printed. */
  readonly raw: unknown;
  readonly quarantinedAt: string;
}

export interface ApprovalFile {
  readonly version: 2;
  readonly entries: ApprovalEntry[];
  readonly unrecognized: QuarantinedEntry[];
}

export type ApprovalFileParse =
  /** `migratedFrom`: 1 when a v1 file was read, 0 when the file already was v2. `notes` name requests whose v1 data disagreed with the signed header. */
  | { readonly kind: "ok"; readonly file: ApprovalFile; readonly migratedFrom: 0 | 1; readonly notes: readonly { readonly requestId: string; readonly note: "request-expiry-mismatch" }[] }
  /** Written by a newer client: not corrupt, not ours to touch. */
  | { readonly kind: "newer"; readonly version: number }
  /** Not a pending-approval file at all; the adapter sets the whole file aside. */
  | { readonly kind: "corrupt" };

const quarantinedSchema = z.object({ raw: z.unknown(), quarantinedAt: z.string().refine((text) => parseLinkTimestamp(text) !== null) });
const timestamp = z.string().refine((text) => parseLinkTimestamp(text) !== null);

/**
 * What a v1 entry (CLI or Courier) must have for its expiry and creation time to be read; every other field is checked by the v2
 * entry schema after mapping. Fields v1 does not name are not carried over.
 */
const legacyEntrySchema = z.object({
  version: z.literal(1),
  requestId: z.string(),
  bodyCid: z.unknown(), approvalUrl: z.unknown(), request: z.unknown(),
  requestExpiresAt: z.string().optional(),
  record: z.object({ header: z.object({ expiresAt: timestamp, issuedAt: timestamp }).passthrough() }).passthrough(),
  apiOrigin: z.unknown(), linkApiOrigin: z.unknown(), openkeyOrigin: z.unknown(),
  signingKey: z.unknown(), relayPrivateKey: z.unknown(), ackId: z.unknown(),
  resultRef: z.unknown(), resultExpiresAt: z.unknown(), resultEnvelope: z.unknown(),
  committed: z.unknown(), acknowledged: z.unknown(),
  expectedOwner: z.unknown(), commandIntent: z.unknown(),
  command: z.object({ result: z.object({ expiry: z.string().optional() }).passthrough().optional() }).passthrough().optional(),
});

/** A v1 entry as a v2 candidate, or `undefined` when it is not a readable v1 entry (it is then quarantined). */
function migrateEntry(raw: unknown, notes: { requestId: string; note: "request-expiry-mismatch" }[]): unknown {
  const legacy = legacyEntrySchema.safeParse(raw);
  if (!legacy.success) return undefined;
  const v1 = legacy.data;
  const { header } = v1.record;
  // The signed header is the expiry OpenKey enforces; the unsigned copy of v1 is dropped.
  if (v1.requestExpiresAt !== undefined && v1.requestExpiresAt !== header.expiresAt) notes.push({ requestId: v1.requestId, note: "request-expiry-mismatch" });

  const cli = {
    ...(v1.expectedOwner === undefined ? {} : { expectedOwner: v1.expectedOwner }),
    ...(v1.commandIntent === undefined ? {} : { commandIntent: v1.commandIntent }),
    ...(v1.command === undefined ? {} : { command: v1.command }),
  };
  const phase = v1.acknowledged === true ? "acked"
    : v1.committed === true ? "committed"
    : v1.resultEnvelope !== undefined ? "fetched"
    : v1.resultRef !== undefined ? "discovered"
    : "open";
  // An acknowledged command entry is kept key-free until its child grant expires; with no readable expiry, for a bounded time.
  const childExpiry = parseLinkTimestamp(v1.command?.result?.expiry);
  const retainUntil = new Date(childExpiry ?? Date.parse(header.expiresAt) + RESULT_RETENTION_MS + APPROVAL_CLOCK_SKEW_MS).toISOString();

  return {
    requestId: v1.requestId, bodyCid: v1.bodyCid, request: v1.request,
    // An acknowledged entry holds no content key: the approval URL's fragment carries it, and the sealed body is useless without it.
    ...(phase === "acked" ? { record: { header: v1.record.header, signature: v1.record.signature } } : { approvalUrl: v1.approvalUrl, record: v1.record }),
    apiOrigin: v1.apiOrigin, linkApiOrigin: v1.linkApiOrigin, openkeyOrigin: v1.openkeyOrigin,
    ...(phase === "acked" ? {} : {
      keys: { relayPrivateKey: v1.relayPrivateKey, ...(v1.signingKey === undefined ? {} : { stagedSigningKey: v1.signingKey }) },
    }),
    phase,
    ...(v1.resultRef === undefined ? {} : { resultRef: v1.resultRef }),
    ...(v1.resultExpiresAt === undefined ? {} : { resultExpiresAt: v1.resultExpiresAt }),
    ...(v1.resultEnvelope === undefined || phase === "acked" ? {} : { resultEnvelope: v1.resultEnvelope }),
    ackId: v1.ackId,
    ...(phase === "acked" ? { retainUntil } : {}),
    createdAt: header.issuedAt,
    ext: Object.keys(cli).length === 0 ? {} : { cli },
  };
}

/** The shape every pending-approval file has: a version, and for v2 the lists. */
const fileSchema = z.object({
  version: z.number(), requestId: z.string().optional(),
  entries: z.array(z.unknown()).optional(), unrecognized: z.array(z.unknown()).optional(),
});

/**
 * Read a parsed `approval-pending.json`: the v2 file, the CLI's v1 array, or Courier's v1 object. No entry is lost: one that
 * cannot be read moves to `unrecognized` (stamped with `now`). `now` is an input so the function stays pure.
 */
export function parseApprovalFile(raw: unknown, options: { readonly now: number }): ApprovalFileParse {
  const stamp = new Date(options.now).toISOString();
  const notes: { requestId: string; note: "request-expiry-mismatch" }[] = [];
  const entries: ApprovalEntry[] = [];
  const unrecognized: QuarantinedEntry[] = [];
  const seen = new Set<string>();
  const take = (candidate: unknown, original: unknown): void => {
    const parsed = approvalEntrySchema.safeParse(candidate);
    // A repeated requestId would make `read`/`remove` ambiguous: the first entry stays, the repeat is set aside.
    if (parsed.success && !seen.has(parsed.data.requestId)) {
      seen.add(parsed.data.requestId);
      entries.push(parsed.data);
    } else unrecognized.push({ raw: original, quarantinedAt: stamp });
  };

  if (Array.isArray(raw)) {
    for (const item of raw) take(migrateEntry(item, notes), item);
    return { kind: "ok", file: { version: 2, entries, unrecognized }, migratedFrom: 1, notes };
  }
  const container = fileSchema.safeParse(raw);
  if (!container.success) return { kind: "corrupt" };
  const { version, requestId, entries: listed, unrecognized: quarantined } = container.data;
  if (version > 2) return { kind: "newer", version };
  if (version === 1 && requestId !== undefined) {
    take(migrateEntry(raw, notes), raw);
    return { kind: "ok", file: { version: 2, entries, unrecognized }, migratedFrom: 1, notes };
  }
  if (version === 2 && listed !== undefined) {
    for (const item of listed) take(item, item);
    for (const item of quarantined ?? []) {
      const kept = quarantinedSchema.safeParse(item);
      // A stamp in the future (a clock that was ahead) would never be swept: it counts from now at the latest.
      const quarantinedAt = kept.success && Date.parse(kept.data.quarantinedAt) <= options.now ? kept.data.quarantinedAt : stamp;
      unrecognized.push({ raw: kept.success ? kept.data.raw : item, quarantinedAt });
    }
    return { kind: "ok", file: { version: 2, entries, unrecognized }, migratedFrom: 0, notes };
  }
  return { kind: "corrupt" };
}

/** The text of the v2 file. The adapter writes it atomically, mode 0600, in a 0700 directory. */
export function serializeApprovalFile(file: ApprovalFile): string {
  return `${JSON.stringify({ version: 2, entries: file.entries, unrecognized: file.unrecognized }, null, 2)}\n`;
}

export interface SweptEntry {
  readonly requestId: string;
  readonly outcome: Outcome;
}

/**
 * Apply the clock to every entry (the machine's `tick`): an entry past its purge time is removed with its keys, and a quarantined
 * entry older than `QUARANTINE_RETENTION_MS` is purged. Both adapters call this on every load, under their lock, and write back
 * the result. Never extends a life; a held entry is purged on schedule.
 */
export function sweepApprovalFile(file: ApprovalFile, now: number): { readonly file: ApprovalFile; readonly dropped: SweptEntry[] } {
  const dropped: SweptEntry[] = [];
  const entries = file.entries.filter((entry) => {
    const step = reduce(requesterState(entry), { type: "tick", now });
    if (step.state.entry !== undefined || step.state.settled === undefined) return true;
    dropped.push({ requestId: entry.requestId, outcome: step.state.settled });
    return false;
  });
  const unrecognized = file.unrecognized.filter((item) => now < Date.parse(item.quarantinedAt) + QUARANTINE_RETENTION_MS);
  if (dropped.length === 0 && unrecognized.length === file.unrecognized.length) return { file, dropped };
  return { file: { version: 2, entries, unrecognized }, dropped };
}
