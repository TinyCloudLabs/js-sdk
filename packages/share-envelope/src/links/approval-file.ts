/**
 * `approval-pending.v2.json`, version 2: the ONE file format of pending approval requests for the CLI and Courier, and the readers
 * of the two v1 shapes it replaces in `approval-pending.json` (the CLI's ARRAY of entries, Courier's single OBJECT). The v2 file has
 * its own name: a published tc reads `approval-pending.json` as its v1 array with no version check, so v2 content under that name
 * makes it crash on every run. Pure: the adapter reads both files, calls `loadApprovalFiles` (which migrates the v1 file into the v2
 * file and then deletes it), applies events, and writes `serializeApprovalFile` (v2 only). Logout and the key sweep delete both
 * names (`discardApprovalFiles`). A pending entry holds private keys, so an entry that cannot be read is QUARANTINED with its raw
 * content, never silently dropped, and is purged by `sweepApprovalFile` after the longest possible request life.
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

/** The v2 file. */
export const APPROVAL_FILE = "approval-pending.v2.json";
/** The v1 file (the CLI's array, Courier's object): read, migrated into `APPROVAL_FILE`, then deleted. Never written. */
export const LEGACY_APPROVAL_FILE = "approval-pending.json";
export type ApprovalFileName = typeof APPROVAL_FILE | typeof LEGACY_APPROVAL_FILE;
/** One file operation for the adapter, applied in order: a delete that follows a write runs only after the write is durable. */
export type ApprovalFileOp =
  | { readonly op: "write"; readonly name: typeof APPROVAL_FILE }
  | { readonly op: "delete"; readonly name: ApprovalFileName };

/**
 * The parsed JSON of each file in the profile directory: absent (`undefined`) when the file does not exist, `null` when it exists
 * but is not JSON.
 */
export interface ApprovalFilesInput {
  readonly v2?: unknown;
  readonly v1?: unknown;
}

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
  expectedOwner: z.unknown(), commandIntent: z.unknown(), invitationMeta: z.unknown(),
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
    ...(v1.invitationMeta === undefined ? {} : { invitationMeta: v1.invitationMeta }),
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
 * Read one parsed pending-approval file: the v2 file, the CLI's v1 array, or Courier's v1 object. No entry is lost: one that
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

export type ApprovalFilesLoad =
  /** `ops` turns the files on disk into `file`: with a v1 file, write the v2 file, then delete the v1 file. */
  | { readonly kind: "ok"; readonly file: ApprovalFile; readonly migratedFrom: 0 | 1; readonly notes: readonly { readonly requestId: string; readonly note: "request-expiry-mismatch" }[]; readonly ops: readonly ApprovalFileOp[] }
  /** A file written by a newer client: neither file is touched. */
  | { readonly kind: "newer"; readonly version: number }
  /** `name` is not a pending-approval file: the adapter sets that file aside and loads again. */
  | { readonly kind: "corrupt"; readonly name: ApprovalFileName };

/**
 * Read the profile's pending approvals from both names. The v1 file's entries are migrated and added after the v2 file's (one that
 * repeats a v2 `requestId` is the older copy of a migration cut short, and is set aside, not dropped); the v2 file is written and only
 * then is the v1 file deleted. A v1 file can reappear after migration when an older tc runs on the same profile: it is merged again.
 */
export function loadApprovalFiles(input: ApprovalFilesInput, options: { readonly now: number }): ApprovalFilesLoad {
  const current = input.v2 === undefined ? undefined : parseApprovalFile(input.v2, options);
  if (current?.kind === "newer") return current;
  if (current?.kind === "corrupt") return { kind: "corrupt", name: APPROVAL_FILE };
  if (input.v1 === undefined) {
    return current === undefined
      ? { kind: "ok", file: { version: 2, entries: [], unrecognized: [] }, migratedFrom: 0, notes: [], ops: [] }
      : { ...current, ops: [] };
  }
  const legacy = parseApprovalFile(input.v1, options);
  if (legacy.kind === "newer") return legacy;
  if (legacy.kind === "corrupt") return { kind: "corrupt", name: LEGACY_APPROVAL_FILE };
  const merged = parseApprovalFile({
    version: 2,
    entries: [...(current?.file.entries ?? []), ...legacy.file.entries],
    unrecognized: [...(current?.file.unrecognized ?? []), ...legacy.file.unrecognized],
  }, options);
  if (merged.kind !== "ok") return { kind: "corrupt", name: LEGACY_APPROVAL_FILE };
  return {
    kind: "ok", file: merged.file, migratedFrom: 1, notes: [...(current?.notes ?? []), ...legacy.notes],
    ops: [{ op: "write", name: APPROVAL_FILE }, { op: "delete", name: LEGACY_APPROVAL_FILE }],
  };
}

/**
 * Logout and the key sweep: delete BOTH names, whatever they hold (a file that cannot be read, or one from a newer client, may
 * hold keys too); a name that does not exist counts as deleted. `requestIds`: the readable entries this removes, for the message.
 */
export function discardApprovalFiles(input: ApprovalFilesInput, options: { readonly now: number }): { readonly requestIds: readonly string[]; readonly ops: readonly ApprovalFileOp[] } {
  const requestIds = new Set<string>();
  for (const raw of [input.v2, input.v1]) {
    if (raw === undefined) continue;
    const parsed = parseApprovalFile(raw, options);
    if (parsed.kind === "ok") for (const entry of parsed.file.entries) requestIds.add(entry.requestId);
  }
  return { requestIds: [...requestIds], ops: [{ op: "delete", name: APPROVAL_FILE }, { op: "delete", name: LEGACY_APPROVAL_FILE }] };
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
