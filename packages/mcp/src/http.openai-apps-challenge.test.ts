import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostedMcpApp, type HostedMcpApp } from "./http.js";
import { resetMcpRegistryFixture } from "./test-support/registry-fixture.mjs";

const directories: string[] = [];
const apps: HostedMcpApp[] = [];
const CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  } finally {
    resetMcpRegistryFixture();
  }
});

test("the challenge path serves the portal's token as plain text, with nothing added", async () => {
  const app = await testApp("tok_Abc-123.xyz");
  const response = await app.fetch(request(CHALLENGE_PATH));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await response.text()).toBe("tok_Abc-123.xyz");
});

test("a trailing newline in the configured token is not served", async () => {
  const app = await testApp("tok_Abc-123.xyz\n");

  expect(await (await app.fetch(request(CHALLENGE_PATH))).text()).toBe("tok_Abc-123.xyz");
});

test("HEAD answers 200 with no body, and other methods are refused", async () => {
  const app = await testApp("tok_Abc-123.xyz");
  const head = await app.fetch(request(CHALLENGE_PATH, { method: "HEAD" }));
  const post = await app.fetch(request(CHALLENGE_PATH, { method: "POST" }));

  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET, HEAD");
});

test("without a configured token the path answers 404", async () => {
  for (const token of [undefined, "", "  \n"]) {
    const app = await testApp(token);
    expect((await app.fetch(request(CHALLENGE_PATH))).status).toBe(404);
  }
});

test("the restricted ChatGPT address does not serve the challenge under its own prefix", async () => {
  const app = await testApp("tok_Abc-123.xyz");
  const response = await app.fetch(request(`/chatgpt${CHALLENGE_PATH}`));

  expect(response.status).not.toBe(200);
});

async function testApp(openaiAppsChallenge: string | undefined): Promise<HostedMcpApp> {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-challenge-"));
  directories.push(stateDir);
  const app = createHostedMcpApp({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
    ...(openaiAppsChallenge === undefined ? {} : { openaiAppsChallenge }),
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
