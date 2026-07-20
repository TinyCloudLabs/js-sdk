import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteTenantStore } from "./remote-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("keeps hosted delegates isolated by OAuth subject", async () => {
  const store = await testStore();
  const first = await store.connectStatus("openkey-user-a");
  const second = await store.connectStatus("openkey-user-b");
  const repeated = await store.connectStatus("openkey-user-a");

  expect(first.connected).toBe(false);
  expect(second.connected).toBe(false);
  expect(first.sessionDid).not.toBe(second.sessionDid);
  expect(repeated.sessionDid).toBe(first.sessionDid);
  expect(repeated.approvalUrl).toBe(first.approvalUrl);
  expect(store.tenantStateRoot("openkey-user-a")).not.toBe(store.tenantStateRoot("openkey-user-b"));

  const firstProfile = JSON.parse(await readFile(
    join(store.tenantStateRoot("openkey-user-a"), ".tinycloud/profiles/agent/profile.json"),
    "utf8",
  )) as Record<string, unknown>;
  expect(firstProfile).toMatchObject({
    posture: "delegate-session",
    operatorType: "agent",
    sessionDid: first.sessionDid,
  });
});

test("approval redirects send OpenKey only the public delegate key", async () => {
  const store = await testStore();
  const status = await store.connectStatus("openkey-user-a");
  const state = new URL(status.approvalUrl!).searchParams.get("state")!;
  const redirect = new URL(await store.approvalRedirect(state));
  const jwk = JSON.parse(Buffer.from(redirect.searchParams.get("jwk")!, "base64url").toString("utf8"));
  const permissions = JSON.parse(
    Buffer.from(redirect.searchParams.get("permissions")!, "base64url").toString("utf8"),
  );

  expect(redirect.origin).toBe("https://openkey.test");
  expect(redirect.pathname).toBe("/delegate");
  expect(jwk.d).toBeUndefined();
  expect(permissions.permissions).toHaveLength(2);
  expect(redirect.searchParams.get("callback")).toStartWith("https://mcp.test/connect/callback?state=");
});

async function testStore(): Promise<RemoteTenantStore> {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-mcp-"));
  directories.push(stateDir);
  return new RemoteTenantStore({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
  });
}
