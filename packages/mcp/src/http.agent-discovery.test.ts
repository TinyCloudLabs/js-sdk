import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";
import { resetMcpRegistryFixture } from "./test-support/registry-fixture.mjs";

const directories: string[] = [];
const apps: HostedMcpApp[] = [];

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  } finally {
    resetMcpRegistryFixture();
  }
});

test("the RFC 9727 API catalog lists /mcp with links that resolve on this server", async () => {
  const app = await testApp();
  const catalog = await app.fetch(request("/.well-known/api-catalog", {
    headers: { origin: "https://isitagentready.com", accept: "application/linkset+json" },
  }));
  const head = await app.fetch(request("/.well-known/api-catalog", { method: "HEAD" }));
  const landing = await app.fetch(request("/"));

  expect(catalog.status).toBe(200);
  expect(catalog.headers.get("content-type"))
    .toBe('application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"');
  expect(catalog.headers.get("access-control-allow-origin")).toBe("*");
  const { linkset } = await catalog.json() as {
    linkset: Array<Record<string, string | Array<{ href: string; type: string }>>>;
  };
  expect(linkset).toHaveLength(1);
  const [entry] = linkset as [Record<string, Array<{ href: string; type: string }>> & { anchor: string }];
  expect(entry.anchor).toBe("https://mcp.test/mcp");
  const card = await app.fetch(request(new URL(entry["service-desc"]![0]!.href).pathname));
  expect(card.status).toBe(200);
  expect(await card.json()).toMatchObject({ remotes: [{ url: entry.anchor }] });
  const health = await app.fetch(request(new URL(entry.status![0]!.href).pathname));
  expect(await health.json()).toEqual({ ok: true });
  expect(entry["service-doc"]![0]!.href).toBe("https://docs.tinycloud.xyz/cli/mcp");

  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toStartWith("application/linkset+json");
  expect(await head.text()).toBe("");
  expect(landing.headers.get("link")).toContain('<https://mcp.test/.well-known/api-catalog>; rel="api-catalog"');
});

test("the Agent Skills index lists the shipped skill with a digest of the served bytes", async () => {
  const app = await testApp();
  const response = await app.fetch(request("/.well-known/agent-skills/index.json", {
    headers: { origin: "https://isitagentready.com" },
  }));

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  const index = await response.json() as {
    $schema: string;
    skills: Array<{ name: string; type: string; description: string; url: string; digest: string }>;
  };
  expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
  expect(index.skills).toHaveLength(1);
  const [skill] = index.skills as [typeof index.skills[number]];
  expect(skill.type).toBe("skill-md");
  expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);

  const file = await app.fetch(request(new URL(skill.url).pathname));
  expect(file.status).toBe(200);
  expect(file.headers.get("content-type")).toContain("text/markdown");
  const bytes = new Uint8Array(await file.arrayBuffer());
  expect(skill.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  const frontmatter = new TextDecoder().decode(bytes).split("---\n")[1]!;
  expect(frontmatter).toContain(`name: ${skill.name}\n`);
  expect(frontmatter).toContain(`description: ${skill.description}\n`);
});

test("the A2A agent card location sends agents to TinyCloud's A2A discovery agent", async () => {
  const app = await testApp();
  const response = await app.fetch(request("/.well-known/agent-card.json"));

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://tinycloud.xyz/.well-known/agent-card.json");
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
});

test("the landing page registers a read-only WebMCP tool that returns this server's connection details", async () => {
  const app = await testApp();
  const landing = await app.fetch(request("/"));
  const html = await landing.text();
  const scriptPath = /<script src="([^"]+)" defer><\/script>/.exec(html)?.[1];
  expect(scriptPath).toBe("/webmcp.js");
  expect(landing.headers.get("content-security-policy")).toContain("script-src 'self'");
  const script = await app.fetch(request(scriptPath!));
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toContain("text/javascript");

  const registered: Array<{
    name: string;
    inputSchema: unknown;
    annotations: { readOnlyHint: boolean };
    execute: (input: unknown) => { structuredContent: Record<string, unknown> };
  }> = [];
  const scriptText = await script.text();
  runInNewContext(scriptText, {
    document: { modelContext: { registerTool: (tool: typeof registered[number]) => registered.push(tool) } },
    navigator: {},
  });

  expect(registered).toHaveLength(1);
  const [tool] = registered as [typeof registered[number]];
  expect(tool.name).toBe("get_tinycloud_mcp_connection");
  expect(tool.annotations.readOnlyHint).toBe(true);
  expect(tool.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  const connection = tool.execute({}).structuredContent as {
    endpoint: string;
    authorization: { protectedResourceMetadata: string; authorizationServer: string; scope: string };
  };
  expect(connection.endpoint).toBe("https://mcp.test/mcp");
  const metadata = await app.fetch(request(new URL(connection.authorization.protectedResourceMetadata).pathname));
  expect(await metadata.json()).toMatchObject({
    resource: connection.endpoint,
    authorization_servers: [connection.authorization.authorizationServer],
    scopes_supported: [connection.authorization.scope],
  });
});

test("robots.txt declares the same Content Signals as tinycloud.xyz", async () => {
  const app = await testApp();
  const robots = await (await app.fetch(request("/robots.txt"))).text();

  expect(robots).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=no\n");
});

async function testApp(): Promise<HostedMcpApp> {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-discovery-"));
  directories.push(stateDir);
  const app = createHostedMcpApp({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
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
