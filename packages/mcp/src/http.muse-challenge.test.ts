import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";
import { resetMcpRegistryFixture } from "./test-support/registry-fixture.mjs";

const TOKEN = "e66b769bf23d490fc70bf9a5597da175ddcbc40d8c8e39e0512e9445c2b95193";
const CHALLENGE_PATH = `/.well-known/muse-challenge/${TOKEN}`;

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

test("a configured Muse challenge token is served as plain text without sign-in", async () => {
  for (const configured of [TOKEN, `muse-challenge=${TOKEN}`, ` muse-challenge=${TOKEN}\n`]) {
    const app = await testApp(configured);
    const response = await app.fetch(request(CHALLENGE_PATH));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe(`muse-challenge=${TOKEN}`);
  }
});

test("a wrong token, an unset variable or another address answers like any unknown path", async () => {
  const configured = await testApp(TOKEN);
  const unset = await testApp(undefined);
  const empty = await testApp("");
  const notFound = await snapshot(await configured.fetch(request("/no-such-path")));

  expect(notFound.status).toBe(404);
  for (const response of [
    await configured.fetch(request(`/.well-known/muse-challenge/${"0".repeat(64)}`)),
    await configured.fetch(request(`/.well-known/muse-challenge/${TOKEN}/`)),
    await configured.fetch(request("/.well-known/muse-challenge/")),
    await configured.fetch(request(`/muse${CHALLENGE_PATH}`)),
    await unset.fetch(request(CHALLENGE_PATH)),
    await empty.fetch(request(CHALLENGE_PATH)),
  ]) {
    expect(await snapshot(response)).toEqual(notFound);
  }
});

test("the challenge route only answers GET", async () => {
  const app = await testApp(TOKEN);
  const response = await app.fetch(request(CHALLENGE_PATH, { method: "POST" }));

  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET");
});

test("a malformed challenge token is refused at startup", async () => {
  await expect(testApp("muse-challenge=../secret")).rejects.toThrow("TC_MCP_MUSE_CHALLENGE");
});

async function snapshot(response: Response): Promise<{ status: number; contentType: string | null; body: string }> {
  return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
}

async function testApp(museChallenge: string | undefined): Promise<HostedMcpApp> {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-muse-challenge-"));
  directories.push(stateDir);
  const app = createHostedMcpApp({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
    ...(museChallenge === undefined ? {} : { museChallenge }),
    oauthMetadata: {
      issuer: "https://openkey.test/api/auth",
      authorization_endpoint: "https://openkey.test/api/auth/oauth2/authorize",
      token_endpoint: "https://openkey.test/api/auth/oauth2/token",
      jwks_uri: "https://openkey.test/api/auth/jwks",
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
