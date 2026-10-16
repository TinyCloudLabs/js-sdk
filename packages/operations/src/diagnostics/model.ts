import { randomUUID } from "node:crypto";

export const DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_EVENT_BYTES = 4096;
export const MAX_DIAGNOSTIC_CONTEXT_BYTES = 2048;
export const METADATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DETAIL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const DIAGNOSTIC_SOURCES = ["cli", "mcp_http", "mcp_stdio", "wrapper", "client"] as const;
export type DiagnosticSource = typeof DIAGNOSTIC_SOURCES[number];
export const DIAGNOSTIC_ROLES = ["catalog", "record", "verification", "copy", "approval", "context", "unknown"] as const;
export type DiagnosticRole = typeof DIAGNOSTIC_ROLES[number];
export const DIAGNOSTIC_EVENT_TYPES = [
  "invocation.start", "invocation.finish", "phase.start", "phase.finish", "operation.step",
  "attempt.start", "attempt.finish", "retry.scheduled", "protocol.outcome", "delivery.outcome",
  "client.lifecycle", "capture.health",
] as const;
export type DiagnosticEventType = typeof DIAGNOSTIC_EVENT_TYPES[number];

/** Code-owned vocabularies, not patterns allowing arbitrary application strings. */
export const DIAGNOSTIC_VOCABULARY = {
  activity: ["kv", "sql", "auth", "context", "init", "help", "version", "parser", "import", "apps_context", "apps_read", "apps_write", "apps_index", "connect", "http", "mcp_request", "protocol", "unknown"],
  phase: ["bootstrap", "import", "parse", "process", "dispatch", "preparation", "restore", "replay", "authority_planning", "approval_request", "approval_wait", "approval_poll", "approval_verify", "approval_commit", "execution", "output_projection", "input_validation", "output_validation", "validation", "local_commit", "delivery", "copy", "read_back", "http_gate", "host_validation", "origin_validation", "bearer_validation", "tenant_init", "executor", "result_projection"],
  role: DIAGNOSTIC_ROLES,
  role_provenance: ["observed", "client_reported", "owner_reported"],
  service: ["kv", "sql", "auth", "http", "mcp", "local"],
  action: ["get", "put", "delete", "list", "head", "export", "copy", "batchPut", "batchGet", "query", "execute", "batch", "create", "replace", "move", "drop", "describe", "read", "write", "context", "index", "connect", "login", "request", "poll", "verify", "commit", "restore", "replay", "upsert", "stale_mark", "rebuild", "count_check", "key_set_check", "source_read", "destination_write", "source_delete", "collision", "approval", "cancel", "unknown"],
  layer: ["transport", "wrapper_child", "copy_chunk"],
  business: ["complete", "partial", "failed", "awaiting_owner", "unknown", "not_applicable"],
  canonical_status: ["ok", "error", "authority_required", "setup_required", "unknown"],
  mutation: ["not_dispatched", "rejected", "confirmed", "unknown", "not_applicable"],
  verification: ["none", "read_back", "write_response", "unknown"],
  verification_result: ["match", "mismatch", "found", "missing", "failed", "unknown", "not_applicable"],
  copy_state: ["absent", "ready", "stale", "partial", "unavailable", "failed", "unknown", "not_applicable"],
  copy_check: ["none", "count", "key_set", "rebuild", "unknown"],
  protocol: ["received", "input_valid", "input_invalid", "handler_started", "handler_finished", "before_executor_refusal", "post_executor_protocol_failure", "output_valid", "output_invalid", "send_started", "send_finished", "send_failed", "result", "tool_error", "unknown"],
  delivery: ["finish", "close_before_finish", "close_after_finish", "error", "unknown"],
  outcome: ["started", "complete", "partial", "failed", "awaiting_owner", "unknown", "not_applicable", "response", "error", "pass", "fail", "refused", "cancelled", "denied", "expired", "pending", "reused", "installed", "skipped", "accepted", "dropped", "interrupted", "converted"],
  warning: ["copy_unavailable", "copy_partial", "copy_stale", "copy_maintenance_failed", "stale_mark_failed", "read_partial", "malformed_record", "truncated", "collision", "size_limit", "schema_warning", "field_name_invalid", "field_not_in_catalog", "date_format_invalid", "timestamp_invalid", "record_date_mismatch", "read_member_omitted", "read_etag_missing", "pagination_incomplete", "unknown"],
  failure: ["none", "invalid_context", "invalid_event", "oversize", "disabled", "paused", "queue_full", "worker_start", "worker_dead", "permission", "unsafe_path", "storage_full", "lock_contention", "quota", "write_failed", "drain_timeout", "invalid_config", "retention_failed", "delete_failed", "generation_changed", "unknown"],
  error_class: ["input_invalid", "auth_required", "permission_denied", "not_found", "network", "node", "storage_full", "precondition", "catalog_change", "timezone_required", "cancelled", "internal", "unknown"],
  timing_scope: ["process", "bootstrap", "invocation", "phase", "transport", "wrapper_child", "copy_chunk", "approval_wait", "delivery", "handler", "validation", "http_exchange", "protocol_send"],
  lifecycle: ["run_start", "run_finish", "turn_start", "turn_finish", "tool_start", "tool_finish", "cancelled"],
  signal: ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"],
} as const;
type Vocabulary = typeof DIAGNOSTIC_VOCABULARY;
type EnumFields = { readonly [K in keyof Vocabulary]?: Vocabulary[K][number] };
export type DiagnosticPhase = Vocabulary["phase"][number];

const COUNT_FIELDS = [
  "ordinal", "requested", "unique", "returned", "missing", "malformed", "pages", "mutations",
  "collisions", "retries", "replay_examined", "replay_installed", "replay_skipped", "chunks", "kinds",
  "bytes", "dropped", "accepted", "incomplete", "queue_bytes", "queue_events", "schema_revision", "operation_version",
] as const;
const BOOLEAN_FIELDS = ["truncated", "dispatched", "timezone_configured", "is_error"] as const;
const LINK_FIELDS = ["parent_id", "run_id", "turn_id", "task_id", "workflow_id", "operation_id", "attempt_id", "descriptor_id"] as const;
export type DiagnosticLinks = { readonly [K in typeof LINK_FIELDS[number]]?: string };
export type DiagnosticMeasures = { readonly [K in typeof COUNT_FIELDS[number]]?: number }
  & { readonly [K in typeof BOOLEAN_FIELDS[number]]?: boolean }
  & { readonly duration_ms?: number; readonly delay_ms?: number; readonly status?: number; readonly exit_code?: number };
export type DiagnosticFields = EnumFields & DiagnosticMeasures & Pick<DiagnosticLinks, "parent_id" | "operation_id" | "attempt_id">;
export type DiagnosticObservation = {
  [K in DiagnosticEventType]: Readonly<{ type: K }> & DiagnosticFields;
}[DiagnosticEventType];
export type DiagnosticEvent = DiagnosticObservation & DiagnosticLinks & Readonly<{
  schema_version: 1;
  event_id: string;
  source_id: string;
  process_id: string;
  partition_id: string;
  invocation_id: string;
  sequence: number;
  occurred_at: string;
  source: DiagnosticSource;
}>;

export const DIAGNOSTIC_GAPS = [
  "unfinished_invocation", "incomplete_tail", "sequence_gap", "clock_anomaly", "descriptor_missing",
  "linkage_unknown", "sink_failure", "expired_evidence", "conflict", "unsupported_adapter", "import_untrusted",
  "coverage_unknown", "dropped_events", "external_copy", "offline_cleanup", "power_loss_not_guaranteed",
] as const;
export type DiagnosticGap = typeof DIAGNOSTIC_GAPS[number];
export interface DiagnosticSelection {
  readonly source_ids?: readonly string[];
  readonly event_ids?: readonly string[];
  readonly invocation_ids?: readonly string[];
  readonly case_ids?: readonly string[];
  readonly from?: string;
  readonly until?: string;
  readonly include_detail?: boolean;
  /** Only explicit selection files may request all; deletion additionally decides pause_after. */
  readonly all?: boolean;
}
export interface DiagnosticDescriptor {
  readonly descriptor_id: string;
  readonly source: DiagnosticSource;
  readonly package?: "@tinycloud/cli" | "@tinycloud/mcp" | "@tinycloud/operations" | "tc-apps";
  readonly version?: string;
  readonly build_hash?: string;
  readonly wrapper_revision?: string;
  readonly skill_revision?: string;
  readonly rules_revision?: string;
  readonly adapter?: "claude_code" | "codex" | "opencode_v1" | "opencode_v2" | "explicit_launcher" | "unknown";
  readonly adapter_revision?: number;
  readonly client_version?: string;
  readonly client_trust?: "observed" | "client_reported" | "owner_reported";
  readonly model?: "unknown";
  readonly model_trust?: "observed" | "client_reported" | "owner_reported";
}
export interface DiagnosticSnapshot {
  readonly events: DiagnosticEvent[];
  readonly descriptors: DiagnosticDescriptor[];
  readonly gaps: DiagnosticGap[];
  /** Source-qualified keys in the form source_id/event_id, never bare event UUIDs. */
  readonly conflicts: string[];
  /** Retained imported assertions contribute their original retention bound even without event rows. */
  readonly assertions?: readonly { source_ids: readonly string[]; expires_at: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:alpha|beta|rc)\.\d{1,5})?$/;
const HASH = /^(?:[0-9a-f]{7,64})$/;
export function diagnosticId(): string { return randomUUID(); }
export function isDiagnosticId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
export function isDiagnosticTime(value: unknown): value is string {
  if (typeof value !== "string" || !UTC.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/** Inspect data descriptors only: getters, custom prototypes and unknown keys are never serialized. */
export function diagnosticDataObject(value: unknown, maximumKeys = 80): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object") return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumKeys || keys.some((key) => typeof key !== "string")) return undefined;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      if (descriptor.value !== undefined) result[key] = descriptor.value;
    }
    return result;
  } catch { return undefined; }
}
function member(values: readonly unknown[], value: unknown): boolean { return values.includes(value); }
function count(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
}
function duration(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= METADATA_RETENTION_MS;
}
const ENVELOPE_KEYS: Readonly<Record<string, true>> = {
  schema_version: true, event_id: true, source_id: true, process_id: true,
  partition_id: true, invocation_id: true, sequence: true, occurred_at: true, source: true,
};
function validObservationField(key: string, value: unknown): boolean {
  if (key === "type") return member(DIAGNOSTIC_EVENT_TYPES, value);
  if (Object.prototype.hasOwnProperty.call(DIAGNOSTIC_VOCABULARY, key)) return member(DIAGNOSTIC_VOCABULARY[key as keyof Vocabulary], value);
  if ((COUNT_FIELDS as readonly string[]).includes(key)) return count(value);
  if ((BOOLEAN_FIELDS as readonly string[]).includes(key)) return typeof value === "boolean";
  if (key === "parent_id" || key === "operation_id" || key === "attempt_id") return isDiagnosticId(value);
  if (key === "duration_ms" || key === "delay_ms") return duration(value);
  if (key === "status") return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599;
  if (key === "exit_code") return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255;
  return false;
}
export function projectDiagnosticObservation(value: unknown): DiagnosticObservation | undefined {
  const fields = diagnosticDataObject(value);
  if (!fields || !member(DIAGNOSTIC_EVENT_TYPES, fields.type)) return undefined;
  if (!Object.entries(fields).every(([key, item]) => validObservationField(key, item))) return undefined;
  return fields as DiagnosticObservation;
}
export function validateDiagnosticEvent(value: unknown): DiagnosticEvent | undefined {
  const fields = diagnosticDataObject(value);
  if (!fields || fields.schema_version !== 1 || !member(DIAGNOSTIC_EVENT_TYPES, fields.type)
    || !member(DIAGNOSTIC_SOURCES, fields.source) || !isDiagnosticTime(fields.occurred_at)
    || !Number.isSafeInteger(fields.sequence) || Number(fields.sequence) < 1) return undefined;
  for (const key of ["event_id", "source_id", "process_id", "partition_id", "invocation_id"]) {
    if (!isDiagnosticId(fields[key])) return undefined;
  }
  for (const [key, item] of Object.entries(fields)) {
    if (LINK_FIELDS.includes(key as typeof LINK_FIELDS[number])) {
      if (!isDiagnosticId(item)) return undefined;
    } else if (!Object.prototype.hasOwnProperty.call(ENVELOPE_KEYS, key) && !validObservationField(key, item)) return undefined;
  }
  return fields as DiagnosticEvent;
}
export function encodeDiagnosticEvent(value: unknown): string | undefined {
  const event = validateDiagnosticEvent(value);
  if (!event) return undefined;
  const line = JSON.stringify(event);
  return Buffer.byteLength(line, "utf8") + 1 <= MAX_DIAGNOSTIC_EVENT_BYTES ? line : undefined;
}

/** Identity compares validated scalar metadata, never JSON property insertion order. */
export function diagnosticMetadataEqual(left: unknown, right: unknown): boolean {
  const first = diagnosticDataObject(left);
  const second = diagnosticDataObject(right);
  if (!first || !second) return false;
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length && keys.every((key) => {
    const value = first[key];
    return (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      && value === second[key];
  });
}
export function validateDiagnosticSelection(value: unknown): DiagnosticSelection | undefined {
  const fields = diagnosticDataObject(value, 8);
  if (!fields) return undefined;
  for (const [key, item] of Object.entries(fields)) {
    if (key === "source_ids" || key === "event_ids" || key === "invocation_ids" || key === "case_ids") {
      if (!Array.isArray(item) || item.length === 0 || item.length > 4096 || !item.every(isDiagnosticId)) return undefined;
    } else if (key === "from" || key === "until") {
      if (!isDiagnosticTime(item)) return undefined;
    } else if (key === "include_detail" || key === "all") {
      if (typeof item !== "boolean") return undefined;
    } else return undefined;
  }
  if (typeof fields.from === "string" && typeof fields.until === "string" && fields.from > fields.until) return undefined;
  if (fields.all !== true && !fields.source_ids && !fields.event_ids && !fields.invocation_ids && !fields.case_ids && !fields.from && !fields.until) return undefined;
  return fields as DiagnosticSelection;
}
export function diagnosticEventSelected(event: DiagnosticEvent, selection: DiagnosticSelection): boolean {
  // Cases are expanded to their explicitly linked event IDs by the review layer.
  if (selection.case_ids && !selection.all && !selection.source_ids && !selection.event_ids
    && !selection.invocation_ids && !selection.from && !selection.until) return false;
  return (!selection.source_ids || selection.source_ids.includes(event.source_id))
    && (!selection.event_ids || selection.event_ids.includes(event.event_id))
    && (!selection.invocation_ids || selection.invocation_ids.includes(event.invocation_id))
    && (!selection.from || event.occurred_at >= selection.from)
    && (!selection.until || event.occurred_at <= selection.until);
}
/** Conflict references have no invocation or timestamp; those scopes cannot be inferred. */
export function diagnosticConflictSelected(key: string, selection: DiagnosticSelection): boolean {
  const [sourceId, eventId] = key.split("/");
  if (selection.invocation_ids || selection.from || selection.until) return false;
  if (selection.case_ids && !selection.all && !selection.source_ids && !selection.event_ids) return false;
  return (!selection.source_ids || selection.source_ids.includes(sourceId!))
    && (!selection.event_ids || selection.event_ids.includes(eventId!));
}
export function validateDiagnosticDescriptor(value: unknown): DiagnosticDescriptor | undefined {
  const fields = diagnosticDataObject(value, 16);
  if (!fields || !isDiagnosticId(fields.descriptor_id) || !member(DIAGNOSTIC_SOURCES, fields.source)) return undefined;
  for (const [key, item] of Object.entries(fields)) {
    if (key === "descriptor_id" || key === "source") continue;
    if (key === "package") {
      if (!member(["@tinycloud/cli", "@tinycloud/mcp", "@tinycloud/operations", "tc-apps"], item)) return undefined;
    } else if (key === "version" || key === "client_version") {
      if (typeof item !== "string" || !VERSION.test(item)) return undefined;
    } else if (key === "build_hash" || key === "rules_revision") {
      if (typeof item !== "string" || !HASH.test(item)) return undefined;
    } else if (key === "wrapper_revision" || key === "skill_revision") {
      if (typeof item !== "string" || (!VERSION.test(item) && !HASH.test(item))) return undefined;
    } else if (key === "adapter") {
      if (!member(["claude_code", "codex", "opencode_v1", "opencode_v2", "explicit_launcher", "unknown"], item)) return undefined;
    } else if (key === "adapter_revision") {
      if (!count(item)) return undefined;
    } else if (key === "client_trust" || key === "model_trust") {
      if (!member(["observed", "client_reported", "owner_reported"], item)) return undefined;
    } else if (key === "model") {
      if (item !== "unknown") return undefined;
    } else return undefined;
  }
  return fields as unknown as DiagnosticDescriptor;
}
