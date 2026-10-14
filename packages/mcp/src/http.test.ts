import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";
import { ApprovalStageError, RemoteTenantStore } from "./remote-store.js";
import { REQUESTER_KEY, openKeyCallbackBody, ownerDid } from "./test-support/openkey-callback.js";

const CANARY = "callback-secret-canary";
const MESSAGE = "TinyCloud could not accept this delegation.";

const directories: string[] = [];
const apps: HostedMcpApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("serves health and RFC 9728 discovery without authentication", async () => {
  const app = await testApp();
  const health = await app.fetch(new Request("http://127.0.0.1:3000/healthz", {
    headers: { host: "127.0.0.1:3000" },
  }));
  const metadata = await app.fetch(request("/.well-known/oauth-protected-resource/mcp"));

  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://openkey.test/api/auth"],
    scopes_supported: ["tinycloud:mcp"],
  });
});

test("accepts callbacks only from the configured OpenKey origin", async () => {
  const app = await testApp();
  const response = await app.fetch(request("/connect/callback?state=invalid", {
    method: "POST",
    headers: { origin: "https://attacker.test" },
    body: "{}",
  }));
  expect(response.status).toBe(403);
});

test("challenges unauthenticated MCP requests with resource metadata", async () => {
  const app = await testApp();
  const response = await app.fetch(request("/mcp", { method: "POST" }));

  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain(
    'resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"',
  );
});

test("rejects untrusted browser origins", async () => {
  const app = await testApp();
  const response = await app.fetch(request("/mcp", {
    method: "POST",
    headers: { origin: "https://attacker.test" },
  }));
  expect(response.status).toBe(403);
});

test("a refused callback names its stage and code without echoing the callback", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-http-"));
  const app = await testApp(stateDir);
  // A second store over the same state mints the approval link the hosted app reads.
  const store = new RemoteTenantStore({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
  });
  const status = await store.connectStatus("openkey-user-a", [await ownerDid(REQUESTER_KEY)]);
  const state = encodeURIComponent(new URL(status.approvalUrl!).searchParams.get("state")!);
  const signed = await openKeyCallbackBody({
    tenantStateRoot: store.tenantStateRoot("openkey-user-a"),
    privateKey: REQUESTER_KEY,
    space: "account",
    abilities: { kv: { "spaces/": ["tinycloud.kv/get", "tinycloud.kv/list"] } },
  });
  const header = signed.delegationHeader;
  const authorization = typeof header === "object" && header !== null && "Authorization" in header
    ? String(header.Authorization)
    : "";
  expect(authorization).not.toBe("");
  const signature = String(signed.signature);
  const tampered = {
    ...signed,
    signature: `${signature.slice(0, -2)}${signature.endsWith("00") ? "11" : "00"}`,
    token: `eyJ.${CANARY}.jwt`,
    note: CANARY,
  };
  const incomplete: Record<string, unknown> = { ...signed, token: CANARY };
  delete incomplete.signature;
  const secrets = [CANARY, authorization, signature, String(signed.siwe), status.sessionDid];

  const diagnostics: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk));
    return true;
  });
  const responses: Array<{ status: number; body: unknown }> = [];
  try {
    for (const body of [JSON.stringify(tampered), JSON.stringify(incomplete), `{"token":"${CANARY}"`]) {
      const response = await app.fetch(request(`/connect/callback?state=${state}`, {
        method: "POST",
        headers: { origin: "https://openkey.test", "content-type": "application/json" },
        body,
      }));
      const text = await response.text();
      for (const secret of secrets) expect(text).not.toContain(secret);
      responses.push({ status: response.status, body: JSON.parse(text) });
    }
  } finally {
    stderr.mockRestore();
  }

  expect(responses).toEqual([
    { status: 400, body: { error: "restore_approval", code: "AUTH_EXPIRED", message: MESSAGE } },
    { status: 400, body: { error: "restore_approval", code: "CALLBACK_INCOMPLETE", message: MESSAGE } },
    { status: 400, body: { error: "unknown", code: "UNKNOWN", message: MESSAGE } },
  ]);
  expect(diagnostics).toEqual([
    "[tinycloud-mcp-http] connect callback rejected: stage=restore_approval code=AUTH_EXPIRED\n",
    "[tinycloud-mcp-http] connect callback rejected: stage=restore_approval code=CALLBACK_INCOMPLETE\n",
    "[tinycloud-mcp-http] connect callback rejected: stage=unknown code=UNKNOWN\n",
  ]);
  for (const secret of secrets) expect(diagnostics.join("")).not.toContain(secret);
});

test("a callback reports only allowlisted rejection reasons and well-formed codes", async () => {
  const app = await testApp();
  const refusals = [
    new ApprovalStageError("activation", "DELEGATION_REJECTED", "activation_unauthenticated", new Error(CANARY)),
    new ApprovalStageError("activation", "DELEGATION_REJECTED", `node said ${CANARY}`),
    new ApprovalStageError("auth_import", `${CANARY} INTERNAL`),
  ];
  const completeApproval = spyOn(RemoteTenantStore.prototype, "completeApproval");
  const diagnostics: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk));
    return true;
  });
  const bodies: unknown[] = [];
  try {
    for (const refusal of refusals) {
      completeApproval.mockRejectedValueOnce(refusal);
      const response = await app.fetch(request("/connect/callback?state=any", {
        method: "POST",
        headers: { origin: "https://openkey.test" },
        body: "{}",
      }));
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).not.toContain(CANARY);
      bodies.push(JSON.parse(text));
    }
  } finally {
    stderr.mockRestore();
    completeApproval.mockRestore();
  }

  expect(bodies).toEqual([
    { error: "activation", code: "DELEGATION_REJECTED", reason: "activation_unauthenticated", message: MESSAGE },
    { error: "activation", code: "DELEGATION_REJECTED", reason: "unknown", message: MESSAGE },
    { error: "auth_import", code: "UNKNOWN", message: MESSAGE },
  ]);
  expect(diagnostics.join("")).not.toContain(CANARY);
  expect(diagnostics).toHaveLength(3);
});

async function testApp(existingStateDir?: string): Promise<HostedMcpApp> {
  const stateDir = existingStateDir ?? await mkdtemp(join(tmpdir(), "tinycloud-hosted-http-"));
  directories.push(stateDir);
  const app = createHostedMcpApp({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
    allowedOrigins: ["https://claude.ai"],
    oauthMetadata: {
      issuer: "https://openkey.test/api/auth",
      authorization_endpoint: "https://openkey.test/api/auth/oauth2/authorize",
      token_endpoint: "https://openkey.test/api/auth/oauth2/token",
      jwks_uri: "https://openkey.test/api/auth/jwks",
      registration_endpoint: "https://openkey.test/api/auth/oauth2/register",
      response_types_supported: ["code"],
    },
  });
  apps.push(app);
  return app;
}

function request(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set("host", "mcp.test");
  return new Request(`https://mcp.test${path}`, { ...init, headers });
}
