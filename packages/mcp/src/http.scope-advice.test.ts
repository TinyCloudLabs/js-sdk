import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SignJWT, exportJWK, generateKeyPair } from "jose";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";

// OpenKey issues a refresh token only when `offline_access` is granted, and a
// client takes its scope from the resource metadata and the 401 challenge. The
// connector therefore advertises `offline_access` but keeps requiring only
// `tinycloud:mcp`, so tokens issued before this change keep working.

const ADVERTISED = ["tinycloud:mcp", "offline_access"];
const SURFACES = ["/mcp", "/chatgpt/mcp", "/claude/mcp", "/grok/mcp", "/muse/mcp"];

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).reverse().map((dispose) => dispose()));
});

async function setup(): Promise<{ app: HostedMcpApp; sign: (scope: string, resourcePath: string) => Promise<string> }> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "EdDSA";
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

  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-scope-advice-"));
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
      jwks_uri: `http://127.0.0.1:${address.port}/jwks`,
      registration_endpoint: "https://openkey.test/api/auth/oauth2/register",
      response_types_supported: ["code"],
    },
  });
  resources.push(() => app.close());
  const sign = (scope: string, resourcePath: string): Promise<string> => new SignJWT({
    scope,
    azp: "grok-test",
    "https://tinycloud.xyz/owner_dids": ["did:pkh:eip155:1:0x1111111111111111111111111111111111111111"],
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer("https://openkey.test/api/auth")
    .setSubject("openkey-user-1")
    .setAudience(new URL(resourcePath, "https://mcp.test").toString())
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { app, sign };
}

// The Host header is not derived from the URL when a Request is built in-process.
function get(path: string): Request {
  return new Request(`https://mcp.test${path}`, { headers: { host: "mcp.test" } });
}

function post(path: string, token?: string): Request {
  return new Request(`https://mcp.test${path}`, {
    method: "POST",
    headers: {
      host: "mcp.test",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scope-test", version: "1.0.0" } },
    }),
  });
}

function challengeScope(response: Response): string | undefined {
  return /scope="([^"]*)"/.exec(response.headers.get("www-authenticate") ?? "")?.[1];
}

for (const path of SURFACES) {
  test(`${path} advertises offline_access in its metadata and 401 challenge`, async () => {
    const { app } = await setup();
    const metadataPath = path === "/mcp"
      ? "/.well-known/oauth-protected-resource/mcp"
      : `/.well-known/oauth-protected-resource${path}`;
    const metadata = await app.fetch(get(metadataPath));
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ scopes_supported: ADVERTISED });

    const unauthenticated = await app.fetch(post(path));
    expect(unauthenticated.status).toBe(401);
    expect(challengeScope(unauthenticated)).toBe(ADVERTISED.join(" "));
  });

  test(`${path} still accepts a token that holds only tinycloud:mcp`, async () => {
    const { app, sign } = await setup();
    for (const scope of ["tinycloud:mcp", "openid tinycloud:mcp", "openid tinycloud:mcp offline_access"]) {
      const response = await app.fetch(post(path, await sign(scope, path)));
      expect(response.status, scope).toBe(200);
    }
  });

  test(`${path} refuses a token without tinycloud:mcp even when it holds offline_access`, async () => {
    const { app, sign } = await setup();
    const response = await app.fetch(post(path, await sign("openid offline_access", path)));
    expect(response.status).toBe(403);
    expect(challengeScope(response)).toBe(ADVERTISED.join(" "));
  });
}
