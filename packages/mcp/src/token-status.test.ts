import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";
import { createOpenKeyTokenVerifier } from "./oauth.js";
import { createTokenStatusChecker } from "./token-status.js";

const home = await mkdtemp(join("/var/tmp", "tc1627."));
process.env.HOME = home;
if (!process.env.HOME?.startsWith("/var/tmp/tc1627.")) throw new Error("HOME is not isolated.");

const OWNER = "did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const ISSUER = "https://openkey.test/api/auth";
const INTROSPECTION = "https://openkey.test/api/auth/oauth2/introspect";
const servers: Server[] = [];
const apps: HostedMcpApp[] = [];
const directories: string[] = [home];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(1).map((path) => rm(path, { recursive: true, force: true })));
});

type Answer = "active" | "inactive" | "down" | "unauthorized" | "malformed";

interface StubOpenKey {
  answer: Answer;
  calls: Array<{ url: string; headers: Headers; body: URLSearchParams }>;
  fetch: typeof fetch;
}

/** A stub OpenKey introspection endpoint that records every request. */
function stubOpenKey(initial: Answer = "active"): StubOpenKey {
  const stub: StubOpenKey = {
    answer: initial,
    calls: [] as Array<{ url: string; headers: Headers; body: URLSearchParams }>,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      stub.calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: new URLSearchParams(String(init?.body)),
      });
      switch (stub.answer) {
        case "down": throw new TypeError("connection refused");
        case "unauthorized": return Response.json({ error: "invalid_client" }, { status: 401 });
        case "malformed": return Response.json({ status: "ok" });
        default: return Response.json({ active: stub.answer === "active" });
      }
    }) as typeof fetch,
  };
  return stub;
}

function checkerWith(stub: StubOpenKey, clock: { now: number }, authMethod: "basic" | "post" = "basic") {
  return createTokenStatusChecker({
    endpoint: INTROSPECTION,
    clientId: "mcp-client",
    clientSecret: "s3cret/+ value",
    authMethod,
    fetch: stub.fetch,
    now: () => clock.now,
  });
}

async function jwksServer(): Promise<{ jwksUri: string; sign: () => Promise<string> }> {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "EdDSA" };
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("JWKS server did not start.");
  return {
    jwksUri: `http://127.0.0.1:${address.port}/jwks`,
    sign: () => signToken(privateKey),
  };
}

let tokenCounter = 0;
function signToken(privateKey: CryptoKey): Promise<string> {
  tokenCounter += 1;
  return new SignJWT({ scope: "tinycloud:mcp", "https://tinycloud.xyz/owner_dids": [OWNER] })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer(ISSUER)
    .setSubject(`openkey-user-${tokenCounter}`)
    .setAudience("https://mcp.test/mcp")
    .setJti(`jti-${tokenCounter}`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function verifierWith(stub: StubOpenKey, clock: { now: number }) {
  const { jwksUri, sign } = await jwksServer();
  const verifier = createOpenKeyTokenVerifier({
    issuer: ISSUER,
    audience: "https://mcp.test/mcp",
    jwksUri,
    requiredScope: "tinycloud:mcp",
    tokenStatus: checkerWith(stub, clock),
  });
  return { verify: (token: string) => verifier.verifyAccessToken(token), sign };
}

test("an inactive token is refused with invalid_token on the very next call", async () => {
  const stub = stubOpenKey("active");
  const clock = { now: Date.now() };
  const { jwksUri, sign } = await jwksServer();
  const stateDir = await mkdtemp(join("/var/tmp", "tc1627."));
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
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth2/authorize`,
      token_endpoint: `${ISSUER}/oauth2/token`,
      jwks_uri: jwksUri,
      introspection_endpoint: INTROSPECTION,
      response_types_supported: ["code"],
    },
    introspection: { clientId: "mcp-client", clientSecret: "secret", authMethod: "basic", fetch: stub.fetch, now: () => clock.now },
  });
  apps.push(app);
  const token = await sign();
  const call = () => app.fetch(new Request("https://mcp.test/mcp", {
    method: "POST",
    headers: { host: "mcp.test", authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  }));

  expect((await call()).status).not.toBe(401);
  stub.answer = "inactive";
  clock.now += 6_000;
  const refused = await call();
  expect(refused.status).toBe(401);
  expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
  expect(stub.calls[0]!.url).toBe(INTROSPECTION);
});

test("an inactive answer is cached for that token: no second introspection", async () => {
  const stub = stubOpenKey("inactive");
  const clock = { now: Date.now() };
  const { verify, sign } = await verifierWith(stub, clock);
  const token = await sign();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(verify(token)).rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken });
    clock.now += 60_000;
  }
  stub.answer = "active";
  await expect(verify(token)).rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken });
  expect(stub.calls).toHaveLength(1);
  // Another token is asked separately.
  await expect(verify(await sign())).resolves.toMatchObject({ clientId: "unknown" });
  expect(stub.calls).toHaveLength(2);
});

test("an active answer is reused for at most 5 seconds", async () => {
  const stub = stubOpenKey("active");
  const clock = { now: Date.now() };
  const { verify, sign } = await verifierWith(stub, clock);
  const token = await sign();

  await verify(token);
  clock.now += 4_999;
  await verify(token);
  expect(stub.calls).toHaveLength(1);
  clock.now += 2;
  await verify(token);
  expect(stub.calls).toHaveLength(2);
});

test("OpenKey unreachable: calls are served for less than the token lifetime, then refused", async () => {
  const stub = stubOpenKey("active");
  const clock = { now: Date.now() };
  const { verify, sign } = await verifierWith(stub, clock);
  const token = await sign();
  await verify(token);

  stub.answer = "down";
  clock.now += 6_000 + 293_000; // 299 s since OpenKey last answered; token lifetime is 300 s
  await expect(verify(token)).resolves.toMatchObject({ extra: { subject: expect.any(String) } });
  clock.now += 1_000; // 300 s
  const refused = await verify(token).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(OAuthError);
  if (!(refused instanceof OAuthError)) throw new Error("Expected an OAuthError.");
  expect(refused.code).toBe(OAuthErrorCode.ServerError);
});

test("OpenKey that has never answered is refused at once", async () => {
  const stub = stubOpenKey("down");
  const clock = { now: Date.now() };
  const { verify, sign } = await verifierWith(stub, clock);
  await expect(verify(await sign())).rejects.toMatchObject({ code: OAuthErrorCode.ServerError });
});

test("an answer that is not a clear active flag counts as unknown", async () => {
  for (const answer of ["unauthorized", "malformed"] as const) {
    const stub = stubOpenKey(answer);
    const clock = { now: Date.now() };
    const checker = checkerWith(stub, clock);
    expect(await checker.tokenStatus("not-a-jwt")).toBe("unknown");
    expect(checker.toleratesUnknown("not-a-jwt")).toBe(false);
  }
});

test("the confidential client authenticates with basic or post credentials", async () => {
  const basic = stubOpenKey("active");
  await checkerWith(basic, { now: Date.now() }).tokenStatus("tok");
  const call = basic.calls[0]!;
  expect(call.headers.get("authorization")).toBe(`Basic ${Buffer.from("mcp-client:s3cret%2F%2B+value").toString("base64")}`);
  expect(call.body.get("token")).toBe("tok");
  expect(call.body.get("token_type_hint")).toBe("access_token");
  expect(call.body.has("client_secret")).toBe(false);

  const post = stubOpenKey("active");
  await checkerWith(post, { now: Date.now() }, "post").tokenStatus("tok");
  const postCall = post.calls[0]!;
  expect(postCall.headers.has("authorization")).toBe(false);
  expect(postCall.body.get("client_id")).toBe("mcp-client");
  expect(postCall.body.get("client_secret")).toBe("s3cret/+ value");
});

test("the hosted app does not start when the metadata has no introspection endpoint", () => {
  expect(() => createHostedMcpApp({
    stateDir: join(home, "state"),
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
    oauthMetadata: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth2/authorize`,
      token_endpoint: `${ISSUER}/oauth2/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"],
    },
    introspection: { clientId: "c", clientSecret: "s", authMethod: "basic" },
  })).toThrow("introspection endpoint");
});
