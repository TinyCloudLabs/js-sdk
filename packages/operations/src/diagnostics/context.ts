import { AsyncLocalStorage } from "node:async_hooks";
import {
  diagnosticDataObject,
  diagnosticId,
  DIAGNOSTIC_ROLES,
  DIAGNOSTIC_SOURCES,
  isDiagnosticId,
  MAX_DIAGNOSTIC_CONTEXT_BYTES,
  METADATA_RETENTION_MS,
  projectDiagnosticObservation,
  type DiagnosticDescriptor,
  type DiagnosticFields,
  type DiagnosticLinks,
  type DiagnosticObservation,
  type DiagnosticPhase,
  type DiagnosticRole,
  type DiagnosticSource,
} from "./model.js";
import type { DiagnosticRuntime } from "./runtime.js";

export interface DiagnosticBinding {
  readonly runtime: DiagnosticRuntime;
  readonly source_id: string;
  readonly partition_id: string;
  readonly generation: number;
  readonly descriptor_id?: string;
}
export interface DiagnosticContext extends Omit<DiagnosticLinks, "attempt_id" | "descriptor_id"> {
  readonly binding: DiagnosticBinding;
  readonly invocation_id: string;
  readonly role?: DiagnosticRole;
  readonly role_provenance?: DiagnosticFields["role_provenance"];
  readonly source: DiagnosticSource;
}
const ENVIRONMENT_ADAPTERS = { claude_code: true, opencode_v1: true, explicit_launcher: true } as const;
const CLIENT_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const NO_CLIENT_PROVENANCE = Object.freeze({});

export interface DiagnosticEnvironmentContext {
  readonly version: 1;
  readonly scope?: "tc-apps";
  readonly run_id?: string;
  readonly turn_id?: string;
  readonly task_id?: string;
  readonly workflow_id?: string;
  readonly parent_id?: string;
  readonly wrapper_id?: string;
  readonly child_ordinal?: number;
  readonly role?: DiagnosticRole;
  readonly adapter?: keyof typeof ENVIRONMENT_ADAPTERS;
  readonly adapter_revision?: 1;
  readonly client_version?: string;
}

// Deliberately separate from credential context. ESM/CJS and independently bundled
// CLI/MCP/operations copies must share precisely this versioned context identity.
const CONTEXT = Symbol.for("tinycloud.operations.diagnostics.context.v1");
const registry = globalThis as unknown as Record<symbol, AsyncLocalStorage<DiagnosticContext | undefined> | undefined>;
const context = registry[CONTEXT] ??= new AsyncLocalStorage<DiagnosticContext | undefined>();

export function getDiagnosticContext(): DiagnosticContext | undefined {
  return context.getStore();
}
export function withDiagnosticContext<T>(value: DiagnosticContext | undefined, action: () => T): T {
  // An absent binding clears an outer scope, rather than leaking a prior tenant.
  return context.run(value === undefined ? undefined : Object.freeze({ ...value }), action);
}
/** Single-invocation CLI late-scope activation; request servers use run scopes. */
export function enterDiagnosticContext(value: DiagnosticContext | undefined): void {
  context.enterWith(value === undefined ? undefined : Object.freeze({ ...value }));
}
export function makeDiagnosticContext(
  binding: DiagnosticBinding,
  source: DiagnosticSource,
  links: Omit<DiagnosticLinks, "attempt_id" | "descriptor_id"> & {
    readonly invocation_id?: string;
    readonly role?: DiagnosticRole;
    readonly role_provenance?: DiagnosticFields["role_provenance"];
  } = {},
): DiagnosticContext {
  if (!isDiagnosticId(binding.source_id) || !isDiagnosticId(binding.partition_id)
    || !Number.isSafeInteger(binding.generation) || binding.generation < 0
    || !(DIAGNOSTIC_SOURCES as readonly string[]).includes(source)) {
    throw new TypeError("Invalid diagnostic binding.");
  }
  const projected: Record<string, string> = {};
  for (const key of ["invocation_id", "parent_id", "run_id", "turn_id", "task_id", "workflow_id", "operation_id"] as const) {
    const value = links[key];
    if (isDiagnosticId(value)) projected[key] = value;
  }
  return Object.freeze({
    ...projected,
    binding: Object.freeze({ ...binding }),
    source,
    invocation_id: projected.invocation_id ?? diagnosticId(),
    ...(links.role !== undefined && (DIAGNOSTIC_ROLES as readonly string[]).includes(links.role)
      ? { role: links.role, role_provenance: links.role_provenance ?? "client_reported" as const } : {}),
  });
}
export function emitDiagnostic(observation: DiagnosticObservation): boolean {
  try {
    const current = context.getStore();
    if (!current) return false;
    return current.binding.runtime.emit(observation, current);
  } catch {
    // Diagnostics never participate in authorization, retries, or business errors.
    return false;
  }
}

const disabledFinish = (_fields?: DiagnosticFields): void => {};
export function beginDiagnosticPhase(
  phase: DiagnosticPhase,
  fields: DiagnosticFields = {},
): (finishFields?: DiagnosticFields) => void {
  const current = context.getStore();
  if (!current) return disabledFinish;
  let operationId: string;
  try { operationId = fields.operation_id ?? diagnosticId(); } catch { return disabledFinish; }
  const started = performance.now();
  const parentId = fields.parent_id ?? (operationId === current.operation_id
    ? current.parent_id ?? current.invocation_id
    : current.operation_id ?? current.invocation_id);
  const links = { parent_id: parentId, operation_id: operationId };
  emitDiagnostic({ ...fields, ...links, type: "phase.start", phase });
  let finished = false;
  return (finishFields = {}) => {
    if (finished) return;
    finished = true;
    try {
      withDiagnosticContext(current, () => emitDiagnostic({
        ...fields, ...finishFields, ...links, type: "phase.finish", phase,
        timing_scope: finishFields.timing_scope ?? fields.timing_scope ?? "phase",
        duration_ms: Math.min(METADATA_RETENTION_MS, Math.max(0, performance.now() - started)),
      }));
    } catch { /* A failed sink cannot replace the action's result or exception. */ }
  };
}

function validateEnvironmentContext(value: unknown): DiagnosticEnvironmentContext | undefined {
  try {
    const fields = diagnosticDataObject(value, 13);
    if (!fields || fields.version !== 1) return undefined;
    for (const [key, item] of Object.entries(fields)) {
      if (key === "version") continue;
      if (key === "scope") {
        if (item !== "tc-apps") return undefined;
      } else if (key === "role") {
        if (!(DIAGNOSTIC_ROLES as readonly unknown[]).includes(item)) return undefined;
      } else if (key === "child_ordinal") {
        if (!Number.isSafeInteger(item) || Number(item) < 1 || Number(item) > 3) return undefined;
      } else if (key === "adapter") {
        if (typeof item !== "string" || !Object.prototype.hasOwnProperty.call(ENVIRONMENT_ADAPTERS, item)) return undefined;
      } else if (key === "adapter_revision") {
        if (item !== 1) return undefined;
      } else if (key === "client_version") {
        if (typeof item !== "string" || !CLIENT_VERSION.test(item)) return undefined;
      } else if (["run_id", "turn_id", "task_id", "workflow_id", "parent_id", "wrapper_id"].includes(key)) {
        if (!isDiagnosticId(item)) return undefined;
      } else return undefined;
    }
    if (fields.adapter === undefined
      ? fields.adapter_revision !== undefined || fields.client_version !== undefined
      : fields.adapter_revision !== 1) return undefined;
    return Object.freeze(fields) as unknown as DiagnosticEnvironmentContext;
  } catch { return undefined; }
}
export function decodeDiagnosticContext(value: string | undefined): DiagnosticEnvironmentContext | undefined {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_DIAGNOSTIC_CONTEXT_BYTES) return undefined;
  try {
    return validateEnvironmentContext(JSON.parse(value));
  } catch { return undefined; }
}
export function encodeDiagnosticContext(value: DiagnosticEnvironmentContext): string | undefined {
  try {
    const data = validateEnvironmentContext(value);
    if (!data) return undefined;
    const serialized = JSON.stringify(data);
    return Buffer.byteLength(serialized, "utf8") <= MAX_DIAGNOSTIC_CONTEXT_BYTES ? serialized : undefined;
  } catch { return undefined; }
}

/** Project decoded attribution only; it is never observed client identity or authority. */
export function diagnosticClientProvenance(
  environment: DiagnosticEnvironmentContext | undefined,
): Pick<DiagnosticDescriptor, "adapter" | "adapter_revision" | "client_version" | "client_trust"> {
  if (!environment?.adapter || environment.adapter_revision !== 1) return NO_CLIENT_PROVENANCE;
  return {
    adapter: environment.adapter, adapter_revision: environment.adapter_revision,
    ...(environment.client_version ? { client_version: environment.client_version } : {}),
    client_trust: "client_reported",
  };
}

/** Only fixed physical observations, never the SDK's arbitrary event stream. */
export const diagnosticTelemetry = Object.freeze({
  enabled: true as const,
  onEvent(name: string, payload: unknown): void {
    if (!context.getStore()) return;
    try {
      let type: "attempt.start" | "attempt.finish" | "retry.scheduled";
      if (name === "diagnostic.attempt.start") type = "attempt.start";
      else if (name === "diagnostic.attempt.finish") type = "attempt.finish";
      else if (name === "diagnostic.retry.scheduled") type = "retry.scheduled";
      else return;
      const fields = diagnosticDataObject(payload, 9);
      if (!fields || !isDiagnosticId(fields.attempt_id) || (fields.service !== "kv" && fields.service !== "sql")) return;
      const permitted = ["attempt_id", "service", "action", "status", "duration_ms", "delay_ms", "ordinal", "outcome"];
      if (!Object.keys(fields).every((key) => permitted.includes(key))) return;
      const observation = projectDiagnosticObservation({
        ...fields, type, layer: "transport",
        ...(type === "attempt.start" ? { dispatched: true } : {}),
        ...(type === "attempt.finish" ? { timing_scope: "transport" } : {}),
      });
      if (observation) emitDiagnostic(observation);
    } catch { /* Do not invoke the SDK's content-bearing telemetry catch path. */ }
  },
});
