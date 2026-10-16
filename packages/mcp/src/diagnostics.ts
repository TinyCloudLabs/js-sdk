import { AsyncLocalStorage } from "node:async_hooks";

import { McpServer } from "@modelcontextprotocol/server";
import type { JSONRPCMessage, ServerContext, StandardSchemaV1, StandardSchemaWithJSON, Transport, TransportSendOptions } from "@modelcontextprotocol/server";
import {
  beginDiagnosticPhase,
  diagnosticId,
  emitDiagnostic,
  getDiagnosticContext,
  makeDiagnosticContext,
  withDiagnosticContext,
  type DiagnosticFields,
  type DiagnosticContext,
  type DiagnosticRole,
} from "@tinycloud/operations/diagnostics";

interface RequestObservation {
  readonly context: DiagnosticContext;
  readonly startedAt: number;
  executor: boolean;
  executorFailed?: boolean;
  resultIsError?: boolean;
}
const requests = new AsyncLocalStorage<RequestObservation>();

/** Only public SDK surfaces are composed. Inbound dispatch always remains synchronous. */
export class DiagnosticMcpServer extends McpServer {
  /** Stdio discovers once before connecting, then refreshes without delaying messages. */
  stdioDiagnosticContext?: () => Promise<DiagnosticContext | undefined>;
  override async connect(transport: Transport): Promise<void> {
    const discover = this.stdioDiagnosticContext;
    let initial: DiagnosticContext | undefined;
    if (discover !== undefined) {
      try { initial = await discover(); } catch { /* Capture never prevents connection. */ }
    }
    return super.connect(new DiagnosticTransport(transport, discover, initial));
  }
}

class DiagnosticTransport implements Transport {
  readonly #inner: Transport;
  #pending?: Map<string | number, RequestObservation>;
  #onmessage: Transport["onmessage"];
  readonly #discover?: () => Promise<DiagnosticContext | undefined>;
  #stdioContext?: DiagnosticContext;
  #refreshing = false;
  #closed = false;
  #received = false;
  #trackingDisabled = false;

  constructor(inner: Transport, discover?: () => Promise<DiagnosticContext | undefined>, initial?: DiagnosticContext) {
    this.#inner = inner;
    this.#onmessage = inner.onmessage;
    this.#discover = discover;
    this.#stdioContext = initial;
  }

  get onmessage(): Transport["onmessage"] { return this.#onmessage; }
  set onmessage(callback: Transport["onmessage"]) {
    this.#onmessage = callback;
    if (callback === undefined) {
      this.#inner.onmessage = undefined;
      return;
    }
    const observe = (message: JSONRPCMessage, extra: Parameters<NonNullable<Transport["onmessage"]>>[1], parent: DiagnosticContext | undefined) => {
      if ("method" in message && message.method === "notifications/cancelled" && !("id" in message)) {
        const requestId = message.params?.requestId;
        if (typeof requestId === "string" || typeof requestId === "number") this.#pending?.delete(requestId);
        // The SDK suppresses cancelled replies. Retire correlation now, but
        // preserve its synchronous notification dispatch and cancellation order.
        callback(message, extra);
        return;
      }
      if (parent === undefined || !("method" in message) || !("id" in message)) {
        callback(message, extra);
        return;
      }
      if (this.#trackingDisabled || (typeof message.id !== "number" && typeof message.id !== "string")
        || (typeof message.id === "string" && message.id.length > 256)
        || (typeof message.id === "number" && !Number.isFinite(message.id))) {
        withDiagnosticContext(undefined, () => callback(message, extra));
        return;
      }
      // IDs from the peer exist only in this bounded, transport-local correlation map.
      // They are never event fields; different HTTP exchanges never share the map.
      const pending = this.#pending ??= new Map<string | number, RequestObservation>();
      const previous = pending.get(message.id);
      if (previous !== undefined || pending.size >= 128) {
        // A reused in-flight ID cannot identify either response. Stop tracking
        // this transport instead of assigning an earlier result to a later call.
        this.#trackingDisabled = true;
        pending.clear();
        withDiagnosticContext(previous?.context ?? parent, () => emitDiagnostic({
          type: "capture.health", failure: previous === undefined ? "queue_full" : "invalid_context", outcome: "dropped",
        }));
        withDiagnosticContext(undefined, () => callback(message, extra));
        return;
      }
      const context = parent.source === "mcp_http" && !this.#received
        ? parent
        : makeDiagnosticContext(parent.binding, parent.source, {
          parent_id: parent.parent_id, run_id: parent.run_id, turn_id: parent.turn_id,
          task_id: parent.task_id, workflow_id: parent.workflow_id, role: parent.role, role_provenance: parent.role_provenance,
        });
      this.#received = true;
      const observation: RequestObservation = { context, startedAt: performance.now(), executor: false };
      pending.set(message.id, observation);
      withDiagnosticContext(context, () => requests.run(observation, () => {
        emitDiagnostic({ type: "invocation.start", activity: "mcp_request" });
        // MUST remain synchronous: the modern transport's refusal HTTP status is
        // chosen while its onmessage dispatch window is still open.
        callback(message, extra);
      }));
    };
    const discover = this.#discover;
    if (discover === undefined) {
      this.#inner.onmessage = (message, extra) => observe(message, extra, getDiagnosticContext());
    } else {
      this.#inner.onmessage = (message, extra) => {
        // Snapshot before refreshing. Neither policy discovery nor another tool
        // can queue this payload or delay cancellation. A transition racing this
        // snapshot can lose evidence; only future invocations use the new binding.
        const parent = this.#stdioContext;
        if ("method" in message && "id" in message && !this.#refreshing && !this.#closed) {
          this.#refreshing = true;
          try {
            void discover().then(
              (context) => {
                if (!this.#closed) this.#stdioContext = context;
                this.#refreshing = false;
              },
              () => { this.#stdioContext = undefined; this.#refreshing = false; },
            );
          } catch { this.#stdioContext = undefined; this.#refreshing = false; }
        }
        withDiagnosticContext(parent, () => observe(message, extra, parent));
      };
    }
  }
  get onclose(): Transport["onclose"] { return this.#inner.onclose; }
  set onclose(callback: Transport["onclose"]) { this.#inner.onclose = callback; }
  get onerror(): Transport["onerror"] { return this.#inner.onerror; }
  set onerror(callback: Transport["onerror"]) { this.#inner.onerror = callback; }
  get sessionId(): string | undefined { return this.#inner.sessionId; }
  set sessionId(value: string | undefined) { this.#inner.sessionId = value; }
  get hasPerRequestStream(): boolean | undefined { return this.#inner.hasPerRequestStream; }
  get setProtocolVersion(): Transport["setProtocolVersion"] {
    return this.#inner.setProtocolVersion?.bind(this.#inner);
  }
  get setSupportedProtocolVersions(): Transport["setSupportedProtocolVersions"] {
    return this.#inner.setSupportedProtocolVersions?.bind(this.#inner);
  }
  start(): Promise<void> { return this.#inner.start(); }
  close(): Promise<void> {
    this.#closed = true;
    this.#stdioContext = undefined;
    // A normal per-request close is NOT evidence of a client disconnect.
    this.#pending?.clear();
    return this.#inner.close();
  }
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if ("method" in message || !("id" in message) || message.id === null || message.id === undefined) return this.#inner.send(message, options);
    const id = message.id;
    const observation = this.#pending?.get(id);
    // Async dispatch retains the admitting observation. A cancelled request's
    // late send must never consume a newer request's reused peer ID.
    if (observation === undefined || observation !== requests.getStore()) return this.#inner.send(message, options);
    const protocol = "error" in message
      ? observation.executor ? "post_executor_protocol_failure" : "before_executor_refusal"
      : "result" in message && message.result.isError === true
        ? !observation.executor ? "before_executor_refusal"
          : observation.executorFailed === true || observation.resultIsError === true ? "tool_error" : "post_executor_protocol_failure"
        : "result";
    withDiagnosticContext(observation.context, () => {
      emitDiagnostic({ type: "protocol.outcome", protocol });
      emitDiagnostic({ type: "invocation.finish", activity: "mcp_request", duration_ms: performance.now() - observation.startedAt, timing_scope: "handler", business: "unknown" });
    });
    this.#pending?.delete(id);
    // Forward before registering settlement observers, without await or a microtask.
    // Return the original promise and preserve synchronous throws.
    let sent: Promise<void>;
    try {
      sent = this.#inner.send(message, options);
    } catch (error) {
      withDiagnosticContext(observation.context, () => emitDiagnostic({ type: "protocol.outcome", protocol: "send_failed" }));
      throw error;
    }
    void sent.then(
      () => withDiagnosticContext(observation.context, () => emitDiagnostic({ type: "protocol.outcome", protocol: "send_finished" })),
      () => withDiagnosticContext(observation.context, () => emitDiagnostic({ type: "protocol.outcome", protocol: "send_failed" })),
    );
    return sent;
  }
}

/** Retain the public JSON Schema functions and invoke the original validator once. */
export function diagnosticSchema<Input, Output>(schema: StandardSchemaWithJSON<Input, Output>, phase: "input_validation" | "output_validation"): StandardSchemaWithJSON<Input, Output> {
  const standard = schema["~standard"];
  return {
    ...schema,
    "~standard": {
      ...standard,
      validate(value: unknown, options?: StandardSchemaV1.Options) {
        const current = getDiagnosticContext();
        const operationId = current === undefined ? undefined : diagnosticId();
        return withDiagnosticContext(current === undefined ? undefined : {
          ...current, operation_id: operationId, parent_id: current.operation_id ?? current.invocation_id,
        }, () => {
          const finish = beginDiagnosticPhase(phase, { operation_id: operationId });
          try {
            const result = standard.validate(value, options);
            if (result instanceof Promise) {
              void result.then(
                (validated) => finish({ outcome: validated.issues === undefined ? "pass" : "fail" }),
                () => finish({ outcome: "fail" }),
              );
            } else {
              finish({ outcome: result.issues === undefined ? "pass" : "fail" });
            }
            return result;
          } catch (error) {
            finish({ outcome: "fail" });
            throw error;
          }
        });
      },
    },
  };
}

/** Only a fixed scalar role hint is supported; client IDs and all raw metadata are ignored. */
export function diagnosticExecutor<T>(activity: DiagnosticFields["activity"], context: ServerContext, action: () => Promise<T>): Promise<T> {
  const current = getDiagnosticContext();
  if (current === undefined) return action();
  const observation = requests.getStore();
  if (observation !== undefined) observation.executor = true;
  const hint = context.mcpReq._meta?.["xyz.tinycloud/diagnostic-role"];
  const role = typeof hint === "string" && Object.hasOwn(ROLES, hint) ? hint as DiagnosticRole : undefined;
  const operationId = diagnosticId();
  return withDiagnosticContext({
    ...current, operation_id: operationId, parent_id: current.operation_id ?? current.invocation_id,
    ...(role === undefined ? {} : { role, role_provenance: "client_reported" as const }),
  }, async () => {
    const finish = beginDiagnosticPhase("executor", { activity, operation_id: operationId, ...(role === undefined ? {} : { role_provenance: "client_reported" }) });
    try {
      const result = await action();
      if (observation !== undefined) {
        observation.resultIsError = typeof result === "object" && result !== null && "isError" in result && result.isError === true;
      }
      finish({ outcome: "complete" });
      return result;
    } catch (error) {
      if (observation !== undefined) observation.executorFailed = true;
      finish({ outcome: "error" });
      throw error;
    }
  });
}

const ROLES: Readonly<Record<string, true>> = { catalog: true, record: true, verification: true, copy: true, approval: true, context: true, unknown: true };
