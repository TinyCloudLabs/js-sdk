import { afterEach, expect, test } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createServer, type Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";
import { OTHER_OWNER_KEY, openKeyCallbackBody } from "./test-support/openkey-callback.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).reverse().map((dispose) => dispose()));
});

test("official Streamable HTTP client authenticates and starts delegated setup", async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "EdDSA";
  const jwksServer = await serveJwks(publicJwk);
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-e2e-"));
  resources.push(() => rm(stateDir, { recursive: true, force: true }));

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
      jwks_uri: jwksServer,
      registration_endpoint: "https://openkey.test/api/auth/oauth2/register",
      response_types_supported: ["code"],
    },
  });
  resources.push(() => app.close());

  const token = await new SignJWT({
    scope: "openid tinycloud:mcp",
    azp: "claude-test",
    "https://tinycloud.xyz/owner_dids": [
      "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
    ],
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer("https://openkey.test/api/auth")
    .setSubject("openkey-user-1")
    .setAudience("https://mcp.test/mcp")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.test/mcp"), {
    authProvider: { token: async () => token },
    fetch: (input, init) => hostedFetch(app, input, init),
  });
  const client = new Client({ name: "hosted-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  resources.push(() => client.close());

  const tools = await client.listTools();
  expect(tools.tools).toHaveLength(17);
  expect(tools.tools.map((tool) => tool.name)).toContain("tinycloud_connect");

  const result = await client.callTool({ name: "tinycloud_connect", arguments: {} });
  const structured = result.structuredContent;
  const approvalUrl = typeof structured === "object" && structured !== null && "approvalUrl" in structured
    ? String(structured.approvalUrl)
    : "";
  expect(result.structuredContent).toMatchObject({
    connected: false,
    sessionDid: expect.stringMatching(/^did:key:/),
    approvalUrl: expect.stringMatching(/^https:\/\/mcp\.test\/connect\?state=/),
  });

  // Another wallet approving this tenant's link gets a fixed refusal.
  const [tenantId] = await readdir(join(stateDir, "tenants"));
  const foreign = await openKeyCallbackBody({
    tenantStateRoot: join(stateDir, "tenants", tenantId!),
    privateKey: OTHER_OWNER_KEY,
    space: "account",
    abilities: { kv: { "spaces/": ["tinycloud.kv/get", "tinycloud.kv/list"] } },
  });
  const state = new URL(approvalUrl).searchParams.get("state")!;
  const callback = await hostedFetch(app, `https://mcp.test/connect/callback?state=${encodeURIComponent(state)}`, {
    method: "POST",
    headers: { origin: "https://openkey.test", "content-type": "application/json" },
    body: JSON.stringify({ ...foreign, note: "<script>untrusted</script>" }),
  });
  expect(callback.status).toBe(403);
  expect(callback.headers.get("access-control-allow-origin")).toBe("https://openkey.test");
  expect(await callback.json()).toEqual({
    error: "This approval link was requested by a different TinyCloud account, so the delegation was not stored.",
    code: "approval_owner_mismatch",
  });
});

async function hostedFetch(
  app: HostedMcpApp,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const request = input instanceof Request
    ? new Request(input, init)
    : new Request(input.toString(), init);
  const headers = new Headers(request.headers);
  headers.set("host", "mcp.test");
  return app.fetch(new Request(request, { headers }));
}

async function serveJwks(jwk: object): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push(() => closeServer(server));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("JWKS server did not start.");
  return `http://127.0.0.1:${address.port}/jwks`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
