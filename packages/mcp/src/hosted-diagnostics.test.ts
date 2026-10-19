import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer, request as nodeRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { DiagnosticStore, resolveDiagnosticTenant } from "@tinycloud/operations/diagnostics";

import { createHostedMcpApp } from "./http.js";
import { HostedDiagnostics, createHostedNodeHandler } from "./hosted-diagnostics.js";
import { RemoteTenantStore } from "./remote-store.js";
import { REQUESTER_KEY, openKeyCallbackBody, ownerDid } from "./test-support/openkey-callback.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Hosted diagnostic fixture cleanup failed");
});

async function listen(server: Server): Promise<string> {
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No synthetic listener.");
  return `http://127.0.0.1:${address.port}`;
}

test("state symlink ancestors cannot place diagnostic history inside account state", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-diagnostic-root-alias-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const history = join(root, "history");
  const partition = await resolveDiagnosticTenant(history, "service", { create: true });
  const store = new DiagnosticStore(history, partition!);
  await store.control("enable", { scope: "tc-apps" });
  await symlink(history, join(root, "state-alias"));
  const config = {
    publicUrl: new URL("https://mcp.test/mcp"),
    stateDir: join(root, "state-alias", "not-created-yet"),
    stateSecret: "synthetic-state-secret-with-more-than-thirty-two-bytes",
    nodeHost: "http://127.0.0.1:1", openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300, delegationExpiry: "1h",
    oauthMetadata: {
      issuer: "https://openkey.test", authorization_endpoint: "https://openkey.test/authorize",
      token_endpoint: "https://openkey.test/token", jwks_uri: "http://127.0.0.1:1/jwks", response_types_supported: ["code"],
    },
  };
  const off = createHostedMcpApp(config);
  const on = createHostedMcpApp({ ...config, diagnostics: { root: history } });
  cleanup.push(() => off.close(), () => on.close());
  const results = [];
  for (const app of [off, on]) {
    const response = await app.fetch(new Request("https://mcp.test/mcp", {
      method: "POST", headers: { host: "mcp.test", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    results.push({ status: response.status, body: await response.text() });
  }
  expect(results[0]!.status).toBe(401);
  expect(results[1]).toEqual(results[0]);
  await on.close();
  expect((await store.snapshot({ all: true })).events).toEqual([]);
}, 30_000);

test("verified tenants cannot select each other's partition with metadata or reused request IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-tenant-diagnostics-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const jwk = { ...await exportJWK(publicKey), kid: "synthetic", alg: "EdDSA" };
  const jwks = await listen(createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); }));
  const secret = "synthetic-state-secret-with-more-than-thirty-two-bytes";
  const diagnosticRoot = join(root, "diagnostics");
  const app = createHostedMcpApp({
    publicUrl: new URL("https://mcp.test/mcp"), stateDir: join(root, "state"), stateSecret: secret,
    nodeHost: "http://127.0.0.1:1", openkeyHost: "https://openkey.test", approvalTtlSeconds: 300, delegationExpiry: "1h",
    diagnostics: { root: diagnosticRoot },
    oauthMetadata: {
      issuer: "https://openkey.test", authorization_endpoint: "https://openkey.test/authorize",
      token_endpoint: "https://openkey.test/token", jwks_uri: `${jwks}/jwks`, response_types_supported: ["code"],
    },
  });
  cleanup.push(() => app.close());
  const token = async (subject: string) => new SignJWT({ scope: "tinycloud:mcp", azp: "synthetic", "https://tinycloud.xyz/owner_dids": ["did:pkh:eip155:1:0x1111111111111111111111111111111111111111"] })
    .setProtectedHeader({ alg: "EdDSA", kid: "synthetic" }).setSubject(subject).setIssuer("https://openkey.test")
    .setAudience("https://mcp.test/mcp").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const tokens = [await token("PRIVATE_TENANT_A"), await token("PRIVATE_TENANT_B"), await token("PRIVATE_TENANT_C")];
  const call = async (bearer: string, meta: Record<string, unknown> = {}, origin?: string, name?: string) => {
    const response = await app.fetch(new Request("https://mcp.test/mcp", {
      method: "POST", headers: { host: "mcp.test", authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(origin === undefined ? {} : { origin }) },
      body: JSON.stringify({ jsonrpc: "2.0", id: "PRIVATE_REUSED_ID",
        method: name === undefined ? "tools/list" : "tools/call",
        params: { ...(name === undefined ? {} : { name, arguments: {} }), _meta: meta } }),
    }));
    await response.text();
    return response.status;
  };
  expect(await call(tokens[0]!)).toBe(200);
  expect(await call(tokens[1]!)).toBe(200);
  await expect(access(diagnosticRoot)).rejects.toMatchObject({ code: "ENOENT" });
  const tenants = ["PRIVATE_TENANT_A", "PRIVATE_TENANT_B"].map((subject) => createHmac("sha256", secret).update(`tenant:${subject}`).digest("hex"));
  // Protected operator setup is explicit; requests only discover existing mappings.
  // These fixtures test tenant isolation, not contention among operator controls
  // sharing one root-wide writer lock. Finish each control before the next.
  const partitions: Array<string | undefined> = [];
  for (const id of tenants) partitions.push(await resolveDiagnosticTenant(diagnosticRoot, id, { create: true }));
  expect(partitions[0]).not.toBe(partitions[1]);
  const stores = partitions.map((partition) => new DiagnosticStore(diagnosticRoot, partition!));
  await stores[0]!.control("enable", { scope: "tc-apps" });
  await stores[1]!.control("enable", { scope: "tc-apps" });
  const servicePartition = await resolveDiagnosticTenant(diagnosticRoot, "service", { create: true });
  const service = new DiagnosticStore(diagnosticRoot, servicePartition!);

  expect(await Promise.all([
    call(tokens[0]!, { partition_id: partitions[1], tenant: tenants[1], run_id: partitions[1], token: "PRIVATE_META_CANARY" }, undefined, "tinycloud_apps_context"),
    call(tokens[1]!, { partition_id: partitions[0] }, undefined, "tinycloud_apps_context"),
    call(tokens[0]!, { scope: "tc-apps", partition_id: partitions[0] }),
    call(tokens[2]!, { scope: "tc-apps", partition_id: partitions[0] }, undefined, "tinycloud_apps_context"),
  ])).toEqual([200, 200, 200, 200]);
  expect(await call("PRIVATE_INVALID_TOKEN", { partition_id: partitions[0] }, undefined, "tinycloud_apps_context")).toBe(401);
  expect(await call(tokens[0]!, {}, "https://PRIVATE_ORIGIN.invalid", "tinycloud_apps_context")).toBe(403);
  await app.close();
  const histories = [];
  for (const store of [...stores, service]) histories.push(await store.snapshot({ all: true }));
  const [a, b, unauthenticated] = histories;
  expect(a!.events.filter((event) => event.type === "invocation.start")).toHaveLength(1);
  expect(b!.events.filter((event) => event.type === "invocation.start")).toHaveLength(1);
  expect(a!.events.every((event) => event.partition_id === partitions[0] && event.run_id === undefined)).toBe(true);
  expect(b!.events.every((event) => event.partition_id === partitions[1] && event.run_id === undefined)).toBe(true);
  expect(a!.events.find((event) => event.type === "invocation.start")!.invocation_id)
    .not.toBe(b!.events.find((event) => event.type === "invocation.start")!.invocation_id);
  expect(unauthenticated!.events).toEqual([]);
  const unrecorded = createHmac("sha256", secret).update("tenant:PRIVATE_TENANT_C").digest("hex");
  expect(await resolveDiagnosticTenant(diagnosticRoot, unrecorded, { create: false })).toBeUndefined();
  await stores[0]!.delete({ all: true }, { pause_after: true });
  expect((await stores[0]!.snapshot({ all: true })).events).toEqual([]);
  expect((await stores[1]!.snapshot({ all: true })).events).toEqual(b!.events);
  expect(JSON.stringify([a, b, unauthenticated])).not.toContain("PRIVATE_");
}, 30_000);

test("disabled service policy preserves Node responses without creating capture files or tenant mappings", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-disabled-diagnostics-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const partition = await resolveDiagnosticTenant(root, "service", { create: true });
  const store = new DiagnosticStore(root, partition!);
  await store.control("enable", { scope: "tc-apps" });
  await store.control("disable");
  const before = (await readdir(root, { recursive: true })).sort();
  const diagnostics = new HostedDiagnostics({ root });
  cleanup.push(() => diagnostics.close());
  const verifiedTenantId = createHmac("sha256", "synthetic-secret").update("tenant:synthetic").digest("hex");
  const app = {
    diagnostics,
    async fetch(): Promise<Response> {
      return diagnostics.tenant(verifiedTenantId, () => diagnostics.response(async () =>
        new Response("synthetic business response", { status: 202, headers: { "x-business": "preserved" } })), true);
    },
  };
  const origin = await listen(createServer(createHostedNodeHandler(app)));
  const response = await fetch(origin);
  expect(response.status).toBe(202);
  expect(response.headers.get("x-business")).toBe("preserved");
  expect(await response.text()).toBe("synthetic business response");
  await diagnostics.close();
  expect(await resolveDiagnosticTenant(root, verifiedTenantId, { create: false })).toBeUndefined();
  expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
  expect((await store.snapshot({ all: true })).events).toEqual([]);
}, 30_000);

test("real Node socket finish, close-before-finish and adapter errors are separate observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-socket-diagnostics-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const tenantId = createHmac("sha256", "synthetic-secret").update("tenant:socket").digest("hex");
  const partition = await resolveDiagnosticTenant(root, tenantId, { create: true });
  const store = new DiagnosticStore(root, partition!);
  await store.control("enable", { scope: "tc-apps" });
  const diagnostics = new HostedDiagnostics({ root });
  cleanup.push(() => diagnostics.close());
  const app = {
    diagnostics,
    async fetch(request: Request): Promise<Response> {
      return diagnostics.tenant(tenantId, async () => {
      const path = new URL(request.url).pathname;
      if (path === "/fail") throw new Error("PRIVATE_ADAPTER_ERROR");
      if (path === "/stream") return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("PRIVATE_STREAM_CONTENT"));
          request.signal.addEventListener("abort", () => controller.close(), { once: true });
        },
      }));
      return new Response("PRIVATE_COMPLETE_CONTENT", { status: 201 });
      }, true);
    },
  };
  const server = createServer(createHostedNodeHandler(app));
  const origin = await listen(server);
  const completed = await fetch(origin);
  expect(completed.status).toBe(201);
  expect(await completed.text()).toBe("PRIVATE_COMPLETE_CONTENT");
  const closed = new Promise<void>((resolve) => {
    server.once("request", (_request, response) => response.once("close", resolve));
  });
  await new Promise<void>((resolve, reject) => {
    const request = nodeRequest(`${origin}/stream`, (response) => {
      response.once("data", () => { response.destroy(); resolve(); });
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end();
  });
  await closed;
  const failed = await fetch(`${origin}/fail`);
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("PRIVATE_ADAPTER_ERROR");
  await diagnostics.close();
  const snapshot = await store.snapshot({ all: true });
  expect(snapshot.events.filter((event) => event.delivery === "finish")).toHaveLength(2);
  expect(snapshot.events.filter((event) => event.delivery === "close_before_finish")).toHaveLength(1);
  expect(snapshot.events.filter((event) => event.delivery === "error")).toHaveLength(1);
  const interrupted = snapshot.events.find((event) => event.delivery === "close_before_finish")!;
  expect(snapshot.events.some((event) => event.invocation_id === interrupted.invocation_id && event.delivery === "finish")).toBe(false);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
}, 30_000);

for (const tenantEnabled of [false, true]) {
  test(`verified callback refusal never resumes service capture with tenant capture ${tenantEnabled ? "on" : "off"}`, async () => {
    const fixture = await callbackCapture();
    const subject = "PRIVATE_ORPHANED_CALLBACK";
    const tenant = await fixture.enable(basename(fixture.store.tenantStateRoot(subject)));
    const status = await fixture.connect(subject);
    const state = new URL(status.approvalUrl!).searchParams.get("state")!;
    if (!tenantEnabled) await tenant.control("disable");
    await rm(join(fixture.store.tenantStateRoot(subject), ".tinycloud/profiles/agent/key.json"));
    const response = await fixture.callback(state, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "unknown", code: "UNKNOWN" });
    await fixture.app.close();
    const tenantHistory = await tenant.snapshot({ all: true });
    const serviceHistory = await fixture.service.snapshot({ all: true });
    expect(serviceHistory.events.filter((event) => event.phase === "approval_request")).toEqual([]);
    expect(serviceHistory.events.filter((event) => event.phase === "http_gate" || event.type === "protocol.outcome")).toEqual([]);
    if (tenantEnabled) {
      expect(tenantHistory.events.filter((event) => event.phase === "approval_request" && event.outcome === "refused")).toHaveLength(1);
      expect(tenantHistory.events.filter((event) => event.phase === "http_gate" && event.status === 400)).toHaveLength(1);
    } else {
      expect(tenantHistory.events.some((event) => event.outcome === "refused" || event.phase === "http_gate")).toBe(false);
    }
    expect(JSON.stringify([tenantHistory, serviceHistory])).not.toContain("PRIVATE_");
  }, 30_000);
}

test("callback HTTP refusal after verified proof and failed persistence is not MCP admission refusal", async () => {
  const fixture = await callbackCapture();
  const subject = "PRIVATE_FAILED_COMMIT";
  const stateRoot = fixture.store.tenantStateRoot(subject);
  const tenant = await fixture.enable(basename(stateRoot));
  const status = await fixture.connect(subject, [await ownerDid(REQUESTER_KEY)]);
  const state = new URL(status.approvalUrl!).searchParams.get("state")!;
  const body = await openKeyCallbackBody({
    tenantStateRoot: stateRoot, privateKey: REQUESTER_KEY, space: "account",
    abilities: { kv: {
      "spaces/": ["tinycloud.kv/get", "tinycloud.kv/list"],
      "applications/": ["tinycloud.kv/get", "tinycloud.kv/list"],
    } },
  });
  await mkdir(join(stateRoot, ".tinycloud/profiles/agent/session.json"));
  const response = await fixture.callback(state, body);
  expect(response.status).toBe(400);
  await fixture.app.close();
  const snapshot = await tenant.snapshot({ all: true });
  expect(snapshot.events.some((event) => event.phase === "approval_verify" && event.outcome === "pass")).toBe(true);
  expect(snapshot.events.some((event) => event.phase === "local_commit" && event.outcome === "error")).toBe(true);
  expect(snapshot.events.some((event) => event.phase === "http_gate" && event.status === 400)).toBe(true);
  expect(snapshot.events.filter((event) => event.type === "protocol.outcome")).toEqual([]);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
}, 30_000);

test("unscoped HTTP routes and MCP authentication refusals leave service capture off", async () => {
  const fixture = await callbackCapture();
  for (const [path, status] of [["/unknown", 404], ["/connect/callback", 405], ["/mcp", 401]] as const) {
    const response = await fixture.app.fetch(new Request(`https://mcp.test${path}`, { headers: { host: "mcp.test" } }));
    expect(response.status).toBe(status);
  }
  await fixture.app.close();
  const snapshot = await fixture.service.snapshot({ all: true });
  expect(snapshot.events).toEqual([]);
}, 30_000);

async function callbackCapture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-callback-capture-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const history = join(root, "history");
  const config = {
    publicUrl: new URL("https://mcp.test/mcp"), stateDir: join(root, "state"),
    stateSecret: "synthetic-state-secret-with-more-than-thirty-two-bytes",
    nodeHost: "http://127.0.0.1:1", openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300, delegationExpiry: "1h",
    oauthMetadata: {
      issuer: "https://openkey.test", authorization_endpoint: "https://openkey.test/authorize",
      token_endpoint: "https://openkey.test/token", jwks_uri: "http://127.0.0.1:1/jwks", response_types_supported: ["code"],
    },
  };
  const enable = async (tenant: string) => {
    const partition = await resolveDiagnosticTenant(history, tenant, { create: true });
    const store = new DiagnosticStore(history, partition!);
    await store.control("enable", { scope: "tc-apps" });
    return store;
  };
  const servicePartition = await resolveDiagnosticTenant(history, "service", { create: true });
  const service = new DiagnosticStore(history, servicePartition!);
  const app = createHostedMcpApp({ ...config, diagnostics: { root: history } });
  cleanup.push(() => app.close());
  const store = new RemoteTenantStore(config);
  return {
    app, service, enable, store,
    connect: (subject: string, ownerDids: readonly string[] = []) => app.diagnostics!.tenant(
      basename(store.tenantStateRoot(subject)), () => store.connectStatus(subject, ownerDids), true),
    callback: (state: string, body: unknown) => app.fetch(new Request(`https://mcp.test/connect/callback?state=${encodeURIComponent(state)}`, {
      method: "POST", headers: { host: "mcp.test", origin: "https://openkey.test", "content-type": "application/json" },
      body: JSON.stringify(body),
    })),
  };
}
