import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createHostedMcpApp, type HostedMcpApp, type HostedMcpConfig } from "./http.js";
import { rateLimitFromEnv, type RateLimitConfig } from "./rate-limit.js";
import { registerMcpFixtureServer, resetMcpRegistryFixture } from "./test-support/registry-fixture.mjs";

const resources: Array<() => Promise<void>> = [];

// Each test boots a hosted app and a real MCP client; CI runners are slower than bun's 5 second default.
setDefaultTimeout(60_000);

afterEach(async () => {
  try {
    await Promise.all(resources.splice(0).reverse().map((dispose) => dispose()));
  } finally {
    resetMcpRegistryFixture();
  }
});

// Slow refill, so a test never waits for a bucket to recover.
const LIMITS: RateLimitConfig = {
  tools: { connect: { perMinute: 1, burst: 1 }, read: { perMinute: 1, burst: 2 }, write: { perMinute: 1, burst: 1 } },
  subjectRequests: { perMinute: 1000, burst: 1000 },
  client: { perMinute: 1000, burst: 1000 },
  ip: { perMinute: 1, burst: 2 },
  trustedProxyHops: 1,
};

async function start(rateLimit: RateLimitConfig | undefined, extra: Partial<HostedMcpConfig> = {}) {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "EdDSA";
  const jwks = await serveJwks(jwk);
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-rate-limit-"));
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
      jwks_uri: jwks,
      registration_endpoint: "https://openkey.test/api/auth/oauth2/register",
      response_types_supported: ["code"],
    },
    ...(rateLimit === undefined ? {} : { rateLimit }),
    ...extra,
  });
  resources.push(() => app.close());

  const tokenFor = (subject: string, clientId = "chatgpt") => new SignJWT({
    scope: "openid tinycloud:mcp",
    azp: clientId,
    "https://tinycloud.xyz/owner_dids": [`did:pkh:eip155:1:0x${(subject === "bob" ? "2" : "1").repeat(40)}`],
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer("https://openkey.test/api/auth")
    .setSubject(subject)
    .setAudience("https://mcp.test/mcp")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const connect = async (subject: string, clientId?: string): Promise<Client> => {
    const token = await tokenFor(subject, clientId);
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.test/mcp"), {
      authProvider: { token: async () => token },
      fetch: (input, init) => hostedFetch(app, input, init),
    });
    const client = new Client({ name: "rate-limit-test", version: "1.0.0" });
    await client.connect(transport);
    resources.push(() => client.close());
    return client;
  };
  return { app, connect, tokenFor };
}

// A call with arguments the tool rejects never reaches the limiter, so write tests send valid ones.
const KV_PUT = { space: "default", key: "rate-limit-test", mode: "upsert", content: { encoding: "utf8", value: "x" } };

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const error = (result.structuredContent as { error?: { code?: string; retryable?: boolean } } | undefined)?.error;
  return { limited: result.isError === true && error?.code === "RATE_LIMITED", error, result };
}

test("limits are off unless configured", async () => {
  const { connect } = await start(undefined);
  const client = await connect("alice");
  for (let index = 0; index < 30; index += 1) expect((await call(client, "tinycloud_status")).limited).toBe(false);
});

test("a tool class is refused once its burst is spent, as a retryable tool error the model can read", async () => {
  const { connect } = await start(LIMITS);
  const client = await connect("alice");
  expect((await call(client, "tinycloud_status")).limited).toBe(false);
  expect((await call(client, "tinycloud_auth_status")).limited).toBe(false);
  const refused = await call(client, "tinycloud_status");
  expect(refused.limited).toBe(true);
  expect(refused.error?.retryable).toBe(true);
  expect(JSON.stringify(refused.result)).toMatch(/wait|seconds/i);
});

test("each class has its own bucket: spent reads leave writes and connect available", async () => {
  const { connect } = await start(LIMITS);
  const client = await connect("alice");
  await call(client, "tinycloud_status");
  await call(client, "tinycloud_status");
  expect((await call(client, "tinycloud_status")).limited).toBe(true);
  expect((await call(client, "tinycloud_kv_put", KV_PUT)).limited).toBe(false);
  expect((await call(client, "tinycloud_kv_put", KV_PUT)).limited).toBe(true);
  expect((await call(client, "tinycloud_connect")).limited).toBe(false);
  expect((await call(client, "tinycloud_connect")).limited).toBe(true);
});

test("one user's flood does not touch another user, even through the same OAuth client", async () => {
  const { connect } = await start(LIMITS);
  const alice = await connect("alice", "chatgpt");
  const bob = await connect("bob", "chatgpt");
  await call(alice, "tinycloud_status");
  await call(alice, "tinycloud_status");
  expect((await call(alice, "tinycloud_status")).limited).toBe(true);
  expect((await call(bob, "tinycloud_status")).limited).toBe(false);
});

test("the per-subject request ceiling answers 429 with Retry-After before any tool runs", async () => {
  const { app, tokenFor } = await start({ ...LIMITS, subjectRequests: { perMinute: 1, burst: 2 } });
  const token = await tokenFor("alice");
  const post = () => hostedFetch(app, "https://mcp.test/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect((await post()).status).not.toBe(429);
  expect((await post()).status).not.toBe(429);
  const refused = await post();
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  expect(await refused.json()).toMatchObject({ error: "rate_limited" });
  const other = await hostedFetch(app, "https://mcp.test/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${await tokenFor("bob")}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(other.status).not.toBe(429);
});

test("approval routes are limited per client address, and a forged left-hand address does not buy a fresh budget", async () => {
  const { app } = await start(LIMITS);
  const get = (forwarded: string) => hostedFetch(app, "https://mcp.test/connect?state=missing", {
    headers: { "x-forwarded-for": forwarded },
  });
  expect((await get("198.51.100.1")).status).not.toBe(429);
  expect((await get("198.51.100.1")).status).not.toBe(429);
  const refused = await get("198.51.100.1");
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).not.toBeNull();
  // The proxy appends the real address on the right; a different value on the left is ignored.
  expect((await get("6.6.6.6, 198.51.100.1")).status).toBe(429);
  expect((await get("198.51.100.2")).status).not.toBe(429);
});

test("rejected bearer tokens cost their address, while a request with no token does not", async () => {
  const { app } = await start(LIMITS);
  const attempt = (headers: Record<string, string>) => hostedFetch(app, "https://mcp.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const address = { "x-forwarded-for": "203.0.113.50" };
  for (let index = 0; index < 5; index += 1) expect((await attempt(address)).status).toBe(401);
  const bad = { ...address, authorization: "Bearer not-a-token" };
  expect((await attempt(bad)).status).toBe(401);
  expect((await attempt(bad)).status).toBe(401);
  const refused = await attempt(bad);
  expect(refused.status).toBe(429);
  expect((await attempt({ "x-forwarded-for": "203.0.113.51", authorization: "Bearer not-a-token" })).status).toBe(401);
});

test("50 bad tokens sent at once cost only their address's burst; the rest are refused before any lookup finishes", async () => {
  const { app } = await start(LIMITS);
  const attempt = (headers: Record<string, string>) => hostedFetch(app, "https://mcp.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => attempt({
    "x-forwarded-for": "203.0.113.60",
    authorization: `Bearer not-a-token-${index}`,
  })));
  const statuses = responses.map((response) => response.status);
  // LIMITS.ip is a burst of 2: charged before the lookup, so concurrency cannot buy more than that.
  expect(statuses.filter((status) => status === 401)).toHaveLength(2);
  expect(statuses.filter((status) => status === 429)).toHaveLength(48);
});

test("a valid token is not charged to its address, so users behind one shared address are not throttled", async () => {
  const { app, tokenFor } = await start(LIMITS);
  const token = await tokenFor("alice");
  const post = () => hostedFetch(app, "https://mcp.test/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-forwarded-for": "203.0.113.61",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  // More valid requests than the address burst of 2, one by one and then all at once.
  for (let index = 0; index < 6; index += 1) expect((await post()).status).not.toBe(429);
  const together = await Promise.all(Array.from({ length: 2 }, post));
  expect(together.map((response) => response.status)).not.toContain(429);
  // And the address still has its whole budget for bad tokens afterwards.
  const bad = { "x-forwarded-for": "203.0.113.61", authorization: "Bearer not-a-token" };
  const attempt = () => hostedFetch(app, "https://mcp.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...bad },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect((await attempt()).status).toBe(401);
  expect((await attempt()).status).toBe(401);
  expect((await attempt()).status).toBe(429);
});

test("an OpenKey introspection outage is a 500, not a bad token: the address is not charged for it", async () => {
  const { app, tokenFor } = await start(LIMITS, {
    introspection: {
      endpoint: "https://openkey.test/api/auth/oauth2/introspect",
      clientId: "mcp-client",
      clientSecret: "secret",
      authMethod: "basic",
      fetch: async () => new Response("unavailable", { status: 503 }),
      log: () => undefined,
    },
  });
  const token = await tokenFor("alice");
  const attempt = (authorization: string) => hostedFetch(app, "https://mcp.test/mcp", {
    method: "POST",
    headers: {
      authorization,
      "x-forwarded-for": "203.0.113.62",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  // More outage answers than the address burst of 2: each is a server error, never a 429.
  for (let index = 0; index < 4; index += 1) expect((await attempt(`Bearer ${token}`)).status).toBe(500);
  // The address still has its whole bad-token budget.
  expect((await attempt("Bearer not-a-token")).status).toBe(401);
  expect((await attempt("Bearer not-a-token")).status).toBe(401);
  expect((await attempt("Bearer not-a-token")).status).toBe(429);
});

describe("trusted proxy hops from the environment", () => {
  // An address burst of 1, so a single charged request would empty an address's bucket.
  const fromEnv = (extra: Record<string, string> = {}) =>
    rateLimitFromEnv({ TC_MCP_RATE_LIMIT: "on", TC_MCP_RATE_LIMIT_IP_PER_MINUTE: "1", ...extra })!;
  const badToken = (app: HostedMcpApp, forwarded?: string) => hostedFetch(app, "https://mcp.test/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer not-a-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(forwarded === undefined ? {} : { "x-forwarded-for": forwarded }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const connectPage = (app: HostedMcpApp, forwarded?: string) => hostedFetch(app, "https://mcp.test/connect?state=missing", {
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  });

  test("unset, address limits are off: rotating X-Forwarded-For and bad tokens never get an address 429", async () => {
    const config = fromEnv();
    expect(config.trustedProxyHops).toBe(0);
    const { app } = await start(config);
    for (let index = 0; index < 5; index += 1) {
      expect((await badToken(app, `198.51.100.${index}`)).status).toBe(401);
      expect((await badToken(app, "198.51.100.200")).status).toBe(401);
      expect((await connectPage(app, `198.51.100.${index}`)).status).not.toBe(429);
    }
    // A client that sends no X-Forwarded-For is not locked out by the failures above, nor by its own.
    for (let index = 0; index < 3; index += 1) {
      expect((await badToken(app)).status).toBe(401);
      expect((await connectPage(app)).status).not.toBe(429);
    }
  });

  test("set to 1, address limits apply as before", async () => {
    const config = fromEnv({ TC_MCP_TRUSTED_PROXY_HOPS: "1" });
    expect(config.trustedProxyHops).toBe(1);
    const { app } = await start(config);
    expect((await badToken(app, "198.51.100.1")).status).toBe(401);
    expect((await badToken(app, "198.51.100.1")).status).toBe(429);
    expect((await badToken(app, "6.6.6.6, 198.51.100.1")).status).toBe(429);
    expect((await badToken(app, "198.51.100.2")).status).toBe(401);
    expect((await connectPage(app, "198.51.100.3")).status).not.toBe(429);
    expect((await connectPage(app, "198.51.100.3")).status).toBe(429);
  });
});

async function hostedFetch(app: HostedMcpApp, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
  const headers = new Headers(request.headers);
  headers.set("host", "mcp.test");
  return app.fetch(new Request(request, { headers }));
}

async function serveJwks(jwk: object): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  resources.push(() => closeServer(server));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("JWKS server did not start.");
  registerMcpFixtureServer(server);
  return `http://127.0.0.1:${address.port}/jwks`;
}

function closeServer(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => error ? reject(error) : resolve());
  return promise;
}
