import { afterEach, expect, test } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";

const FOREIGN_ORIGINS = [
  "https://grok.com",
  "https://meta.ai",
  "https://gemini.google.com",
  "https://anything.example",
  "http://localhost:5173",
  "null",
];

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).reverse().map((dispose) => dispose()));
});

test("a call from any Origin without a token is a 401 bearer challenge, never a 403 or a 200", async () => {
  const { app } = await hostedApp();
  for (const origin of FOREIGN_ORIGINS) {
    const response = await app.fetch(mcpRequest({ method: "POST", origin }));
    expect({ origin, status: response.status }).toEqual({ origin, status: 401 });
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain('resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"');
    expectNoCredentialedCors(response);
    expect(exposedHeaders(response)).toContain("www-authenticate");
  }
});

test("a foreign Origin with an invalid token is refused as invalid_token, not as a bad Origin", async () => {
  const { app } = await hostedApp();
  const response = await app.fetch(mcpRequest({
    method: "POST",
    origin: "https://anything.example",
    headers: { authorization: "Bearer not-a-real-token" },
  }));
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  expectNoCredentialedCors(response);
});

test("a foreign Origin with a valid token reaches the MCP server", async () => {
  const { app, signToken } = await hostedApp();
  const token = await signToken();
  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.test/mcp"), {
    authProvider: { token: async () => token },
    fetch: async (input, init) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const headers = new Headers(request.headers);
      headers.set("host", "mcp.test");
      headers.set("origin", "https://gemini.google.com");
      const response = await app.fetch(new Request(request, { headers }));
      expectNoCredentialedCors(response);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      return response;
    },
  });
  const client = new Client({ name: "foreign-origin-test", version: "1.0.0" });
  await client.connect(transport);
  resources.push(() => client.close());
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toContain("tinycloud_connect");
});

test("a preflight from any Origin is answered without a token, allows a fixed header list and no credentials", async () => {
  const { app } = await hostedApp();
  for (const origin of FOREIGN_ORIGINS) {
    const response = await app.fetch(mcpRequest({
      method: "OPTIONS",
      origin,
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "authorization, content-type, mcp-protocol-version, x-tinycloud-service-credential, x-tinycloud-owner-did",
      },
    }));
    expect({ origin, status: response.status }).toEqual({ origin, status: 204 });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    const allowed = (response.headers.get("access-control-allow-headers") ?? "").split(",").map((name) => name.trim().toLowerCase());
    expect(allowed.sort()).toEqual([
      "accept", "authorization", "content-type", "last-event-id",
      "mcp-method", "mcp-name", "mcp-protocol-version", "mcp-session-id",
    ]);
    expectNoCredentialedCors(response);
  }
});

test("a browser client can read the session and protocol-version headers, on the preflight and on real responses", async () => {
  const { app, signToken } = await hostedApp();
  const token = await signToken();
  const wanted = ["mcp-protocol-version", "mcp-session-id", "www-authenticate"];
  const preflight = await app.fetch(mcpRequest({
    method: "OPTIONS",
    origin: "https://claude.ai",
    headers: { "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, mcp-session-id" },
  }));
  expect(exposedHeaders(preflight)).toEqual(wanted);

  const initialize = await app.fetch(new Request("https://mcp.test/mcp", {
    method: "POST",
    headers: {
      host: "mcp.test",
      origin: "https://claude.ai",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "browser-test", version: "1.0.0" } },
    }),
  }));
  expect(initialize.status).toBe(200);
  expect(exposedHeaders(initialize)).toEqual(wanted);
  // Whatever MCP header the server sets on this response must be one a script is allowed to read.
  for (const name of initialize.headers.keys()) {
    if (name.startsWith("mcp-")) expect(exposedHeaders(initialize)).toContain(name);
  }
});

test("responses whose CORS depends on the Origin say so with Vary: Origin", async () => {
  const { app } = await hostedApp();
  for (const origin of [undefined, "https://anything.example"]) {
    const headers: Record<string, string> = { host: "mcp.test" };
    if (origin !== undefined) headers.origin = origin;
    const response = await app.fetch(new Request("https://mcp.test/mcp", { method: "POST", headers }));
    expect({ origin, vary: response.headers.get("vary") }).toEqual({ origin, vary: expect.stringMatching(/(^|,\s*)Origin(,|$)/) });
  }
});

test("an Origin with the correct native service credential is refused on /mcp and /native/grant, without CORS headers", async () => {
  const credential = "native-origin-test-credential-with-enough-entropy";
  const { app } = await hostedApp(credential);
  const native = {
    host: "mcp.test",
    "content-type": "application/json",
    "x-tinycloud-service-credential": credential,
    "x-tinycloud-owner-did": "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
  };
  for (const path of ["/mcp", "/native/grant"]) {
    // Control: the same request without an Origin gets past the Origin check; the grant is what is missing.
    const direct = await app.fetch(new Request(`https://mcp.test${path}`, { method: "POST", headers: native, body: "{}" }));
    expect({ path, status: direct.status }).toEqual({ path, status: 401 });
    for (const origin of [...FOREIGN_ORIGINS, "https://openkey.test"]) {
      const response = await app.fetch(new Request(`https://mcp.test${path}`, {
        method: "POST",
        headers: { ...native, origin },
        body: "{}",
      }));
      expect({ path, origin, status: response.status }).toEqual({ path, origin, status: 403 });
      expect(await response.json()).toEqual({ error: "native_service_unauthorized" });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expectNoCredentialedCors(response);
    }
  }
});

function expectNoCredentialedCors(response: Response): void {
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("access-control-allow-origin")).not.toBe("null");
}

function mcpRequest(options: { method: string; origin: string; headers?: Record<string, string> }): Request {
  return new Request("https://mcp.test/mcp", {
    method: options.method,
    headers: { host: "mcp.test", origin: options.origin, ...options.headers },
  });
}

async function hostedApp(
  nativeServiceCredential?: string,
): Promise<{ app: HostedMcpApp; signToken: () => Promise<string> }> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "EdDSA";
  const jwksUri = await serveJwks(publicJwk);
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-cors-"));
  resources.push(() => rm(stateDir, { recursive: true, force: true }));
  const app = createHostedMcpApp({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
    ...(nativeServiceCredential === undefined ? {} : { nativeServiceCredential }),
    oauthMetadata: {
      issuer: "https://openkey.test/api/auth",
      authorization_endpoint: "https://openkey.test/api/auth/oauth2/authorize",
      token_endpoint: "https://openkey.test/api/auth/oauth2/token",
      jwks_uri: jwksUri,
      registration_endpoint: "https://openkey.test/api/auth/oauth2/register",
      response_types_supported: ["code"],
    },
  });
  resources.push(() => app.close());
  return {
    app,
    signToken: () => new SignJWT({
      scope: "openid tinycloud:mcp",
      azp: "claude-test",
      "https://tinycloud.xyz/owner_dids": ["did:pkh:eip155:1:0x1111111111111111111111111111111111111111"],
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
      .setIssuer("https://openkey.test/api/auth")
      .setSubject("openkey-user-1")
      .setAudience("https://mcp.test/mcp")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey),
  };
}

async function serveJwks(jwk: object): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  resources.push(async () => {
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("JWKS server did not start.");
  return `http://127.0.0.1:${address.port}/jwks`;
}

function exposedHeaders(response: Response): string[] {
  return (response.headers.get("access-control-expose-headers") ?? "").split(",").map((name) => name.trim().toLowerCase()).sort();
}
