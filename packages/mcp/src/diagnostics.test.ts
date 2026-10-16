import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createMcpHandler, fromJsonSchema, InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import {
  createDiagnosticRuntime, DiagnosticStore, getDiagnosticContext, makeDiagnosticContext, withDiagnosticContext,
  type DiagnosticBinding, type DiagnosticContext,
} from "@tinycloud/operations/diagnostics";

import { DiagnosticMcpServer, diagnosticExecutor, diagnosticSchema } from "./diagnostics.js";
import { createJsonSchemaValidator, registerTinyCloudTools } from "./tools.js";
import { toMcpToolResult } from "./results.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

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

    const handler = createMcpHandler(() => {
      const validator = createJsonSchemaValidator();
      const server = new DiagnosticMcpServer({ name: "synthetic-diagnostics", version: "1.0.0" }, { jsonSchemaValidator: validator });
      registerTinyCloudTools(server, {
        surface: "hosted", profile: "agent", explicitProfile: true, allowOwnerProfile: false, stateRoot: join(root, "tenant"),
      }, validator);
      for (const kind of ["invalid_output", "missing_output", "oversize_read", "oversize_write"] as const) {
        server.registerTool(kind, {
          inputSchema: diagnosticSchema(fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator), "input_validation"),
          outputSchema: diagnosticSchema(fromJsonSchema({ type: "object", properties: { status: { type: "string" } }, required: ["status"] }, validator), "output_validation"),
        }, (_input, context) => diagnosticExecutor("unknown", context, async () => {
          if (kind === "missing_output") return { content: [{ type: "text" as const, text: "synthetic missing output" }] };
          if (kind === "invalid_output") return { content: [], structuredContent: { invalid: true } };
          return toMcpToolResult({ status: "ok", output: { value: "PRIVATE_CONTENT_CANARY".repeat(6000) } }, [], {
            surface: "hosted", readOnly: kind === "oversize_read", operationId: "tinycloud.kv.get",
          });
        }));
      }
      return server;
    }, { legacy: "stateless", onerror: () => {} });
    cleanup.push(() => handler.close());

    const invoke = async (method: string, params: Record<string, unknown>, scope?: DiagnosticBinding) => {
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
      ["tools/call", { name: "invalid_output", arguments: {} }],
      ["tools/call", { name: "missing_output", arguments: {} }],
      ["tools/call", { name: "oversize_read", arguments: {} }],
      ["tools/call", { name: "oversize_write", arguments: {} }],
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
    expect(snapshot.events.filter((event) => event.protocol === "before_executor_refusal")).toHaveLength(3);
    expect(snapshot.events.filter((event) => event.protocol === "post_executor_protocol_failure")).toHaveLength(2);
    const converted = snapshot.events.filter((event) => event.outcome === "converted");
    expect(converted).toHaveLength(1);
    expect(snapshot.events.some((event) => event.invocation_id === converted[0]!.invocation_id && event.canonical_status === "ok")).toBe(true);
    expect(snapshot.events.some((event) => event.canonical_status === "error")).toBe(true);
    expect(snapshot.events.filter((event) => event.type === "invocation.start")).toHaveLength(cases.length);
    expect(new Set(snapshot.events.filter((event) => event.type === "invocation.start").map((event) => event.invocation_id)).size).toBe(cases.length);
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
  server.stdioDiagnosticContext = async () => makeDiagnosticContext(binding!, "mcp_stdio");
  let release!: () => void;
  let entered!: () => void;
  let delivered!: () => void;
  let calls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const bothEntered = new Promise<void>((resolve) => { entered = resolve; });
  const bothDelivered = new Promise<void>((resolve) => { delivered = resolve; });
  for (const name of ["first", "second"]) {
    server.registerTool(name, {
      inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator),
    }, (_input, context) => diagnosticExecutor("unknown", context, async () => {
      if (++calls === 2) entered();
      await gate;
      return { isError: name === "first", content: [{ type: "text" as const, text: "PRIVATE_DUPLICATE_RESPONSE" }] };
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
  cleanup.push(() => server.close(), () => peer.close());
  await peer.send({ jsonrpc: "2.0", id: "PRIVATE_OVERLAPPING_ID", method: "tools/call", params: { name: "first", arguments: {} } });
  await peer.send({ jsonrpc: "2.0", id: "PRIVATE_OVERLAPPING_ID", method: "tools/call", params: { name: "second", arguments: {} } });
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
  const queuedBound = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const releaseQueued = Promise.withResolvers<void>();
  const freshDiscovered = Promise.withResolvers<void>();
  let admissions = 0;
  server.stdioDiagnosticContext = async () => {
    const binding = await runtime.binding();
    if (++admissions === 2) {
      queuedBound.resolve();
      await releaseQueued.promise;
    }
    if (admissions === 3) freshDiscovered.resolve();
    return binding === undefined ? undefined : makeDiagnosticContext(binding, "mcp_stdio");
  };
  const seen: Array<DiagnosticContext | undefined> = [];
  server.registerTool("synthetic_hold", {
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
  cleanup.push(() => server.close());
  const invoke = (id: number) => {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "synthetic_hold", arguments: {} } }) + "\n");
  };
  try {
    invoke(1);
    await firstEntered.promise;
    invoke(2);
    await Promise.all([queuedBound.promise, secondEntered.promise]);
    expect(admissions).toBe(2);
    await store.delete({ all: true }, { pause_after: false });
    releaseQueued.resolve();
    await setImmediate();
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }) + "\n");
    await freshDiscovered.promise;
    await setImmediate();
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
    releaseQueued.resolve();
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
  let probes = 0;
  let mutations = 0;
  server.stdioDiagnosticContext = () => {
    if (++probes === 1) return Promise.resolve(undefined);
    discoveryStarted.resolve();
    return discovery.promise;
  };
  server.registerTool("synthetic_mutate", {
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
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "synthetic_mutate", arguments: {} } });
    const signal = await entered.promise;
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await discoveryStarted.promise;
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    await setImmediate();
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
    const validator = createJsonSchemaValidator();
    const server = new DiagnosticMcpServer({ name: "synthetic-cancellation", version: "1.0.0" }, { jsonSchemaValidator: validator });
    server.stdioDiagnosticContext = async () => makeDiagnosticContext(binding!, "mcp_stdio");
    let entered = Promise.withResolvers<AbortSignal>();
    let release = Promise.withResolvers<void>();
    server.registerTool("hold", {
      inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator),
    }, (_input, context) => diagnosticExecutor("unknown", context, async () => {
      entered.resolve(context.mcpReq.signal);
      await release.promise;
      return { isError: true, content: [{ type: "text" as const, text: "PRIVATE_CANCELLED_RESULT" }] };
    }));
    const [peer, transport] = InMemoryTransport.createLinkedPair();
    const delivered = Promise.withResolvers<JSONRPCMessage>();
    const responses: JSONRPCMessage[] = [];
    peer.onmessage = (message) => { responses.push(message); delivered.resolve(message); };
    await peer.start();
    await server.connect(transport);
    cleanup.push(() => server.close(), () => peer.close());
    try {
      const count = reuse ? 1 : 128;
      for (let index = 1; index <= count; index++) {
        entered = Promise.withResolvers<AbortSignal>();
        release = Promise.withResolvers<void>();
        await peer.send({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name: "hold", arguments: {} } });
        const signal = await entered.promise;
        await peer.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: index } });
        await setImmediate();
        expect(signal.aborted).toBe(true);
        if (!reuse) {
          release.resolve();
          await setImmediate();
          // Await durable batches so this tests the pending-request bound,
          // not intentional loss from overflowing the independent event queue.
          if (index % 16 === 0) {
            const deadline = performance.now() + 5000;
            let completed = 0;
            do {
              await setImmediate();
              const snapshot = await store.snapshot({ all: true });
              completed = snapshot.events.filter((event) => event.phase === "executor" && event.outcome === "complete").length;
            } while (completed < index && performance.now() < deadline);
            expect(completed).toBe(index);
          }
        }
      }
      await peer.send({ jsonrpc: "2.0", id: reuse ? 1 : 129, method: "tools/list", params: {} });
      expect(await delivered.promise).toHaveProperty("result.tools");
      release.resolve();
      await setImmediate();
      expect(responses).toHaveLength(1);
      await runtime.close();
      const snapshot = await store.snapshot({ all: true });
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
  server.stdioDiagnosticContext = async () => makeDiagnosticContext(binding!, "mcp_stdio");
  server.registerTool("throw", {
    inputSchema: diagnosticSchema(fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator), "input_validation"),
  }, (_input, context) => diagnosticExecutor("unknown", context, async () => { throw new Error("PRIVATE_EXECUTOR_FAILURE"); }));
  const [peer, transport] = InMemoryTransport.createLinkedPair();
  const delivered = Promise.withResolvers<JSONRPCMessage>();
  peer.onmessage = delivered.resolve;
  await peer.start();
  await server.connect(transport);
  cleanup.push(() => server.close(), () => peer.close());
  await peer.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "throw", arguments: {} } });
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
  server.stdioDiagnosticContext = async () => makeDiagnosticContext(binding!, "mcp_stdio");
  const oldEntered = Promise.withResolvers<AbortSignal>();
  const newEntered = Promise.withResolvers<void>();
  const oldRelease = Promise.withResolvers<void>();
  const newRelease = Promise.withResolvers<void>();
  const oldSent = Promise.withResolvers<void>();
  const newSent = Promise.withResolvers<JSONRPCMessage>();
  const invocations: string[] = [];
  for (const name of ["old", "new"]) {
    server.registerTool(name, {
      inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator),
    }, (_input, context) => diagnosticExecutor("unknown", context, async () => {
      invocations.push(getDiagnosticContext()!.invocation_id);
      if (name === "old") {
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
  cleanup.push(() => server.close(), () => peer.close());
  try {
    await peer.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "old", arguments: {} } });
    const signal = await oldEntered.promise;
    await peer.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    await setImmediate();
    expect(signal.aborted).toBe(true);
    await peer.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "new", arguments: {} } });
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
