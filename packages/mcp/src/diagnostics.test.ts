import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createMcpHandler, fromJsonSchema, InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import {
  createDiagnosticRuntime, DiagnosticStore, getDiagnosticContext, makeDiagnosticContext, withDiagnosticContext,
  type DiagnosticBinding, type DiagnosticContext, type DiagnosticObservation,
} from "@tinycloud/operations/diagnostics";

import { DiagnosticMcpServer, diagnosticExecutor, diagnosticSchema } from "./diagnostics.js";
import { createJsonSchemaValidator, registerTinyCloudTools } from "./tools.js";
import { toMcpToolResult } from "./results.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

/** The transport registers its settlement reaction synchronously during dispatch.
 * Resolving this exact promise, then awaiting it, is a deterministic admission barrier. */
function controlledDiscovery(server: DiagnosticMcpServer, discover: () => Promise<DiagnosticContext | undefined>) {
  let pending: PromiseWithResolvers<DiagnosticContext | undefined> | undefined;
  let probes = 0;
  server.stdioDiagnosticContext = () => {
    probes++;
    pending = Promise.withResolvers<DiagnosticContext | undefined>();
    return pending.promise;
  };
  return {
    get probes() { return probes; },
    async settle() {
      if (pending === undefined) throw new Error("No diagnostic discovery was dispatched");
      const current = pending;
      current.resolve(await discover());
      await current.promise;
    },
  };
}

async function primeDiagnostics(peer: InMemoryTransport, discovery: { settle(): Promise<void> }): Promise<void> {
  const receive = peer.onmessage;
  const response = Promise.withResolvers<void>();
  peer.onmessage = (message, extra) => {
    if ("id" in message && message.id === 0) response.resolve();
    else receive?.(message, extra);
  };
  // An unregistered apps method discovers policy without running fixture business.
  await peer.send({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "tinycloud_apps_context", arguments: {} } });
  await response.promise;
  await discovery.settle();
  peer.onmessage = receive;
}

for (const modern of [false, true]) {
  test(`registered ${modern ? "modern" : "legacy"} requests preserve refusals with capture on, off and unavailable`, async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-protocol-diagnostics-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = new DiagnosticStore(join(root, "history"));
    await store.control("enable", { scope: "tc-apps" });
    const runtime = createDiagnosticRuntime({ root: join(root, "history"), source: "mcp_http" });
    cleanup.push(() => runtime.close());
    const binding = await runtime.binding();
    expect(binding).toBeDefined();
    await writeFile(join(root, "not-a-directory"), "synthetic");
    const unavailable = createDiagnosticRuntime({ root: join(root, "not-a-directory"), source: "mcp_http" });
    cleanup.push(() => unavailable.close());
    const missing = await unavailable.binding();
    expect(missing).toBeUndefined();

    let syntheticOutput = false;
    const handler = createMcpHandler(() => {
      const validator = createJsonSchemaValidator();
      const server = new DiagnosticMcpServer({ name: "synthetic-diagnostics", version: "1.0.0" }, { jsonSchemaValidator: validator });
      for (const name of syntheticOutput ? ["tinycloud_apps_read", "tinycloud_apps_query"] : []) {
        server.registerTool(name, {
          inputSchema: diagnosticSchema(fromJsonSchema({ type: "object", properties: { kind: { type: "string" } }, required: ["kind"], additionalProperties: false }, validator), "input_validation"),
          outputSchema: diagnosticSchema(fromJsonSchema({ type: "object", properties: { status: { type: "string" } }, required: ["status"] }, validator), "output_validation"),
        }, (input, context) => diagnosticExecutor("apps_read", context, async () => {
          const kind = typeof input === "object" && input !== null && "kind" in input ? input.kind : undefined;
          if (kind === "missing_output") return { content: [{ type: "text" as const, text: "synthetic missing output" }] };
          if (kind === "invalid_output") return { content: [], structuredContent: { invalid: true } };
          return toMcpToolResult({ status: "ok", output: { value: "PRIVATE_CONTENT_CANARY".repeat(6000) } }, [], {
            surface: "hosted", readOnly: kind === "oversize_read", operationId: "tinycloud.kv.get",
          });
        }));
      }
      if (!syntheticOutput) registerTinyCloudTools(server, {
        surface: "hosted", profile: "agent", explicitProfile: true, allowOwnerProfile: false, stateRoot: join(root, "tenant"),
      }, validator);
      return server;
    }, { legacy: "stateless", onerror: () => {} });
    cleanup.push(() => handler.close());

    const invoke = async (method: string, params: Record<string, unknown>, scope?: DiagnosticBinding) => {
      syntheticOutput = typeof params.arguments === "object" && params.arguments !== null && "kind" in params.arguments;
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      headers["mcp-protocol-version"] = modern ? "2026-07-28" : "2025-11-25";
      if (modern) {
        headers["mcp-method"] = method;
        if (typeof params.name === "string") headers["mcp-name"] = params.name;
      }
      const body = { jsonrpc: "2.0", id: "REUSED_PRIVATE_REQUEST_ID", method, params: modern ? {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "synthetic", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      } : params };
      const response = await withDiagnosticContext(scope === undefined ? undefined : makeDiagnosticContext(scope, "mcp_http"),
        () => handler.fetch(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) })));
      const text = await response.text();
      const messages = response.headers.get("content-type")?.includes("text/event-stream")
        ? text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
        : JSON.parse(text);
      return { status: response.status, messages };
    };

    const cases: Array<[string, Record<string, unknown>]> = [
      ["PRIVATE_UNKNOWN_METHOD", {}],
      ["tools/call", { name: "PRIVATE_UNKNOWN_TOOL", arguments: {} }],
      ["tools/call", { name: "tinycloud_apps_write", arguments: { ops: "PRIVATE_INVALID_INPUT" } }],
      ["tools/call", { name: "tinycloud_apps_context", arguments: {} }],
      ["tools/call", { name: "tinycloud_apps_read", arguments: { kind: "invalid_output" } }],
      ["tools/call", { name: "tinycloud_apps_read", arguments: { kind: "missing_output" } }],
      ["tools/call", { name: "tinycloud_apps_query", arguments: { kind: "oversize_read" } }],
      ["tools/call", { name: "tinycloud_apps_query", arguments: { kind: "oversize_write" } }],
    ];
    for (const [method, params] of cases) {
      const baseline = await invoke(method, params);
      const captured = await invoke(method, params, binding);
      expect(captured).toEqual(baseline);
      expect(await invoke(method, params, missing)).toEqual(baseline);
      if (modern && method === "PRIVATE_UNKNOWN_METHOD") expect(captured.status).toBe(404);
    }
    await handler.close();
    await runtime.close();
    const snapshot = await store.snapshot({ all: true });
    expect(snapshot.events.filter((event) => event.protocol === "before_executor_refusal")).toHaveLength(1);
    expect(snapshot.events.filter((event) => event.protocol === "post_executor_protocol_failure")).toHaveLength(2);
    const converted = snapshot.events.filter((event) => event.outcome === "converted");
    expect(converted).toHaveLength(1);
    expect(snapshot.events.some((event) => event.invocation_id === converted[0]!.invocation_id && event.canonical_status === "ok")).toBe(true);
    expect(snapshot.events.some((event) => event.canonical_status === "error")).toBe(true);
    expect(snapshot.events.filter((event) => event.type === "invocation.start")).toHaveLength(6);
    expect(new Set(snapshot.events.filter((event) => event.type === "invocation.start").map((event) => event.invocation_id)).size).toBe(6);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
  }, 30_000);
}

test("overlapping peer request IDs cannot attribute one tool's result to another invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-duplicate-diagnostic-id-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  await store.control("enable", { scope: "tc-apps" });
  const runtime = createDiagnosticRuntime({ root, source: "mcp_stdio" });
  cleanup.push(() => runtime.close());
  const binding = await runtime.binding();
  expect(binding).toBeDefined();
  const validator = createJsonSchemaValidator();
  const server = new DiagnosticMcpServer({ name: "synthetic-overlap", version: "1.0.0" }, { jsonSchemaValidator: validator });
  const discovery = controlledDiscovery(server, async () => makeDiagnosticContext(binding!, "mcp_stdio"));
  let release!: () => void;
  let entered!: () => void;
  let delivered!: () => void;
  let calls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const bothEntered = new Promise<void>((resolve) => { entered = resolve; });
  const bothDelivered = new Promise<void>((resolve) => { delivered = resolve; });
  for (const name of ["tinycloud_apps_read", "tinycloud_apps_write"]) {
    server.registerTool(name, {
      inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator),
    }, (_input, context) => diagnosticExecutor("unknown", context, async () => {
      if (++calls === 2) entered();
      await gate;
      return { isError: name === "tinycloud_apps_read", content: [{ type: "text" as const, text: "PRIVATE_DUPLICATE_RESPONSE" }] };
    }));
  }
  const [peer, transport] = InMemoryTransport.createLinkedPair();
  const responses: JSONRPCMessage[] = [];
  peer.onmessage = (message) => {
    responses.push(message);
    if (responses.length === 2) delivered();
  };
  await peer.start();
  await server.connect(transport);
  await primeDiagnostics(peer, discovery);
  cleanup.push(() => server.close(), () => peer.close());
  await peer.send({ jsonrpc: "2.0", id: "PRIVATE_OVERLAPPING_ID", method: "tools/call", params: { name: "tinycloud_apps_read", arguments: {} } });
  await peer.send({ jsonrpc: "2.0", id: "PRIVATE_OVERLAPPING_ID", method: "tools/call", params: { name: "tinycloud_apps_write", arguments: {} } });
  await bothEntered;
  release();
  await bothDelivered;
  expect(responses.filter((message) => "result" in message && message.result.isError === true)).toHaveLength(1);
  expect(responses.filter((message) => "result" in message && message.result.isError === false)).toHaveLength(1);
  await runtime.close();
  const snapshot = await store.snapshot({ all: true });
  expect(snapshot.events.filter((event) => event.type === "invocation.start")).toHaveLength(1);
  expect(snapshot.events.filter((event) => event.type === "invocation.finish")).toEqual([]);
  expect(snapshot.events.some((event) => event.type === "capture.health" && event.failure === "invalid_context")).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
}, 30_000);

test("stdio refresh fences queued and in-flight work while later invocations use new policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-stdio-generation-fence-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  await store.control("enable", { scope: "tc-apps" });
  const runtime = createDiagnosticRuntime({ root, source: "mcp_stdio" });
  cleanup.push(() => runtime.close());
  const initial = await runtime.binding();
  expect(initial).toBeDefined();
  const validator = createJsonSchemaValidator();
  const server = new DiagnosticMcpServer({ name: "synthetic-stdio-fence", version: "1.0.0" }, { jsonSchemaValidator: validator });
  const firstEntered = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let admission = makeDiagnosticContext(initial!, "mcp_stdio");
  const discovery = controlledDiscovery(server, async () => admission);
  const seen: Array<DiagnosticContext | undefined> = [];
  server.registerTool("tinycloud_apps_write", {
    inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator),
  }, (_input, context) => diagnosticExecutor("unknown", context, async () => {
    seen.push(getDiagnosticContext());
    if (seen.length === 1) firstEntered.resolve();
    else if (seen.length === 2) secondEntered.resolve();
    // Both admitted requests retain their context while business work is queued.
    if (seen.length <= 2) await releaseFirst.promise;
    return { content: [{ type: "text" as const, text: "synthetic complete" }] };
  }));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const responses = [Promise.withResolvers<JSONRPCMessage>(), Promise.withResolvers<JSONRPCMessage>(), Promise.withResolvers<JSONRPCMessage>()];
  let buffered = "";
  stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
      const message = JSON.parse(buffered.slice(0, newline)) as JSONRPCMessage;
      buffered = buffered.slice(newline + 1);
      if ("id" in message && typeof message.id === "number") responses[message.id - 1]?.resolve(message);
    }
  });
  await server.connect(new StdioServerTransport(stdin, stdout));
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "tinycloud_apps_context", arguments: {} } }) + "\n");
  await discovery.settle();
  cleanup.push(() => server.close());
  const invoke = (id: number) => {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "tinycloud_apps_write", arguments: {} } }) + "\n");
  };
  try {
    invoke(1);
    await firstEntered.promise;
    invoke(2);
    await secondEntered.promise;
    expect(discovery.probes).toBe(2);
    await store.delete({ all: true }, { pause_after: false });
    // The discovery begun before deletion settles with an old immutable binding.
    await discovery.settle();
    const freshBinding = await runtime.binding();
    expect(freshBinding).toBeDefined();
    admission = makeDiagnosticContext(freshBinding!, "mcp_stdio");
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tinycloud_apps_context", arguments: {} } }) + "\n");
    await discovery.settle();
    releaseFirst.resolve();
    await Promise.all([responses[0]!.promise, responses[1]!.promise]);
    invoke(3);
    const fresh = await responses[2]!.promise;
    expect(fresh).toMatchObject({ result: { content: [{ type: "text", text: "synthetic complete" }] } });
    expect(seen[0]?.binding.generation).toBe(initial!.generation);
    expect(seen[1]?.binding.generation).toBe(initial!.generation);
    expect(seen[2]?.binding.generation).toBeGreaterThan(initial!.generation);
    await runtime.close();
    const snapshot = await store.snapshot({ all: true });
    expect(snapshot.events.some((event) => event.type === "invocation.finish" && event.invocation_id === seen[2]?.invocation_id)).toBe(true);
    expect(snapshot.events.every((event) => event.invocation_id !== seen[0]?.invocation_id && event.invocation_id !== seen[1]?.invocation_id)).toBe(true);
  } finally {
    releaseFirst.resolve();
  }
}, 30_000);

test("stdio cancellation bypasses pending diagnostic discovery before a mutation", async () => {
  const validator = createJsonSchemaValidator();
  const server = new DiagnosticMcpServer({ name: "synthetic-stdio-cancel", version: "1.0.0" }, { jsonSchemaValidator: validator });
  const discovery = Promise.withResolvers<DiagnosticContext | undefined>();
  const discoveryStarted = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<AbortSignal>();
  const mutate = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let mutations = 0;
  server.stdioDiagnosticContext = () => {
    discoveryStarted.resolve();
    return discovery.promise;
  };
  server.registerTool("tinycloud_apps_write", {
    inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator),
  }, async (_input, context) => {
    entered.resolve(context.mcpReq.signal);
    await mutate.promise;
    if (!context.mcpReq.signal.aborted) mutations++;
    completed.resolve();
    return { content: [] };
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.resume();
  await server.connect(new StdioServerTransport(stdin, stdout));
  cleanup.push(() => server.close());
  const send = (message: JSONRPCMessage) => { stdin.write(JSON.stringify(message) + "\n"); };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tinycloud_apps_write", arguments: {} } });
    const signal = await entered.promise;
    await discoveryStarted.promise;
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    expect(signal.aborted).toBe(true);
    mutate.resolve();
    await completed.promise;
    expect(mutations).toBe(0);
  } finally {
    discovery.resolve(undefined);
    mutate.resolve();
    await completed.promise;
  }
});

for (const reuse of [false, true]) {
  test(`cancelled diagnostic requests retire before ${reuse ? "ID reuse" : "capacity exhaustion"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-cancel-retirement-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const store = new DiagnosticStore(root);
    await store.control("enable", { scope: "tc-apps" });
    const runtime = createDiagnosticRuntime({ root, source: "mcp_stdio" });
    cleanup.push(() => runtime.close());
    const binding = await runtime.binding();
    expect(binding).toBeDefined();
    // This regression targets the transport's 128-request correlation bound,
    // not the independent native writer queue. Observe its sink synchronously.
    const events: Array<DiagnosticObservation & { invocation_id: string }> = [];
    const sink = spyOn(runtime, "emit").mockImplementation((event, context) => {
      events.push({ ...event, invocation_id: context.invocation_id });
      return true;
    });
    cleanup.push(async () => { sink.mockRestore(); });
    const validator = createJsonSchemaValidator();
    const server = new DiagnosticMcpServer({ name: "synthetic-cancellation", version: "1.0.0" }, { jsonSchemaValidator: validator });
    const discovery = controlledDiscovery(server, async () => makeDiagnosticContext(binding!, "mcp_stdio"));
    let entered = Promise.withResolvers<AbortSignal>();
    let release = Promise.withResolvers<void>();
    let completed = Promise.withResolvers<void>();
    server.registerTool("tinycloud_apps_write", {
      inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator),
    }, (_input, context) => {
      const done = completed;
      const execution = diagnosticExecutor("unknown", context, async () => {
        entered.resolve(context.mcpReq.signal);
        await release.promise;
        return { isError: true, content: [{ type: "text" as const, text: "PRIVATE_CANCELLED_RESULT" }] };
      });
      void execution.then(() => done.resolve(), () => done.resolve());
      return execution;
    });
    server.registerTool("tinycloud_apps_read", {
      inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator),
    }, () => ({ content: [] }));
    const [peer, transport] = InMemoryTransport.createLinkedPair();
    const delivered = Promise.withResolvers<JSONRPCMessage>();
    const responses: JSONRPCMessage[] = [];
    peer.onmessage = (message) => { responses.push(message); delivered.resolve(message); };
    await peer.start();
    await server.connect(transport);
    await primeDiagnostics(peer, discovery);
    cleanup.push(() => server.close(), () => peer.close());
    try {
      const count = reuse ? 1 : 128;
      for (let index = 1; index <= count; index++) {
        entered = Promise.withResolvers<AbortSignal>();
        release = Promise.withResolvers<void>();
        completed = Promise.withResolvers<void>();
        await peer.send({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name: "tinycloud_apps_write", arguments: {} } });
        const signal = await entered.promise;
        await peer.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: index } });
        if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        expect(signal.aborted).toBe(true);
        if (!reuse) {
          release.resolve();
          await completed.promise;
        }
      }
      await peer.send({ jsonrpc: "2.0", id: reuse ? 1 : 129, method: "tools/call", params: { name: "tinycloud_apps_read", arguments: {} } });
      expect(await delivered.promise).toHaveProperty("result.content");
      release.resolve();
      await completed.promise;
      await runtime.close();
      expect(responses).toHaveLength(1);
      const snapshot = { events };
      expect(snapshot.events.filter((event) => event.failure === "invalid_context" || event.failure === "queue_full")).toEqual([]);
      expect(snapshot.events.filter((event) => event.type === "invocation.finish")).toHaveLength(1);
      expect(snapshot.events.filter((event) => event.protocol === "result")).toHaveLength(1);
      expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
    } finally {
      release.resolve();
    }
  }, 30_000);
}

test("executor exceptions remain tool errors rather than output protocol failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-executor-failure-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  await store.control("enable", { scope: "tc-apps" });
  const runtime = createDiagnosticRuntime({ root, source: "mcp_stdio" });
  cleanup.push(() => runtime.close());
  const binding = await runtime.binding();
  expect(binding).toBeDefined();
  const validator = createJsonSchemaValidator();
  const server = new DiagnosticMcpServer({ name: "synthetic-exception", version: "1.0.0" }, { jsonSchemaValidator: validator });
  const discovery = controlledDiscovery(server, async () => makeDiagnosticContext(binding!, "mcp_stdio"));
  server.registerTool("tinycloud_apps_write", {
    inputSchema: diagnosticSchema(fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator), "input_validation"),
  }, (_input, context) => diagnosticExecutor("unknown", context, async () => { throw new Error("PRIVATE_EXECUTOR_FAILURE"); }));
  const [peer, transport] = InMemoryTransport.createLinkedPair();
  const delivered = Promise.withResolvers<JSONRPCMessage>();
  peer.onmessage = delivered.resolve;
  await peer.start();
  await server.connect(transport);
  await primeDiagnostics(peer, discovery);
  cleanup.push(() => server.close(), () => peer.close());
  await peer.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tinycloud_apps_write", arguments: {} } });
  expect(await delivered.promise).toMatchObject({ result: { isError: true } });
  await runtime.close();
  const snapshot = await store.snapshot({ all: true });
  expect(snapshot.events.filter((event) => event.protocol === "tool_error")).toHaveLength(1);
  expect(snapshot.events.filter((event) => event.protocol === "post_executor_protocol_failure")).toEqual([]);
  expect(snapshot.events.some((event) => event.phase === "executor" && event.outcome === "error")).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
}, 30_000);

test("late cancelled sends cannot finish a newer request reusing the peer ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-cancel-late-send-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  await store.control("enable", { scope: "tc-apps" });
  const runtime = createDiagnosticRuntime({ root, source: "mcp_stdio" });
  cleanup.push(() => runtime.close());
  const binding = await runtime.binding();
  expect(binding).toBeDefined();
  const validator = createJsonSchemaValidator();
  const server = new DiagnosticMcpServer({ name: "synthetic-late-send", version: "1.0.0" }, { jsonSchemaValidator: validator });
  const discovery = controlledDiscovery(server, async () => makeDiagnosticContext(binding!, "mcp_stdio"));
  const oldEntered = Promise.withResolvers<AbortSignal>();
  const newEntered = Promise.withResolvers<void>();
  const oldRelease = Promise.withResolvers<void>();
  const newRelease = Promise.withResolvers<void>();
  const oldSent = Promise.withResolvers<void>();
  const newSent = Promise.withResolvers<JSONRPCMessage>();
  const invocations: string[] = [];
  for (const name of ["tinycloud_apps_write", "tinycloud_apps_read"]) {
    server.registerTool(name, {
      inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator),
    }, (_input, context) => diagnosticExecutor("unknown", context, async () => {
      invocations.push(getDiagnosticContext()!.invocation_id);
      if (name === "tinycloud_apps_write") {
        oldEntered.resolve(context.mcpReq.signal);
        await oldRelease.promise;
        // Advanced callers can use the public transport; a late send retains
        // the old async context even though the SDK suppresses its normal reply.
        await server.server.transport!.send({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } });
        oldSent.resolve();
      } else {
        newEntered.resolve();
        await newRelease.promise;
      }
      return { content: [] };
    }));
  }
  const [peer, transport] = InMemoryTransport.createLinkedPair();
  peer.onmessage = (message) => {
    if ("result" in message && message.result.isError !== true) newSent.resolve(message);
  };
  await peer.start();
  await server.connect(transport);
  await primeDiagnostics(peer, discovery);
  cleanup.push(() => server.close(), () => peer.close());
  try {
    await peer.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tinycloud_apps_write", arguments: {} } });
    const signal = await oldEntered.promise;
    await peer.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    expect(signal.aborted).toBe(true);
    await peer.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tinycloud_apps_read", arguments: {} } });
    await newEntered.promise;
    oldRelease.resolve();
    await oldSent.promise;
    newRelease.resolve();
    expect(await newSent.promise).toMatchObject({ id: 1, result: { content: [] } });
    await runtime.close();
    const snapshot = await store.snapshot({ all: true });
    expect(snapshot.events.filter((event) => event.type === "invocation.finish").map((event) => event.invocation_id)).toEqual([invocations[1]!]);
    expect(snapshot.events.filter((event) => event.protocol === "result").map((event) => event.invocation_id)).toEqual([invocations[1]!]);
    expect(snapshot.events.filter((event) => event.protocol === "tool_error" || event.protocol === "post_executor_protocol_failure")).toEqual([]);
  } finally {
    oldRelease.resolve();
    newRelease.resolve();
  }
}, 30_000);

test("concurrent apps and unrelated tools isolate capture even under the same launch scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-concurrent-scope-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(root);
  await store.control("enable", { scope: "tc-apps" });
  const runtime = createDiagnosticRuntime({ root, source: "mcp_stdio" });
  cleanup.push(() => runtime.close());
  const binding = await runtime.binding();
  expect(binding).toBeDefined();
  const parent = makeDiagnosticContext(binding!, "mcp_stdio", { scope: "tc-apps" });
  const validator = createJsonSchemaValidator();
  const server = new DiagnosticMcpServer({ name: "synthetic-isolation", version: "1.0.0" }, { jsonSchemaValidator: validator });
  const discovery = controlledDiscovery(server, async () => parent);
  const bothEntered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: Array<DiagnosticContext | undefined> = [];
  const committed: string[] = [];
  for (const name of ["tinycloud_apps_write", "tinycloud_kv_put"]) {
    server.registerTool(name, {
      inputSchema: diagnosticSchema(fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator), "input_validation"),
    }, (_input, context) => diagnosticExecutor("kv", context, async () => {
      seen.push(getDiagnosticContext());
      if (seen.length === 2) bothEntered.resolve();
      await release.promise;
      committed.push(name);
      return { content: [{ type: "text" as const, text: "synthetic committed" }] };
    }));
  }
  const [peer, transport] = InMemoryTransport.createLinkedPair();
  const responses: JSONRPCMessage[] = [];
  let delivered = Promise.withResolvers<void>();
  peer.onmessage = (message) => {
    responses.push(message);
    if (responses.length === 2) delivered.resolve();
  };
  await peer.start();
  await server.connect(transport);
  cleanup.push(() => server.close(), () => peer.close());
  // Neither tool discovery nor an unrelated tool starts a policy helper.
  await peer.send({ jsonrpc: "2.0", id: -1, method: "tools/list" });
  await withDiagnosticContext(parent, () => peer.send({
    jsonrpc: "2.0", id: -2, method: "tools/call", params: { name: "tinycloud_kv_put", arguments: { invalid: true } },
  }));
  await delivered.promise;
  expect(discovery.probes).toBe(0);
  expect(responses.find((message) => "id" in message && message.id === -1)).toHaveProperty("result.tools");
  const rejected = responses.find((message) => "id" in message && message.id === -2);
  expect(rejected !== undefined && ("error" in rejected || ("result" in rejected && rejected.result.isError === true))).toBe(true);
  expect(committed).toEqual([]);
  responses.length = 0;
  delivered = Promise.withResolvers<void>();
  await primeDiagnostics(peer, discovery);
  try {
    await withDiagnosticContext(parent, () => peer.send({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tinycloud_apps_write", arguments: {} },
    }));
    await withDiagnosticContext(parent, () => peer.send({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tinycloud_kv_put", arguments: {} },
    }));
    await bothEntered.promise;
    expect(seen[0]?.scope).toBe("tc-apps");
    expect(seen[1]).toBeUndefined();
    expect(discovery.probes).toBe(2);
    release.resolve();
    await delivered.promise;
    expect(committed.sort()).toEqual(["tinycloud_apps_write", "tinycloud_kv_put"]);
    for (const response of responses) expect(response).toMatchObject({
      result: { content: [{ type: "text", text: "synthetic committed" }] },
    });
    await runtime.close();
    const snapshot = await store.snapshot({ all: true });
    expect(snapshot.events.filter((event) => event.type === "invocation.start").map((event) => event.invocation_id)).toEqual([seen[0]!.invocation_id]);
    expect(snapshot.events.filter((event) => event.type === "invocation.finish").map((event) => event.invocation_id)).toEqual([seen[0]!.invocation_id]);
    expect(snapshot.events.filter((event) => event.phase === "executor" && event.outcome === "complete")).toHaveLength(1);
  } finally { release.resolve(); }
}, 30_000);

test("registered local KV and SQL tools admit only tc-apps resource boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-local-resource-scope-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new DiagnosticStore(join(root, "history"));
  await store.control("enable", { scope: "tc-apps" });
  const runtime = createDiagnosticRuntime({ root: join(root, "history"), source: "mcp_stdio" });
  cleanup.push(() => runtime.close());
  const binding = await runtime.binding();
  expect(binding).toBeDefined();
  const parent = makeDiagnosticContext(binding!, "mcp_stdio", { scope: "tc-apps" });
  const validator = createJsonSchemaValidator();
  const server = new DiagnosticMcpServer({ name: "local-boundary", version: "1.0.0" }, { jsonSchemaValidator: validator });
  registerTinyCloudTools(server, {
    surface: "local", profile: "missing-synthetic", explicitProfile: true,
    allowOwnerProfile: false, stateRoot: join(root, "profiles"),
  }, validator);
  const [peer, transport] = InMemoryTransport.createLinkedPair();
  await peer.start();
  await server.connect(transport);
  cleanup.push(() => server.close(), () => peer.close());
  const cases = [
    { name: "tinycloud_kv_get", input: { key: "xyz.tinycloud.agent-data/PRIVATE_RECORD" }, scoped: true },
    { name: "tinycloud_kv_get", input: { key: "xyz.tinycloud.agent-data-other/PRIVATE_RECORD" }, scoped: false },
    { name: "tinycloud_kv_list", input: { prefix: "xyz.tinycloud.agent-data/" }, scoped: true },
    { name: "tinycloud_kv_list", input: { prefix: "" }, scoped: false },
    { name: "tinycloud_sql_schema_inspect", input: { database: "xyz.tinycloud.agent-data.index" }, scoped: true },
    { name: "tinycloud_sql_schema_inspect", input: { database: "xyz.tinycloud.agent-data.index.other" }, scoped: false },
  ];
  let id = 0;
  for (const entry of cases) {
    const response = Promise.withResolvers<JSONRPCMessage>();
    peer.onmessage = response.resolve;
    await withDiagnosticContext(parent, () => peer.send({
      jsonrpc: "2.0", id: ++id, method: "tools/call",
      params: { name: entry.name, arguments: { space: "default", ...entry.input } },
    }));
    expect(await response.promise).toMatchObject({
      result: { structuredContent: { status: "error", error: { code: "PROFILE_NOT_FOUND" } } },
    });
  }
  await runtime.close();
  const snapshot = await store.snapshot({ all: true });
  expect(snapshot.events.filter((event) => event.type === "invocation.start")).toHaveLength(cases.filter((entry) => entry.scoped).length);
  expect(snapshot.events.filter((event) => event.type === "invocation.finish")).toHaveLength(cases.filter((entry) => entry.scoped).length);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_RECORD");
  expect(JSON.stringify(snapshot)).not.toContain("xyz.tinycloud.agent-data");
});
