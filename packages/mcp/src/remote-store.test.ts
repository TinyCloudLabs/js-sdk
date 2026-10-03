import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalOwnerMismatchError, RemoteTenantStore } from "./remote-store.js";
import {
  OTHER_OWNER_KEY,
  REQUESTER_KEY,
  callbackRequest,
  openKeyCallbackBody,
  ownerDid,
  ownerSpace,
} from "./test-support/openkey-callback.js";

const BOOTSTRAP_ABILITIES = {
  kv: {
    "spaces/": ["tinycloud.kv/get", "tinycloud.kv/list"],
    "applications/": ["tinycloud.kv/get", "tinycloud.kv/list"],
  },
};

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

test("connect refuses a session signed by another OpenKey owner before storing it", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const state = new URL(status.approvalUrl!).searchParams.get("state")!;

  const foreign = await openKeyCallbackBody({
    tenantStateRoot: tenantRoot,
    privateKey: OTHER_OWNER_KEY,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  await expect(store.completeApproval(state, callbackRequest(foreign)))
    .rejects.toBeInstanceOf(ApprovalOwnerMismatchError);
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);

  // The requester's own approval is not treated as foreign.
  const own = await openKeyCallbackBody({
    tenantStateRoot: tenantRoot,
    privateKey: REQUESTER_KEY,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  const accepted = await store.completeApproval(state, callbackRequest(own)).catch((error: unknown) => error);
  expect(accepted).not.toBeInstanceOf(ApprovalOwnerMismatchError);
});

test("delegation approvals from another owner are refused before anything is stored", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  // The requesting tenant asks for authority over someone else's space.
  const victimSpace = await ownerSpace(OTHER_OWNER_KEY, "default");
  const decorated = await store.decorateAuthorityResult("openkey-user-a", [requester], {
    status: "authority_required",
    request: {
      requestId: "request-1",
      requested: [{ service: "tinycloud.kv", space: victimSpace, path: "docs/", actions: ["tinycloud.kv/get"] }],
    },
  }) as { approval: { url: string } };
  const state = new URL(decorated.approval.url).searchParams.get("state")!;
  const redirect = new URL(await store.approvalRedirect(state));
  const reason = JSON.parse(Buffer.from(redirect.searchParams.get("permissions")!, "base64url").toString("utf8")).reason;
  expect(reason).toContain(requester);

  const victimApproval = await openKeyCallbackBody({
    tenantStateRoot: tenantRoot,
    privateKey: OTHER_OWNER_KEY,
    space: "default",
    abilities: { kv: { "docs/": ["tinycloud.kv/get"] } },
  });
  const refused = await store.completeApproval(state, callbackRequest(victimApproval)).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ApprovalOwnerMismatchError);
  expect((refused as Error).message).not.toContain(String(victimApproval.address));
  for (const file of ["session.json", "additional-delegations.json"]) {
    expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent", file))).toBe(false);
  }

  // The requester's own approval passes the owner gate (import itself needs a
  // connected tenant, which this store does not have).
  const ownApproval = await openKeyCallbackBody({
    tenantStateRoot: tenantRoot,
    privateKey: REQUESTER_KEY,
    space: "default",
    abilities: { kv: { "docs/": ["tinycloud.kv/get"] } },
  });
  const imported = await store.completeApproval(state, callbackRequest(ownApproval)).catch((error: unknown) => error);
  expect(imported).not.toBeInstanceOf(ApprovalOwnerMismatchError);
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

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
