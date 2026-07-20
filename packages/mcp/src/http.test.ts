import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";

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

async function testApp(): Promise<HostedMcpApp> {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-http-"));
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
