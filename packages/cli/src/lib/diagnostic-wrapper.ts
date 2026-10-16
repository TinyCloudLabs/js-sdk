import {
  createDiagnosticRuntime, decodeDiagnosticContext, diagnosticClientProvenance, diagnosticDataObject, diagnosticId,
  encodeDiagnosticContext, isDiagnosticId, makeDiagnosticContext, METADATA_RETENTION_MS,
} from "@tinycloud/operations/diagnostics";
import type { DiagnosticEnvironmentContext, DiagnosticRuntime } from "@tinycloud/operations/diagnostics";

/** Private wrapper continuation, never a storage path or business input. */
interface WrapperState {
  version: 1;
  activity: "kv" | "sql";
  source_id: string;
  generation: number;
  wrapper_id: string;
  started_ns: string;
  context: DiagnosticEnvironmentContext;
  ordinal?: number;
  attempt_id?: string;
  attempt_started_ns?: string;
}
const STATE_FIELDS: Readonly<Record<string, true>> = {
  version: true, activity: true, source_id: true, generation: true, wrapper_id: true,
  started_ns: true, context: true, ordinal: true, attempt_id: true, attempt_started_ns: true,
};
const MAX_STATE_BYTES = 4096;
const MAX_INTERVAL_NS = BigInt(METADATA_RETENTION_MS) * 1_000_000n;

function wrapperState(raw: string | undefined, now: bigint): WrapperState | undefined {
  if (!raw || Buffer.byteLength(raw) > MAX_STATE_BYTES) return undefined;
  try {
    const value = diagnosticDataObject(JSON.parse(raw), 10);
    if (!value || Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(STATE_FIELDS, key))
      || value.version !== 1 || (value.activity !== "kv" && value.activity !== "sql")
      || !isDiagnosticId(value.source_id) || !isDiagnosticId(value.wrapper_id)
      || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1) return undefined;
    const context = value.context as DiagnosticEnvironmentContext;
    if (!encodeDiagnosticContext(context) || context.scope !== "tc-apps") return undefined;
    for (const field of ["started_ns", "attempt_started_ns"] as const) {
      const stamp = value[field];
      if (field === "attempt_started_ns" && stamp === undefined) continue;
      if (typeof stamp !== "string" || !/^[0-9]{1,20}$/.test(stamp)) return undefined;
      const elapsed = now - BigInt(stamp);
      if (elapsed < 0n || elapsed > MAX_INTERVAL_NS) return undefined;
    }
    if (value.ordinal !== undefined && (!Number.isInteger(value.ordinal) || Number(value.ordinal) < 1 || Number(value.ordinal) > 3)) return undefined;
    if ((value.attempt_id === undefined) !== (value.attempt_started_ns === undefined)) return undefined;
    if (value.attempt_id !== undefined && (!isDiagnosticId(value.attempt_id) || value.ordinal === undefined
      || BigInt(value.attempt_started_ns as string) < BigInt(value.started_ns as string))) return undefined;
    return value as unknown as WrapperState;
  } catch { return undefined; }
}

/**
 * Closed native protocol used by tc-wrapper.sh. It never reads stdin or business
 * streams. Only acknowledged observations produce a continuation; failure is silent.
 * hrtime intervals cover the wrapper's observed boundaries, including helper overhead.
 */
export async function observeDiagnosticWrapper(stage: string, value?: string, exitCode?: string, decision?: string): Promise<void> {
  let runtime: DiagnosticRuntime | undefined;
  let output: string | undefined;
  let expected = 0;
  try {
    const now = process.hrtime.bigint();
    const inherited = decodeDiagnosticContext(process.env.TC_DIAGNOSTICS_CONTEXT);
    let state: WrapperState | undefined;
    if (stage === "begin") {
      if (inherited?.scope !== "tc-apps" || (value !== "kv" && value !== "sql") || exitCode !== undefined || decision !== undefined) return;
    } else {
      if (stage !== "child" && stage !== "finish") return;
      state = wrapperState(process.env.TC_DIAGNOSTICS_WRAPPER_STATE, now);
      if (!state || !value || !/^[1-3]$/.test(value)) return;
      if (stage === "child" && (exitCode !== undefined || decision !== undefined || state.attempt_id !== undefined
        || Number(value) !== (state.ordinal ?? 0) + 1)) return;
      if (stage === "finish" && (!state.attempt_id || Number(value) !== state.ordinal || !exitCode
        || !/^(?:0|[1-9][0-9]{0,2})$/.test(exitCode) || Number(exitCode) > 255
        || (decision !== "retry" && decision !== "stop")
        || (decision === "retry" && (Number(exitCode) === 0 || state.ordinal === 3)))) return;
    }
    runtime = createDiagnosticRuntime({ source: "wrapper", descriptor: {
      descriptor_id: diagnosticId(), source: "wrapper", package: "tc-apps", wrapper_revision: "1.0.0",
      ...diagnosticClientProvenance(state?.context ?? inherited),
    } });
    const binding = await runtime.binding();
    if (!binding || (state && (state.source_id !== binding.source_id || state.generation !== binding.generation))) return;
    if (stage === "begin") {
      const context = makeDiagnosticContext(binding, "wrapper", inherited!);
      const environment: DiagnosticEnvironmentContext = {
        ...inherited!, workflow_id: inherited!.workflow_id ?? context.invocation_id,
      };
      state = {
        version: 1, activity: value as "kv" | "sql", source_id: binding.source_id,
        generation: binding.generation, wrapper_id: context.invocation_id, started_ns: now.toString(), context: environment,
      };
      expected = 1;
      if (runtime.emit({ type: "invocation.start", activity: state.activity, business: "not_applicable" }, {
        ...context, workflow_id: environment.workflow_id,
      })) output = JSON.stringify(state);
    } else {
      const current = state!;
      const context = makeDiagnosticContext(binding, "wrapper", { ...current.context, invocation_id: current.wrapper_id });
      if (stage === "child") {
        const attempt = diagnosticId();
        const ordinal = Number(value);
        // Start the measured child interval after discovery, immediately before its observation.
        state = { ...current, ordinal, attempt_id: attempt, attempt_started_ns: process.hrtime.bigint().toString() };
        expected = 1;
        if (runtime.emit({ type: "attempt.start", activity: current.activity, layer: "wrapper_child", ordinal,
          attempt_id: attempt, parent_id: current.wrapper_id }, context)) {
          const environment = encodeDiagnosticContext({ ...current.context, wrapper_id: current.wrapper_id,
            child_ordinal: ordinal, parent_id: attempt });
          if (environment) output = `${JSON.stringify(state)}\n${environment}`;
        }
      } else {
        const code = Number(exitCode);
        const accepted = runtime.emit({ type: "attempt.finish", activity: current.activity, layer: "wrapper_child",
          attempt_id: current.attempt_id, parent_id: current.wrapper_id, ordinal: current.ordinal,
          exit_code: code, outcome: code === 0 ? "complete" : "error", timing_scope: "wrapper_child",
          duration_ms: Number(now - BigInt(current.attempt_started_ns!)) / 1_000_000,
        }, context);
        expected = 2;
        if (decision === "retry") {
          const scheduled = runtime.emit({ type: "retry.scheduled", activity: current.activity, layer: "wrapper_child",
            attempt_id: current.attempt_id, parent_id: current.wrapper_id, ordinal: current.ordinal,
            delay_ms: current.ordinal! * 2000, outcome: "pending",
          }, context);
          if (accepted && scheduled) {
            const { attempt_id: _attempt, attempt_started_ns: _started, ...next } = current;
            output = JSON.stringify(next);
          }
        } else {
          runtime.emit({ type: "invocation.finish", activity: current.activity, exit_code: code, business: "not_applicable",
            timing_scope: "invocation", duration_ms: Number(now - BigInt(current.started_ns)) / 1_000_000,
          }, context);
        }
      }
    }
  } catch { /* No diagnostic exception or input is forwarded to wrapper business streams. */ }
  finally {
    try {
      const drain = runtime?.drainSync();
      if (output && Buffer.byteLength(output) <= MAX_STATE_BYTES + 2048 + 1
        && drain?.acknowledged === expected && drain.pending === 0 && drain.dropped === 0) process.stdout.write(`${output}\n`);
    } catch { /* A missing receipt leaves ordinary CLI execution unchanged. */ }
  }
}
