import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DiagnosticStore, diagnosticId } from "@tinycloud/operations/diagnostics";
import type { DiagnosticEvent, DiagnosticRole } from "@tinycloud/operations/diagnostics";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("stdio requires explicit tc-apps scope, not merely capture enablement or inherited run linkage", async () => {
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
    const client = new Client({ name: "synthetic-scope", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.some((tool) => tool.name === "tinycloud_kv_put")).toBe(true);
      expect(listed.tools.some((tool) => tool.name.includes("diagnostic"))).toBe(false);
    } finally {
      await client.close();
    }
    const snapshot = await store.snapshot({ all: true });
    if (!scoped) expect(snapshot.events).toEqual([]);
    else {
      expect(snapshot.events.some((event) => event.type === "invocation.start" && event.source === "mcp_stdio")).toBe(true);
      expect(snapshot.events.some((event) => event.protocol === "result")).toBe(true);
      expectScopedHistory(snapshot.events, runId);
    }
  }
}, 30_000);

for (const initiallyEnabled of [false, true]) {
  test(`one scoped stdio connection follows live controls from ${initiallyEnabled ? "enabled" : "disabled"} capture`, async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-stdio-live-policy-"));
    roots.push(root);
    const store = new DiagnosticStore(join(root, "history"));
    if (initiallyEnabled) await store.control("enable", { scope: "tc-apps" });
    const runId = diagnosticId();
    const transport = new StdioClientTransport({
      command: process.env.NODE_BINARY ?? "node",
      args: [new URL("../dist/cli.js", import.meta.url).pathname, "--profile", "agent"],
      env: {
        PATH: process.env.PATH ?? "", HOME: join(root, "home"), TC_HOME: join(root, "profiles"),
        TC_DIAGNOSTICS_HOME: join(root, "history"),
        TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, run_id: runId, scope: "tc-apps" }),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "synthetic-live-policy", version: "1.0.0" });
    const invoke = async (role: DiagnosticRole) => {
      const result = await client.callTool({
        name: "tinycloud_status", arguments: {}, _meta: { "xyz.tinycloud/diagnostic-role": role },
      });
      expect(result.structuredContent).toMatchObject({ status: "error", error: { code: "PROFILE_NOT_FOUND" } });
    };
    const history = async (role: DiagnosticRole) => {
      const deadline = Date.now() + 3_000;
      let snapshot = await store.snapshot({ all: true });
      let completed = false;
      // Each call is a new read-only business invocation. A control transition's
      // first call may only refresh policy; require actual later source evidence.
      while (!completed && Date.now() < deadline) {
        await invoke(role);
        await setImmediate();
        snapshot = await store.snapshot({ all: true });
        completed = snapshot.events.some((event) => event.phase === "executor" && event.outcome === "complete" && event.role === role
          && snapshot.events.some((finish) => finish.type === "invocation.finish" && finish.invocation_id === event.invocation_id));
      }
      expect(completed).toBe(true);
      expectScopedHistory(snapshot.events, runId);
      return snapshot;
    };
    try {
      await client.connect(transport);
      if (!initiallyEnabled) {
        await invoke("unknown");
        expect((await store.snapshot({ all: true })).events).toEqual([]);
        await store.control("enable", { scope: "tc-apps" });
      }
      const first = await history("catalog");
      await store.control("pause");
      await invoke("approval");
      await store.control("resume");
      const resumed = await history("verification");
      expect(resumed.events.some((event) => event.role === "approval")).toBe(false);
      await store.control("enable", { scope: "tc-apps" });
      await history("copy");
      await store.delete({ all: true }, { pause_after: false });
      const fresh = await history("context");
      const oldInvocations = new Set(first.events.map((event) => event.invocation_id));
      expect(fresh.events.every((event) => !oldInvocations.has(event.invocation_id))).toBe(true);
      expect(fresh.events.some((event) => event.type === "invocation.finish")).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
}

function expectScopedHistory(events: readonly DiagnosticEvent[], runId: string): void {
  const business = events.find((event) => event.type !== "capture.health");
  expect(business).toBeDefined();
  for (const event of events) {
    expect(event.source).toBe("mcp_stdio");
    expect(event.source_id).toBe(business!.source_id);
    expect(event.partition_id).toBe(business!.partition_id);
    expect(event.task_id).toBeUndefined();
    if (event.type === "capture.health") {
      // Independent recovery summaries retain source/partition/invocation, not
      // optional run linkage (recordDiagnosticRecovery's closed projection).
      expect(event.run_id).toBeUndefined();
      expect(event.outcome).toBe("dropped");
      expect(event.dropped).toBeGreaterThan(0);
      expect(event.failure).toBeDefined();
    } else expect(event.run_id).toBe(runId);
  }
}
