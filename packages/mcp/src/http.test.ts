import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";
import { ApprovalStageError, RemoteTenantStore } from "./remote-store.js";
import { REQUESTER_KEY, openKeyCallbackBody, ownerDid } from "./test-support/openkey-callback.js";
import { MCP_VERSION } from "./version.js";
import { MCP_SERVER_NAME } from "./server.js";

const CANARY = "callback-secret-canary";
const MESSAGE = "TinyCloud could not accept this delegation.";

const directories: string[] = [];
const apps: HostedMcpApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("serves hosted landing in HTML and Markdown with discovery links", async () => {
  const app = await testApp();
  const landing = await app.fetch(request("/"));
  const markdown = await app.fetch(request("/", { headers: { accept: "text/markdown" } }));
  const health = await app.fetch(new Request("http://127.0.0.1:3000/healthz", {
    headers: { host: "127.0.0.1:3000" },
  }));

  expect(landing.status).toBe(200);
  expect(landing.headers.get("content-type")).toContain("text/html");
  const html = await landing.text();
  expect(html).toContain("https://mcp.tinycloud.xyz/mcp");
  expect(html).toContain('<link rel="ai-catalog" href="/.well-known/ai-catalog.json">');
  expect(landing.headers.get("link")).toContain('rel="describedby"');
  expect(landing.headers.get("link")).toContain('rel="service-doc"');
  expect(markdown.status).toBe(200);
  expect(markdown.headers.get("content-type")).toContain("text/markdown");
  const markdownText = await markdown.text();
  expect(markdownText).toContain("Local alternative:");
  expect(markdownText).toContain("`@tinycloud/cli`");
  expect(markdownText).toContain("`@tinycloud/mcp`");
  expect(html).toContain("<code>@tinycloud/cli</code>");
  expect(html).toContain("<code>@tinycloud/mcp</code>");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
});

test("serves plain text LLM guidance and AI discovery directives", async () => {
  const app = await testApp();
  const llms = await app.fetch(request("/llms.txt"));
  const robots = await app.fetch(request("/robots.txt"));
  const sitemap = await app.fetch(request("/sitemap.xml"));

  expect(llms.status).toBe(200);
  expect(llms.headers.get("content-type")).toContain("text/plain");
  const llmsText = await llms.text();
  expect(llmsText).toContain("https://mcp.tinycloud.xyz/mcp");
  expect(llmsText).toContain("Local alternative: install @tinycloud/cli and @tinycloud/mcp, then set up tinycloud-mcp as a stdio server in your MCP client.");
  expect(llmsText).not.toContain("/chatgpt/mcp");
  expect(llmsText).not.toContain("Details: TC-1362");
  const robotsText = await robots.text();
  expect(robotsText).toContain("Allow: /");
  expect(robotsText).toContain("Agentmap: https://mcp.test/.well-known/ai-catalog.json");
  expect(await sitemap.text()).toContain("<loc>https://mcp.test/</loc>");
});

test("root OAuth Protected Resource Metadata alias matches the path-specific document", async () => {
  const app = await testApp();
  const protectedResource = await app.fetch(request("/.well-known/oauth-protected-resource/mcp"));
  const alias = await app.fetch(request("/.well-known/oauth-protected-resource", {
    headers: { origin: "https://isitagentready.com" },
  }));
  const metadataPreflight = await app.fetch(request("/.well-known/oauth-protected-resource", {
    method: "OPTIONS",
    headers: {
      origin: "https://isitagentready.com",
      "access-control-request-method": "GET",
      "access-control-request-headers": "content-type",
    },
  }));

  expect(alias.status).toBe(200);
  const metadata = await alias.json();
  expect(metadata).toEqual(await protectedResource.json());
  expect(metadata).toMatchObject({
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://openkey.test/api/auth"],
    scopes_supported: ["tinycloud:mcp"],
    bearer_methods_supported: ["header"],
  });
  expect(alias.headers.get("access-control-allow-origin")).toBe("*");
  expect(metadataPreflight.status).toBe(204);
  expect(metadataPreflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(metadataPreflight.headers.get("access-control-allow-headers")).toContain("content-type");
});

test("serves the current MCP Server Card with only supported CORS methods", async () => {
  const app = await testApp();
  const card = await app.fetch(request("/mcp/server-card", { headers: { origin: "https://scanner.example" } }));
  const wellKnownCard = await app.fetch(request("/.well-known/mcp/server-card.json", {
    headers: { origin: "https://scanner.example" },
  }));
  const cardPreflight = await app.fetch(request("/.well-known/mcp/server-card.json", {
    method: "OPTIONS",
    headers: {
      origin: "https://isitagentready.com",
      "access-control-request-method": "GET",
      "access-control-request-headers": "accept",
    },
  }));

  expect(card.status).toBe(200);
  expect(card.headers.get("access-control-allow-origin")).toBe("*");
  expect(wellKnownCard.headers.get("access-control-allow-origin")).toBe("*");
  const cardDocument = await card.json();
  expect(await wellKnownCard.json()).toEqual(cardDocument);
  expect(cardDocument).toMatchObject({
    name: `xyz.tinycloud/${MCP_SERVER_NAME}`,
    version: MCP_VERSION,
    remotes: [{ type: "streamable-http", url: "https://mcp.test/mcp" }],
  });
  expect(cardDocument).not.toHaveProperty("serverInfo");
  expect(cardDocument).not.toHaveProperty("endpoint");
  expect(cardDocument).not.toHaveProperty("capabilities");
  expect(cardPreflight.status).toBe(204);
  expect(cardPreflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(cardPreflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  expect(cardPreflight.headers.get("access-control-allow-headers")).toBe("accept");
});

test("serves the checker-required AI Catalog manifest and discovery links", async () => {
  const app = await testApp();
  const catalog = await app.fetch(request("/.well-known/ai-catalog.json", {
    headers: { origin: "https://isitagentready.com" },
  }));
  const preflight = await app.fetch(request("/.well-known/ai-catalog.json", {
    method: "OPTIONS",
    headers: {
      origin: "https://isitagentready.com",
      "access-control-request-method": "GET",
      "access-control-request-headers": "accept",
    },
  }));

  expect(catalog.status).toBe(200);
  expect(catalog.headers.get("content-type")).toContain("application/json");
  expect(catalog.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  expect(await catalog.json()).toEqual({
    specVersion: "1.0",
    host: {
      displayName: "TinyCloud, Inc.",
      identifier: "https://mcp.tinycloud.xyz",
      documentationUrl: "https://docs.tinycloud.xyz/cli/mcp",
    },
    entries: [{
      identifier: "urn:air:tinycloud.xyz:mcp:tinycloud-mcp",
      displayName: "TinyCloud MCP",
      type: "application/json",
      description: "Hosted Streamable HTTP MCP server for delegated TinyCloud operations.",
      url: "https://mcp.test/.well-known/mcp/server-card.json",
      representativeQueries: [
        "How do I connect to TinyCloud's hosted MCP server?",
        "Which endpoint provides TinyCloud's delegated MCP operations?",
        "How can I connect to TinyCloud MCP using local stdio?",
      ],
    }],
  });
});

test("serves a truthful website-only Personal Agent Protocol document", async () => {
  const app = await testApp();
  const response = await app.fetch(request("/.well-known/poppy.json", {
    headers: { origin: "https://isitagentready.com" },
  }));
  const preflight = await app.fetch(request("/.well-known/poppy.json", {
    method: "OPTIONS",
    headers: {
      origin: "https://isitagentready.com",
      "access-control-request-method": "GET",
    },
  }));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(await response.json()).toEqual({
    protocol_version: "0.1",
    organization: {
      name: "TinyCloud, Inc.",
      domain: "mcp.test",
    },
    web: {},
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
});

test("publishes truthful OAuth discovery in auth.md without an agent enrollment endpoint", async () => {
  const app = await testApp();
  const response = await app.fetch(request("/auth.md", {
    headers: { origin: "https://isitagentready.com" },
  }));
  const preflight = await app.fetch(request("/auth.md", {
    method: "OPTIONS",
    headers: {
      origin: "https://isitagentready.com",
      "access-control-request-method": "GET",
      "access-control-request-headers": "accept",
    },
  }));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/markdown");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  const authDoc = await response.text();
  expect(authDoc).toContain("# TinyCloud MCP auth.md");
  expect(authDoc).toContain("https://mcp.test/.well-known/oauth-protected-resource");
  expect(authDoc).toContain("https://openkey.test/.well-known/oauth-authorization-server/api/auth");
  expect(authDoc).toContain("Authorization: Bearer");
  expect(authDoc).toContain("No `agent_auth` registration block is published");
  expect(authDoc).not.toContain("register_uri:");
  expect(authDoc).not.toContain("/chatgpt/mcp");
  expect(authDoc).not.toContain("Details: TC-1362");
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
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

test("public plugin discovery and challenges bind the distinct resource audience", async () => {
  const app = await testApp();
  const metadata = await app.fetch(request("/.well-known/oauth-protected-resource/chatgpt/mcp"));
  expect(metadata.status).toBe(200);
  const metadataDocument = await metadata.json() as Record<string, unknown>;
  expect(metadataDocument).toMatchObject({
    resource: "https://mcp.test/chatgpt/mcp",
    authorization_servers: ["https://openkey.test/api/auth"],
    scopes_supported: ["tinycloud:mcp"],
  });
  expect(metadataDocument.bearer_methods_supported).toBeUndefined();
  const unauthenticated = await app.fetch(request("/chatgpt/mcp", { method: "POST" }));
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get("www-authenticate")).toContain(
    'resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/chatgpt/mcp"',
  );
});

test("invalid browser approvals return an inert page without reflecting state", async () => {
  const app = await testApp();
  const response = await app.fetch(request(`/chatgpt/connect?state=${encodeURIComponent(`<script>${CANARY}</script>`)}`, {
    headers: { accept: "text/html" },
  }));
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.text()).not.toContain(CANARY);
  const machine = await app.fetch(request("/chatgpt/connect", { headers: { accept: "application/json" } }));
  expect(machine.status).toBe(400);
  expect(machine.headers.get("content-type")).toContain("application/json");
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
  const store = siblingStore(stateDir);
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
    "[tinycloud-mcp-http] connect callback rejected: stage=restore_approval code=AUTH_EXPIRED detail=none\n",
    "[tinycloud-mcp-http] connect callback rejected: stage=restore_approval code=CALLBACK_INCOMPLETE detail=none\n",
    "[tinycloud-mcp-http] connect callback rejected: stage=unknown code=UNKNOWN detail=body_invalid\n",
  ]);
  for (const secret of secrets) expect(diagnostics.join("")).not.toContain(secret);
});

test("pre-restore refusals log a distinct detail behind one uniform response", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-http-"));
  const app = await testApp(stateDir);
  const store = siblingStore(stateDir);
  const stateFor = async (subject: string, ttlStore = store) =>
    new URL((await ttlStore.connectStatus(subject)).approvalUrl!).searchParams.get("state")!;
  const valid = await stateFor("openkey-user-a");
  const expired = await stateFor("openkey-user-expired", siblingStore(stateDir, 0));
  const used = await stateFor("openkey-user-used");
  await rm(join(store.tenantStateRoot("openkey-user-used"), ".tinycloud/profiles/agent/pending", `${used.split(".")[1]}.json`));
  const orphaned = await stateFor("openkey-user-orphaned");
  await rm(join(store.tenantStateRoot("openkey-user-orphaned"), ".tinycloud/profiles/agent/key.json"));
  // A reset state volume: the whole tenant directory, pending file included, is gone.
  const wiped = await stateFor("openkey-user-wiped");
  await rm(store.tenantStateRoot("openkey-user-wiped"), { recursive: true });
  const [tenantId, nonce] = valid.split(".");
  const cases: Array<{ state?: string; body: string; detail: string }> = [
    { body: JSON.stringify({ token: CANARY }), detail: "state_missing" },
    { state: `${tenantId}.${nonce}.${CANARY}`, body: "{}", detail: "state_invalid" },
    { state: `${CANARY}.${"a".repeat(512)}`, body: "{}", detail: "state_invalid" },
    { state: expired, body: JSON.stringify({ token: CANARY }), detail: "state_expired" },
    // The first attempt deleted the expired pending file, so a retry is not proof of replay.
    { state: expired, body: JSON.stringify({ token: CANARY }), detail: "state_not_pending" },
    { state: used, body: JSON.stringify({ token: CANARY }), detail: "state_not_pending" },
    { state: orphaned, body: JSON.stringify({ token: CANARY }), detail: "tenant_missing" },
    { state: wiped, body: JSON.stringify({ token: CANARY }), detail: "tenant_missing" },
    { state: valid, body: `{"token":"${CANARY}"`, detail: "body_invalid" },
    { state: valid, body: JSON.stringify([CANARY]), detail: "body_invalid" },
    { state: valid, body: JSON.stringify({ token: CANARY.repeat(20_000) }), detail: "body_invalid" },
  ];

  const diagnostics: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk));
    return true;
  });
  const responses: string[] = [];
  try {
    for (const { state, body } of cases) {
      const query = state === undefined ? "" : `?state=${encodeURIComponent(state)}`;
      const response = await app.fetch(request(`/connect/callback${query}`, {
        method: "POST",
        headers: { origin: "https://openkey.test", "content-type": "application/json" },
        body,
      }));
      expect(response.status).toBe(400);
      responses.push(await response.text());
    }
  } finally {
    stderr.mockRestore();
  }

  expect(responses).toEqual(cases.map(() => JSON.stringify({ error: "unknown", code: "UNKNOWN", message: MESSAGE })));
  expect(diagnostics).toEqual(cases.map(({ detail }) =>
    `[tinycloud-mcp-http] connect callback rejected: stage=unknown code=UNKNOWN detail=${detail}\n`));
  for (const text of [...responses, ...diagnostics]) {
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(nonce!);
  }
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

/** A second store over the hosted app's state mints the approval links the app reads. */
function siblingStore(stateDir: string, approvalTtlSeconds = 300): RemoteTenantStore {
  return new RemoteTenantStore({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds,
    delegationExpiry: "1h",
  });
}

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
