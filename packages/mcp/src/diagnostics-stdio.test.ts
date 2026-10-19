import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromJsonSchema, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { addFormats, Ajv, AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import {
  createDiagnosticRuntime, DiagnosticStore, diagnosticId, getDiagnosticContext, makeDiagnosticContext,
  type DiagnosticContext,
} from "@tinycloud/operations/diagnostics";
import { DiagnosticMcpServer, diagnosticExecutor } from "./diagnostics.js";
import { createJsonSchemaValidator } from "./tools.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("stdio launch scope and capture policy never admit unrelated tools or protocol discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-stdio-scope-"));
  roots.push(root);
  const store = new DiagnosticStore(join(root, "history"));
  await store.control("enable", { scope: "tc-apps" });
  const runId = diagnosticId();
  for (const scoped of [false, true]) {
    const transport = new StdioClientTransport({
      command: process.env.NODE_BINARY ?? "node",
      args: [new URL("../dist/cli.js", import.meta.url).pathname, "--profile", "agent"],
      env: {
        PATH: process.env.PATH ?? "", HOME: join(root, "home"), TC_HOME: join(root, "profiles"),
        TC_DIAGNOSTICS_HOME: join(root, "history"),
        TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, run_id: runId, ...(scoped ? { scope: "tc-apps" } : {}) }),
      },
      stderr: "pipe",
    });
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const client = new Client({ name: "synthetic-scope", version: "1.0.0" }, {
      jsonSchemaValidator: new AjvJsonSchemaValidator(ajv),
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.some((tool) => tool.name === "tinycloud_kv_put")).toBe(true);
      expect(listed.tools.some((tool) => tool.name.includes("diagnostic"))).toBe(false);
      expect((await store.snapshot({ all: true })).events).toEqual([]);
      await client.callTool({ name: "tinycloud_status", arguments: {} });
      expect((await store.snapshot({ all: true })).events).toEqual([]);
    } finally {
      await client.close();
    }
    const snapshot = await store.snapshot({ all: true });
    expect(snapshot.events).toEqual([]);
  }
}, 30_000);

for (const initiallyEnabled of [false, true]) {
  test(`one stdio transport follows live controls from ${initiallyEnabled ? "enabled" : "disabled"} capture without replay`, async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-stdio-live-policy-"));
    roots.push(root);
    const store = new DiagnosticStore(join(root, "history"));
    if (initiallyEnabled) await store.control("enable", { scope: "tc-apps" });
    const runId = diagnosticId();
    const runtime = createDiagnosticRuntime({ root: join(root, "history"), source: "mcp_stdio" });
    const validator = createJsonSchemaValidator();
    const server = new DiagnosticMcpServer({ name: "synthetic-live-policy", version: "1.0.0" }, { jsonSchemaValidator: validator });
    let pending: PromiseWithResolvers<DiagnosticContext | undefined> | undefined;
    server.stdioDiagnosticContext = () => {
      pending = Promise.withResolvers<DiagnosticContext | undefined>();
      return pending.promise;
    };
    const seen: Array<DiagnosticContext | undefined> = [];
    let writes = 0;
    server.registerTool("tinycloud_apps_write", {
      inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }, validator),
    }, (_input, context) => diagnosticExecutor("apps_write", context, async () => {
      seen.push(getDiagnosticContext());
      return { content: [{ type: "text" as const, text: String(++writes) }] };
    }));
    const [peer, transport] = InMemoryTransport.createLinkedPair();
    let delivered = Promise.withResolvers<unknown>();
    peer.onmessage = (message) => delivered.resolve(message);
    await peer.start();
    await server.connect(transport);
    let id = 0;
    const call = async (name: string) => {
      delivered = Promise.withResolvers<unknown>();
      await peer.send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: {} } });
      return delivered.promise;
    };
    const refresh = async () => {
      // The first apps call is allowed to have no evidence. An unregistered
      // apps method starts discovery but never invokes the mutation executor.
      await call("tinycloud_apps_context");
      if (pending === undefined) throw new Error("Apps call did not start discovery");
      const admitted = pending;
      const binding = await runtime.binding();
      admitted.resolve(binding === undefined ? undefined : makeDiagnosticContext(binding, "mcp_stdio", { run_id: runId }));
      // The transport attached its reaction during synchronous inbound dispatch.
      await admitted.promise;
    };
    const write = async () => {
      expect(await call("tinycloud_apps_write")).toMatchObject({
        result: { content: [{ type: "text", text: String(writes) }] },
      });
    };
    try {
      await refresh();
      await write();
      expect(seen[0]?.scope).toBe(initiallyEnabled ? "tc-apps" : undefined);
      if (!initiallyEnabled) {
        await store.control("enable", { scope: "tc-apps" });
        await refresh();
        await write();
        expect(seen.at(-1)?.scope).toBe("tc-apps");
      }
      const initialInvocation = seen.at(-1)!.invocation_id;
      await store.control("pause");
      await refresh();
      await write();
      expect(seen.at(-1)).toBeUndefined();
      await store.control("resume");
      await refresh();
      await write();
      expect(seen.at(-1)?.scope).toBe("tc-apps");
      await store.control("disable");
      await refresh();
      await write();
      expect(seen.at(-1)).toBeUndefined();
      await store.control("enable", { scope: "tc-apps" });
      await store.delete({ all: true }, { pause_after: false });
      await refresh();
      await write();
      const fresh = seen.at(-1)!;
      expect(fresh.scope).toBe("tc-apps");
      expect(fresh.invocation_id).not.toBe(initialInvocation);
      expect(writes).toBe(initiallyEnabled ? 5 : 6);
      await runtime.close();
      const snapshot = await store.snapshot({ all: true });
      expect(snapshot.events.some((event) => event.type === "invocation.finish" && event.invocation_id === fresh.invocation_id)).toBe(true);
      expect(snapshot.events.every((event) => event.invocation_id !== initialInvocation)).toBe(true);
      expect(snapshot.events.filter((event) => event.type !== "capture.health").every((event) =>
        event.source === "mcp_stdio" && event.run_id === runId && event.partition_id === fresh.binding.partition_id)).toBe(true);
    } finally {
      pending?.resolve(undefined);
      await server.close();
      await peer.close();
      await runtime.close();
    }
  }, 30_000);
}
