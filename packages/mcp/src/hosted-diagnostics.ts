import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createDiagnosticRuntime,
  diagnosticId,
  emitDiagnostic,
  makeDiagnosticContext,
  withDiagnosticContext,
  type DiagnosticContext,
  type DiagnosticObservation,
  type DiagnosticRuntime,
} from "@tinycloud/operations/diagnostics";

import { MCP_VERSION } from "./version.js";

export interface HostedDiagnosticConfig {
  /** Explicit, separate private root. No environment or credential-state fallback. */
  readonly root: string;
  /** Pre-verification service observations additionally require this flag and service policy enablement. */
  readonly service?: boolean;
}
interface HttpExchange {
  readonly invocationId: string;
  readonly startedAt: number;
  context?: DiagnosticContext;
  factoryEntered: boolean;
}
const exchanges = new AsyncLocalStorage<HttpExchange>();

/** One runtime per application lifetime, shared by all per-request server factories. */
export class HostedDiagnostics {
  readonly #config: HostedDiagnosticConfig;
  readonly #runtime: DiagnosticRuntime;
  constructor(config: HostedDiagnosticConfig, stateRoot?: string) {
    this.#config = config;
    this.#runtime = createDiagnosticRuntime({
      root: config.root,
      separateFrom: stateRoot,
      source: "mcp_http",
      hosted: true,
      descriptor: { descriptor_id: diagnosticId(), source: "mcp_http", package: "@tinycloud/mcp", version: MCP_VERSION },
    });
    // Explicit process configuration also maintains expired idle history after
    // restart; maintenance does not enable any tenant or create capture events.
    void this.#runtime.startMaintenance().catch(() => {});
  }
  async exchange<T>(action: () => Promise<T>, response?: ServerResponse): Promise<T> {
    if (exchanges.getStore() !== undefined) return action();
    const exchange: HttpExchange = { invocationId: diagnosticId(), startedAt: performance.now(), factoryEntered: false };
    // Register on the real response BEFORE adapter conversion, body streaming or fetch.
    if (response !== undefined) {
      let finished = false;
      const observe = (delivery: "finish" | "close_before_finish" | "error") => {
        withDiagnosticContext(exchange.context, () => emitDiagnostic({
          type: "delivery.outcome", delivery, status: response.statusCode,
          duration_ms: performance.now() - exchange.startedAt, timing_scope: "http_exchange",
        }));
      };
      response.once("finish", () => { finished = true; observe("finish"); });
      response.once("close", () => { if (!finished) observe("close_before_finish"); });
      response.once("error", () => observe("error"));
    }
    if (this.#config.service === true) {
      const binding = await this.#runtime.bindingForTenant("service").catch(() => undefined);
      if (binding !== undefined) exchange.context = makeDiagnosticContext(binding, "mcp_http", { invocation_id: exchange.invocationId });
    }
    return exchanges.run(exchange, () => withDiagnosticContext(exchange.context, action));
  }
  async tenant<T>(verifiedTenantId: string, action: () => Promise<T>, admitted = false): Promise<T> {
    const exchange = exchanges.getStore();
    const binding = admitted ? await this.#runtime.bindingForTenant(verifiedTenantId).catch(() => undefined) : undefined;
    const context = binding === undefined ? undefined : makeDiagnosticContext(binding, "mcp_http", {
      invocation_id: exchange?.invocationId,
      scope: "tc-apps",
    });
    // Remove the service binding even if tenant capture is disabled: verified work
    // must never spill into a service or different tenant partition.
    if (exchange !== undefined) exchange.context = context;
    return withDiagnosticContext(context, action);
  }
  /** Outer catches must use the selected exchange, never a restored service scope. */
  emit(observation: DiagnosticObservation): void {
    withDiagnosticContext(exchanges.getStore()?.context, () => emitDiagnostic(observation));
  }
  factoryEntered(): void {
    const exchange = exchanges.getStore();
    if (exchange !== undefined) exchange.factoryEntered = true;
  }
  async response(action: () => Promise<Response>, mcpAdmission = false): Promise<Response> {
    const response = await action();
    const exchange = exchanges.getStore();
    withDiagnosticContext(exchange?.context, () => emitDiagnostic({
      type: "phase.finish", phase: "http_gate", activity: "http", status: response.status,
      outcome: response.status >= 400 ? "refused" : "complete",
    }));
    // Only MCP admission refusals have this protocol meaning. Callback failures
    // can follow verification/import/commit and remain separate HTTP outcomes.
    if (mcpAdmission && response.status >= 400 && exchange?.factoryEntered !== true) {
      withDiagnosticContext(exchange?.context, () => emitDiagnostic({ type: "protocol.outcome", protocol: "before_executor_refusal" }));
    }
    return response;
  }
  close(): Promise<void> { return this.#runtime.close().catch(() => {}); }
}

/** The ordinary Node adapter and its streaming/backpressure behavior remain intact. */
export function createHostedNodeHandler(app: { fetch(request: Request): Promise<Response>; diagnostics?: HostedDiagnostics }) {
  const adapter = toNodeHandler(app, {
    onerror: () => {
      withDiagnosticContext(exchanges.getStore()?.context, () => emitDiagnostic({ type: "delivery.outcome", delivery: "error" }));
    },
  });
  return (request: IncomingMessage, response: ServerResponse): Promise<void> => app.diagnostics === undefined
    ? adapter(request, response)
    : app.diagnostics.exchange(() => adapter(request, response), response);
}
