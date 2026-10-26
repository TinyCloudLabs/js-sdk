import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";
import { createOpenKeyTokenVerifier } from "./oauth.js";
import { createTokenStatusChecker } from "./token-status.js";

const home = await mkdtemp(join("/var/tmp", "tc1627."));
process.env.HOME = home;
if (!process.env.HOME?.startsWith("/var/tmp/tc1627.")) throw new Error("HOME is not isolated.");

const OWNER = "did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const ISSUER = "https://openkey.test/api/auth";
const AUDIENCE = "https://mcp.test/mcp";
const USERINFO = `${ISSUER}/oauth2/userinfo`;
const INTROSPECTION = "https://openkey.test/api/oauth/resource/introspect";
const servers: Server[] = [];
const apps: HostedMcpApp[] = [];
const directories: string[] = [home];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(1).map((path) => rm(path, { recursive: true, force: true })));
});

type Answer = "active" | "inactive" | "down" | "server-error" | "rate-limited" | "unauthorized" | "malformed";

interface StubOpenKey {
  answer: Answer;
  /** Fields that replace the ones an `active` answer derives from the token. */
  tamper: Record<string, unknown>;
  calls: Array<{ url: string; headers: Headers; body: URLSearchParams }>;
  logs: string[];
  fetch: typeof fetch;
}

/** A stub OpenKey introspection endpoint that records every request. */
function stubOpenKey(initial: Answer = "active"): StubOpenKey {
  const stub: StubOpenKey = {
    answer: initial,
    tamper: {},
    calls: [],
    logs: [],
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      stub.calls.push({ url: String(input), headers: new Headers(init?.headers), body });
      switch (stub.answer) {
        case "down": throw new TypeError("connection refused");
        case "server-error": return new Response("oops", { status: 500 });
        case "rate-limited": return new Response("slow down", { status: 429 });
        case "unauthorized": return Response.json({ error: "invalid_client" }, { status: 401 });
        case "malformed": return Response.json({ status: "ok" });
        case "inactive": return Response.json({ active: false });
        default: {
          const jwt = decodeJwt(body.get("token") ?? "");
          return Response.json({
            active: true,
            scope: jwt.scope,
            client_id: jwt.azp,
            sub: jwt.sub,
            aud: AUDIENCE,
            exp: jwt.exp,
            iat: jwt.iat,
            iss: jwt.iss,
            token_type: "Bearer",
            ...stub.tamper,
          });
        }
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
    resourceUrl: AUDIENCE,
    authMethod,
    fetch: stub.fetch,
    now: () => clock.now,
    log: (message) => stub.logs.push(message),
  });
}

async function jwksServer(): Promise<{ jwksUri: string; sign: (lifetime?: string) => Promise<string> }> {
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
    sign: (lifetime = "5m") => signToken(privateKey, lifetime),
  };
}

let tokenCounter = 0;
function signToken(privateKey: CryptoKey, lifetime: string): Promise<string> {
  tokenCounter += 1;
  return new SignJWT({
    scope: "tinycloud:mcp",
    azp: "claude-client",
    "https://tinycloud.xyz/owner_dids": [OWNER],
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setIssuer(ISSUER)
    .setSubject(`openkey-user-${tokenCounter}`)
    .setAudience([AUDIENCE, USERINFO])
    .setIssuedAt()
    .setExpirationTime(lifetime)
    .sign(privateKey);
}

async function verifierWith(stub: StubOpenKey, clock: { now: number }) {
  const { jwksUri, sign } = await jwksServer();
  const verifier = createOpenKeyTokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
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
    publicUrl: new URL(AUDIENCE),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
    oauthMetadata: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth2/authorize`,
      token_endpoint: `${ISSUER}/oauth2/token`,
      jwks_uri: jwksUri,
      response_types_supported: ["code"],
    },
    introspection: {
      endpoint: INTROSPECTION,
      clientId: "mcp-client",
      clientSecret: "secret",
      authMethod: "basic",
      fetch: stub.fetch,
      now: () => clock.now,
    },
  });
  apps.push(app);
  const token = await sign();
  const call = () => app.fetch(new Request(AUDIENCE, {
    method: "POST",
    headers: { host: "mcp.test", authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  }));

  expect((await call()).status).not.toBe(401);
  stub.answer = "inactive";
  clock.now += 31_000;
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
  await expect(verify(await sign())).resolves.toMatchObject({ clientId: "claude-client" });
  expect(stub.calls).toHaveLength(2);
});

test("an active answer is reused for 30 seconds", async () => {
  const stub = stubOpenKey("active");
  const clock = { now: Date.now() };
  const { verify, sign } = await verifierWith(stub, clock);
  const token = await sign();

  await verify(token);
  clock.now += 29_999;
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
  clock.now += 299_000; // 299 s since OpenKey last answered; token lifetime is 300 s
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

test("a 5xx or an answer without a boolean active flag is unknown", async () => {
  for (const answer of ["server-error", "malformed"] as const) {
    const stub = stubOpenKey(answer);
    const checker = checkerWith(stub, { now: Date.now() });
    expect(await checker.tokenStatus("not-a-jwt")).toBe("unknown");
    expect(checker.toleratesUnknown("not-a-jwt")).toBe(false);
  }
});

test("a 401 from OpenKey is logged once and refused even inside the outage allowance; it is not an answer", async () => {
  const stub = stubOpenKey("active");
  const clock = { now: Date.now() };
  const { verify, sign } = await verifierWith(stub, clock);
  const token = await sign();
  await verify(token); // OpenKey answered at t0

  stub.answer = "unauthorized";
  clock.now += 40_000; // active window over; well inside the 300 s allowance
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect(verify(token)).rejects.toMatchObject({ code: OAuthErrorCode.ServerError });
  }
  expect(stub.logs).toHaveLength(1);
  expect(stub.logs[0]).not.toContain("s3cret");

  // Still refused while OpenKey is merely unreachable: the refusal is only lifted by a real answer.
  stub.answer = "down";
  await expect(verify(token)).rejects.toMatchObject({ code: OAuthErrorCode.ServerError });

  stub.answer = "active";
  await verify(token);
  stub.answer = "down";
  clock.now += 40_000;
  await expect(verify(token)).resolves.toMatchObject({ clientId: "claude-client" });
  // A later refusal is logged again.
  stub.answer = "unauthorized";
  clock.now += 40_000;
  await expect(verify(token)).rejects.toMatchObject({ code: OAuthErrorCode.ServerError });
  expect(stub.logs).toHaveLength(2);
});

test("an active answer must name this resource and only audiences the token carries", async () => {
  // The token carries the resource and its userinfo endpoint; OpenKey answers with the resource only.
  const routeShaped = stubOpenKey("active");
  const accepted = await verifierWith(routeShaped, { now: Date.now() });
  await expect(accepted.verify(await accepted.sign())).resolves.toMatchObject({ clientId: "claude-client" });
  for (const aud of [AUDIENCE, [AUDIENCE], [AUDIENCE, USERINFO]]) {
    const stub = stubOpenKey("active");
    stub.tamper = { aud };
    const { verify, sign } = await verifierWith(stub, { now: Date.now() });
    await expect(verify(await sign())).resolves.toMatchObject({ clientId: "claude-client" });
  }

  for (const tamper of [
    { sub: "someone-else" },
    { client_id: "other-client" },
    { aud: "https://other.test/mcp" },
    { aud: [USERINFO] },
    { aud: [AUDIENCE, "https://other.test/mcp"] },
    { aud: [] },
    { aud: undefined },
  ]) {
    const stub = stubOpenKey("active");
    stub.tamper = tamper;
    const { verify, sign } = await verifierWith(stub, { now: Date.now() });
    const token = await sign();
    await expect(verify(token)).rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken });
    // The refusal is kept for the token like an inactive answer.
    stub.tamper = {};
    await expect(verify(token)).rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken });
    expect(stub.calls).toHaveLength(1);
  }
});

test("an unknown answer is tolerated only for a token OpenKey answered active, within its lifetime", async () => {
  const stub = stubOpenKey("active");
  const clock = { now: Date.now() };
  const { verify, sign } = await verifierWith(stub, clock);
  const token = await sign("60s");
  await verify(token);

  stub.answer = "down";
  clock.now += 59_000;
  await expect(verify(token)).resolves.toMatchObject({ clientId: "claude-client" });
  clock.now += 1_000; // 60 s: the token's lifetime
  await expect(verify(token)).rejects.toMatchObject({ code: OAuthErrorCode.ServerError });
});

test("while OpenKey answers 429, a token it never answered active is refused even after other tokens were answered", async () => {
  const stub = stubOpenKey("active");
  const clock = { now: Date.now() };
  const { verify, sign } = await verifierWith(stub, clock);
  const seen = await sign();
  const refusedBefore = await sign();
  const never = await sign();
  await verify(seen);
  stub.answer = "inactive";
  await expect(verify(refusedBefore)).rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken });
  stub.answer = "active";
  await verify(await sign()); // another token keeps OpenKey's last answer fresh

  stub.answer = "rate-limited";
  clock.now += 40_000; // active windows are over
  await expect(verify(seen)).resolves.toMatchObject({ clientId: "claude-client" });
  await expect(verify(never)).rejects.toMatchObject({ code: OAuthErrorCode.ServerError });
  // An answer that was inactive stays refused from the cache.
  await expect(verify(refusedBefore)).rejects.toMatchObject({ code: OAuthErrorCode.InvalidToken });
});

test("the confidential client authenticates with basic or post credentials", async () => {
  const basic = stubOpenKey("inactive");
  await checkerWith(basic, { now: Date.now() }).tokenStatus("tok");
  const call = basic.calls[0]!;
  expect(call.headers.get("authorization")).toBe(`Basic ${Buffer.from("mcp-client:s3cret%2F%2B+value").toString("base64")}`);
  expect(call.body.get("token")).toBe("tok");
  expect(call.body.get("token_type_hint")).toBe("access_token");
  expect(call.body.has("client_secret")).toBe(false);

  const post = stubOpenKey("inactive");
  await checkerWith(post, { now: Date.now() }, "post").tokenStatus("tok");
  const postCall = post.calls[0]!;
  expect(postCall.headers.has("authorization")).toBe(false);
  expect(postCall.body.get("client_id")).toBe("mcp-client");
  expect(postCall.body.get("client_secret")).toBe("s3cret/+ value");
});
