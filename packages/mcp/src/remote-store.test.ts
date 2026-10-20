import { afterEach, expect, spyOn, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invokeOperation } from "@tinycloud/operations";

import { ApprovalOwnerMismatchError, ApprovalStageError, RemoteTenantStore } from "./remote-store.js";
import {
  OTHER_OWNER_KEY,
  REQUESTER_KEY,
  callbackRequest,
  openKeyCallbackBody,
  ownerDid,
  siweDelegationFromCallback,
} from "./test-support/openkey-callback.js";

const BOOTSTRAP_ABILITIES = {
  kv: {
    "spaces/": ["tinycloud.kv/get", "tinycloud.kv/list"],
    "applications/": ["tinycloud.kv/get", "tinycloud.kv/list"],
  },
};

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
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

test("first operations and expired sessions receive account-bound reconnect links", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const foreignOwner = await ownerDid(OTHER_OWNER_KEY);
  for (const expired of [false, true]) {
    const subject = expired ? "expired-account" : "new-account";
    const stateRoot = await store.initializeTenant(subject);
    if (expired) {
      const clock = spyOn(Date, "now").mockReturnValue(Date.now() - 2 * 60 * 60_000);
      let session: Record<string, unknown>;
      try {
        session = await openKeyCallbackBody({
          tenantStateRoot: stateRoot, privateKey: REQUESTER_KEY, space: "account",
          abilities: BOOTSTRAP_ABILITIES,
        });
      } finally {
        clock.mockRestore();
      }
      await writeFile(join(stateRoot, ".tinycloud/profiles/agent/session.json"), JSON.stringify(session));
    }
    const result = await invokeOperation(
      "tinycloud.kv.get", 1, { profile: "agent", stateRoot },
      { space: "default", key: "record", representation: "json" },
    );
    expect(result).toMatchObject({
      status: "error", error: { code: expired ? "AUTH_REQUIRED" : "SESSION_NOT_FOUND" },
    });
    const decorated = record(await store.decorateAuthorityResult(subject, [requester], result));
    const details = record(record(decorated.error).details);
    expect(Date.parse(String(details.expiresAt))).toBeGreaterThan(Date.now());
    const state = new URL(String(details.approvalUrl)).searchParams.get("state")!;
    const redirect = new URL(await store.approvalRedirect(state));
    const permissions = JSON.parse(Buffer.from(redirect.searchParams.get("permissions")!, "base64url").toString());
    expect(permissions.reason).toContain(requester);
    expect(permissions.reason).not.toContain(foreignOwner);
    expect(permissions.permissions).toEqual([
      { service: "tinycloud.kv", space: "account", path: "spaces/", actions: BOOTSTRAP_ABILITIES.kv["spaces/"] },
      { service: "tinycloud.kv", space: "account", path: "applications/", actions: BOOTSTRAP_ABILITIES.kv["applications/"] },
    ]);
    const foreign = await openKeyCallbackBody({
      tenantStateRoot: stateRoot, privateKey: OTHER_OWNER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
    });
    await expect(store.completeApproval(state, callbackRequest(foreign)))
      .rejects.toBeInstanceOf(ApprovalOwnerMismatchError);
  }
});

test("tc-apps approvals explain exact capabilities and fall back for unrelated permissions", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  await store.initializeTenant("approval-account");
  const records = {
    service: "tinycloud.kv", space: "default", path: "xyz.tinycloud.agent-data/",
    actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"],
  };
  const cases = [
    { permissions: [records], matches: true },
    { permissions: [{ ...records, path: "xyz.tinycloud.agent-data/other/" }], matches: false },
    { permissions: [{ ...records, space: "other" }], matches: false },
    { permissions: [{ ...records, service: "tinycloud.sql" }], matches: false },
    { permissions: [{ ...records, actions: [...records.actions, "tinycloud.kv/metadata"] }], matches: false },
  ];
  for (const [index, { permissions, matches }] of cases.entries()) {
    const result = record(await store.decorateAuthorityResult("approval-account", [requester], {
      status: "authority_required", operation: {}, context: {},
      request: { requestId: `request-${index}`, requested: permissions },
      approval: { kind: "openkey" },
    }));
    const approval = record(result.approval);
    const state = new URL(String(approval.url)).searchParams.get("state")!;
    const redirect = new URL(await store.approvalRedirect(state));
    const payload = JSON.parse(Buffer.from(redirect.searchParams.get("permissions")!, "base64url").toString());
    if (matches) {
      expect(payload.reason).toContain("Lets Claude keep your personal records");
      expect(approval.fallback).not.toBe("Open the approval URL, then retry the same MCP tool.");
    } else {
      expect(payload.reason).toContain("Approve the exact capabilities requested");
      expect(payload.reason).not.toContain("Lets Claude");
    }
  }
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

  // The requester's own approval is stored as the tenant session.
  const own = await openKeyCallbackBody({
    tenantStateRoot: tenantRoot,
    privateKey: REQUESTER_KEY,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  await store.completeApproval(state, callbackRequest(own));
  expect(JSON.parse(await readFile(join(tenantRoot, ".tinycloud/profiles/agent/session.json"), "utf8")))
    .toMatchObject({ delegationCid: own.delegationCid, address: own.address });
});

test("callbacks without the full signed proof are refused", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const state = new URL(status.approvalUrl!).searchParams.get("state")!;
  const own = await openKeyCallbackBody({
    tenantStateRoot: tenantRoot,
    privateKey: REQUESTER_KEY,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  for (const field of ["siwe", "signature", "address", "chainId"]) {
    const { [field]: _omitted, ...partial } = own;
    await expect(store.completeApproval(state, callbackRequest(partial)))
      .rejects.toMatchObject({ stage: "restore_approval", code: "CALLBACK_INCOMPLETE" });
  }
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
});

test("delegation approvals from another owner are refused before anything is stored", async () => {
  const hermetic = await createHermeticNode();
  const store = await testStore(hermetic.host);
  const requester = hermetic.ownerDid;
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const connect = await store.connectStatus("openkey-user-a", [requester]);
  const bootstrap = await openKeyCallbackBody({
    tenantStateRoot: tenantRoot,
    privateKey: hermetic.ownerPrivateKey,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  await activateOnNode(hermetic.host, bootstrap);
  await store.completeApproval(new URL(connect.approvalUrl!).searchParams.get("state")!, callbackRequest(bootstrap));

  // A real stored request from the tenant's own runtime.
  const authority = await invokeOperation(
    "tinycloud.kv.get",
    1,
    { profile: "agent", stateRoot: tenantRoot },
    { space: "applications", key: "agents/demo/profile", representation: "json" },
  );
  expect(authority).toMatchObject({ status: "authority_required" });
  const decorated = await store.decorateAuthorityResult("openkey-user-a", [requester], authority) as {
    approval: { url: string };
  };
  const state = new URL(decorated.approval.url).searchParams.get("state")!;
  const redirect = new URL(await store.approvalRedirect(state));
  const reason = JSON.parse(Buffer.from(redirect.searchParams.get("permissions")!, "base64url").toString("utf8")).reason;
  expect(reason).toContain(requester);

  const abilities = { kv: { "agents/demo/profile": ["tinycloud.kv/get"] } };
  const foreignApproval = await openKeyCallbackBody({
    tenantStateRoot: tenantRoot,
    privateKey: OTHER_OWNER_KEY,
    space: "applications",
    abilities,
  });
  const refused = await store.completeApproval(state, callbackRequest(foreignApproval)).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ApprovalOwnerMismatchError);
  expect((refused as Error).message).not.toContain(String(foreignApproval.address));
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/additional-delegations.json"))).toBe(false);

  // The requester's own approval is imported against the stored request.
  const ownApproval = await openKeyCallbackBody({
    tenantStateRoot: tenantRoot,
    privateKey: hermetic.ownerPrivateKey,
    space: "applications",
    abilities,
  });
  await store.completeApproval(state, callbackRequest(ownApproval));
  const stored = JSON.parse(await readFile(
    join(tenantRoot, ".tinycloud/profiles/agent/additional-delegations.json"),
    "utf8",
  )) as Array<Record<string, unknown>>;
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    delegation: {
      cid: ownApproval.delegationCid,
      delegateDID: connect.sessionDid,
      siweProof: { siwe: ownApproval.siwe, signature: ownApproval.signature },
    },
    authorityRequest: { requestId: record(record(authority).request).requestId },
  });
  // A fresh runtime replays it within that request.
  expect(await invokeOperation(
    "tinycloud.kv.get",
    1,
    { profile: "agent", stateRoot: tenantRoot },
    { space: "applications", key: "agents/demo/profile", representation: "json" },
  )).toMatchObject({ status: "ok", output: { value: { name: "Ada", role: "operator" } } });
});

test("a delegation approval outside the stored request is not imported", async () => {
  const hermetic = await createHermeticNode();
  const store = await testStore(hermetic.host);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const connect = await store.connectStatus("openkey-user-a", [hermetic.ownerDid]);
  const bootstrap = await openKeyCallbackBody({
    tenantStateRoot: tenantRoot,
    privateKey: hermetic.ownerPrivateKey,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  await activateOnNode(hermetic.host, bootstrap);
  await store.completeApproval(new URL(connect.approvalUrl!).searchParams.get("state")!, callbackRequest(bootstrap));
  const authority = await invokeOperation(
    "tinycloud.kv.get",
    1,
    { profile: "agent", stateRoot: tenantRoot },
    { space: "applications", key: "agents/demo/profile", representation: "json" },
  );
  const decorated = await store.decorateAuthorityResult("openkey-user-a", [hermetic.ownerDid], authority) as {
    approval: { url: string };
  };
  // Correctly signed by the requester, but broader than what was requested.
  const broader = await openKeyCallbackBody({
    tenantStateRoot: tenantRoot,
    privateKey: hermetic.ownerPrivateKey,
    space: "applications",
    abilities: { kv: { "agents/": ["tinycloud.kv/get"] } },
  });
  const outside = await store.completeApproval(
    new URL(decorated.approval.url).searchParams.get("state")!,
    callbackRequest(broader),
  ).catch((error: unknown) => error);
  // Exceeding the stored request is refused after activation, so it carries no activation reason.
  expect(outside).toBeInstanceOf(ApprovalStageError);
  expect(outside).toMatchObject({ stage: "auth_import", code: "DELEGATION_REJECTED", reason: undefined });
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/additional-delegations.json"))).toBe(false);

  // The same signed delegation planted in the store, with no binding or bound
  // to the narrower request, grants nothing on replay.
  const planted = await siweDelegationFromCallback(broader, tenantRoot, hermetic.host);
  const request = record(record(authority).request);
  const sibling = { space: "applications", key: "agents/demo/settings", representation: "json" };
  for (const binding of [{}, { authorityRequest: { requestId: request.requestId, requested: request.requested } }]) {
    await writeFile(
      join(tenantRoot, ".tinycloud/profiles/agent/additional-delegations.json"),
      JSON.stringify([{ delegation: planted, permissions: [], ...binding }]),
    );
    expect(await invokeOperation("tinycloud.kv.get", 1, { profile: "agent", stateRoot: tenantRoot }, sibling))
      .toMatchObject({ status: "authority_required" });
  }
});

async function activateOnNode(host: string, callback: Record<string, unknown>): Promise<void> {
  const header = record(callback.delegationHeader).Authorization;
  if (typeof header !== "string") throw new Error("Missing approval authorization.");
  const response = await fetch(`${host}/delegate`, {
    method: "POST",
    headers: { Authorization: header },
  });
  expect(response.status).toBe(200);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}

async function createHermeticNode(): Promise<HermeticNode> {
  // The loopback node lives in node-sdk's test sources, outside this package's
  // build graph; stdio.test.ts loads the same fixtures the same way.
  const module = await import(new URL(
    "../../node-sdk/src/test-support/hermetic-encrypted-node.ts",
    import.meta.url,
  ).href) as { createHermeticEncryptedNode(): Promise<HermeticNode> };
  const hermetic = await module.createHermeticEncryptedNode();
  cleanups.push(async () => hermetic.stop());
  return hermetic;
}

interface HermeticNode {
  readonly host: string;
  readonly ownerDid: string;
  readonly ownerPrivateKey: string;
  stop(): void;
}

async function testStore(nodeHost = "https://node.tinycloud.test"): Promise<RemoteTenantStore> {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-mcp-"));
  directories.push(stateDir);
  return new RemoteTenantStore({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost,
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
  });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
