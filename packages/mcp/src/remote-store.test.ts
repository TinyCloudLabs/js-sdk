import { afterEach, expect, spyOn, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { invokeOperation } from "@tinycloud/operations";
import { DiagnosticStore, isDiagnosticId, resolveDiagnosticTenant } from "@tinycloud/operations/diagnostics";
import { HostedDiagnostics } from "./hosted-diagnostics.js";

import { ApprovalOwnerMismatchError, ApprovalRequestError, ApprovalStageError, RemoteTenantStore, type RemoteStoreConfig } from "./remote-store.js";
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
  expect(await store.connectStatus("openkey-user-a", [requester])).toMatchObject({ connected: true });
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
  await store.completeApproval(new URL(connect.approvalUrl!).searchParams.get("state")!, callbackRequest(
    await openKeyCallbackBody({
      tenantStateRoot: tenantRoot,
      privateKey: hermetic.ownerPrivateKey,
      space: "account",
      abilities: BOOTSTRAP_ABILITIES,
    }),
  ));
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

test("protected approval capture links reused waiters without retaining signed state or other tenants", async () => {
  const fixture = await approvalCapture();
  const owner = await ownerDid(REQUESTER_KEY);
  const firstHistory = await fixture.enable("PRIVATE_APPROVAL_A");
  const secondHistory = await fixture.enable("PRIVATE_APPROVAL_B");
  const [first, second] = await Promise.all([
    fixture.connect("PRIVATE_APPROVAL_A", owner),
    fixture.connect("PRIVATE_APPROVAL_B", owner),
  ]);
  const repeated = await fixture.connect("PRIVATE_APPROVAL_A", owner);
  expect(repeated.approvalUrl).toBe(first.approvalUrl);
  const firstState = new URL(first.approvalUrl!).searchParams.get("state")!;
  const secondState = new URL(second.approvalUrl!).searchParams.get("state")!;
  const firstPending = await fixture.pending("PRIVATE_APPROVAL_A", firstState);
  const secondPending = await fixture.pending("PRIVATE_APPROVAL_B", secondState);
  expect(isDiagnosticId(firstPending.diagnosticReference)).toBe(true);
  expect(isDiagnosticId(secondPending.diagnosticReference)).toBe(true);
  expect(secondPending.diagnosticReference).not.toBe(firstPending.diagnosticReference);

  const disabled = await fixture.connect("PRIVATE_DISABLED", owner);
  const disabledState = new URL(disabled.approvalUrl!).searchParams.get("state")!;
  expect(await fixture.pending("PRIVATE_DISABLED", disabledState)).not.toHaveProperty("diagnosticReference");
  // A different tenant label with the first link's signature establishes no authority.
  const forged = `${secondState.split(".")[0]}.${firstState.split(".").slice(1).join(".")}`;
  await expect(fixture.diagnostics.exchange(() => fixture.store.completeApproval(forged, callbackRequest({}))))
    .rejects.toMatchObject({ detail: "state_invalid" });
  await fixture.diagnostics.close();
  const firstSnapshot = await firstHistory.snapshot({ all: true });
  const secondSnapshot = await secondHistory.snapshot({ all: true });
  const requests = firstSnapshot.events.filter((event) => event.phase === "approval_request");
  expect(requests.map((event) => event.outcome)).toEqual(["pending", "reused"]);
  expect(requests[0]!.invocation_id).not.toBe(requests[1]!.invocation_id);
  expect(requests.every((event) => event.workflow_id === firstPending.diagnosticReference)).toBe(true);
  expect(secondSnapshot.events.filter((event) => event.phase === "approval_request").map((event) => event.outcome)).toEqual(["pending"]);
  expect(secondSnapshot.events.every((event) => event.workflow_id === secondPending.diagnosticReference)).toBe(true);
  expect(firstSnapshot.events.filter((event) => event.phase === "approval_wait")
    .every((event) => event.business === "awaiting_owner" && event.duration_ms === undefined)).toBe(true);
  for (const secret of [firstState, secondState, owner, first.approvalUrl!, "PRIVATE_", firstPending.nonce]) {
    expect(JSON.stringify([firstSnapshot, secondSnapshot])).not.toContain(String(secret));
  }
}, 30_000);

test("an unrelated connect approval stays unrecorded even when its verified tenant enables capture", async () => {
  const fixture = await approvalCapture();
  const subject = "PRIVATE_UNSCOPED_APPROVAL";
  const owner = await ownerDid(REQUESTER_KEY);
  const history = await fixture.enable(subject);
  const status = await fixture.diagnostics.exchange(() => fixture.store.connectStatus(subject, [owner]));
  const state = new URL(status.approvalUrl!).searchParams.get("state")!;
  expect(await fixture.pending(subject, state)).not.toHaveProperty("diagnosticReference");
  const stateRoot = fixture.store.tenantStateRoot(subject);
  const foreign = await openKeyCallbackBody({
    tenantStateRoot: stateRoot, privateKey: OTHER_OWNER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  });
  await expect(fixture.diagnostics.exchange(() => fixture.store.completeApproval(state, callbackRequest(foreign))))
    .rejects.toBeInstanceOf(ApprovalOwnerMismatchError);
  expect(await exists(join(stateRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
  await fixture.diagnostics.close();
  expect((await history.snapshot({ all: true })).events).toEqual([]);
}, 30_000);

test("callback denial and verified proof followed by failed commit remain distinct after restart", async () => {
  const fixture = await approvalCapture();
  const owner = await ownerDid(REQUESTER_KEY);
  const history = await fixture.enable("PRIVATE_APPROVAL_OWNER");
  const status = await fixture.connect("PRIVATE_APPROVAL_OWNER", owner);
  const state = new URL(status.approvalUrl!).searchParams.get("state")!;
  const pending = await fixture.pending("PRIVATE_APPROVAL_OWNER", state);
  const stateRoot = fixture.store.tenantStateRoot("PRIVATE_APPROVAL_OWNER");
  await fixture.diagnostics.close();
  const restarted = new HostedDiagnostics({ root: fixture.historyRoot }, fixture.config.stateDir);
  cleanups.push(() => restarted.close());
  const store = new RemoteTenantStore(fixture.config, restarted);
  const foreign = await openKeyCallbackBody({
    tenantStateRoot: stateRoot, privateKey: OTHER_OWNER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  });
  await expect(restarted.exchange(() => store.completeApproval(state, callbackRequest(foreign))))
    .rejects.toBeInstanceOf(ApprovalOwnerMismatchError);
  expect(await exists(join(stateRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
  const own = await openKeyCallbackBody({
    tenantStateRoot: stateRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  });
  // A genuine local persistence refusal after proof/owner/capability verification.
  const sessionPath = join(stateRoot, ".tinycloud/profiles/agent/session.json");
  await mkdir(sessionPath);
  const refused = await restarted.exchange(() => store.completeApproval(state, callbackRequest(own))).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(Error);
  expect(refused).not.toBeInstanceOf(ApprovalStageError);
  expect(await fixture.pending("PRIVATE_APPROVAL_OWNER", state)).toMatchObject({ diagnosticReference: pending.diagnosticReference });
  await rm(sessionPath, { recursive: true });
  await restarted.exchange(() => store.completeApproval(state, callbackRequest(own)));
  expect(JSON.parse(await readFile(sessionPath, "utf8"))).toMatchObject({ delegationCid: own.delegationCid });
  await restarted.close();
  const snapshot = await history.snapshot({ all: true });
  const callbacks = snapshot.events.filter((event) => event.type === "invocation.start");
  expect(callbacks).toHaveLength(3);
  expect(new Set(callbacks.map((event) => event.invocation_id)).size).toBe(3);
  expect(callbacks.every((event) => event.workflow_id === pending.diagnosticReference)).toBe(true);
  const denied = snapshot.events.filter((event) => event.invocation_id === callbacks[0]!.invocation_id);
  expect(denied.some((event) => event.phase === "approval_verify" && event.outcome === "denied")).toBe(true);
  expect(denied.some((event) => event.phase === "local_commit")).toBe(false);
  const failed = snapshot.events.filter((event) => event.invocation_id === callbacks[1]!.invocation_id);
  expect(failed.some((event) => event.phase === "approval_verify" && event.outcome === "pass")).toBe(true);
  expect(failed.some((event) => event.phase === "local_commit" && event.outcome === "error")).toBe(true);
  expect(failed.find((event) => event.type === "invocation.finish")?.business).toBe("failed");
  expect(snapshot.events.filter((event) => event.phase === "approval_wait").every((event) => event.duration_ms === undefined)).toBe(true);
  expect(snapshot.events.some((event) => event.activity === "apps_write")).toBe(false);
  for (const secret of [state, owner, own.siwe, own.signature, own.delegationCid, pending.nonce, "PRIVATE_"]) {
    expect(JSON.stringify(snapshot)).not.toContain(String(secret));
  }
}, 30_000);

test("expired signed approvals are scoped to their verified tenant and cannot commit", async () => {
  const fixture = await approvalCapture();
  const owner = await ownerDid(REQUESTER_KEY);
  const history = await fixture.enable("PRIVATE_EXPIRED");
  const status = await fixture.connect("PRIVATE_EXPIRED", owner);
  const state = new URL(status.approvalUrl!).searchParams.get("state")!;
  const pending = await fixture.pending("PRIVATE_EXPIRED", state);
  const path = join(fixture.store.tenantStateRoot("PRIVATE_EXPIRED"), ".tinycloud/profiles/agent/pending", `${pending.nonce}.json`);
  await writeFile(path, JSON.stringify({ ...pending, expiresAt: new Date(Date.now() - 1000).toISOString() }));
  await expect(fixture.diagnostics.exchange(() => fixture.store.completeApproval(state, callbackRequest({}))))
    .rejects.toBeInstanceOf(ApprovalRequestError);
  expect(await exists(path)).toBe(false);
  await fixture.diagnostics.close();
  const snapshot = await history.snapshot({ all: true });
  expect(snapshot.events.filter((event) => event.outcome === "expired")).toMatchObject([
    { phase: "approval_wait", workflow_id: pending.diagnosticReference },
  ]);
  expect(snapshot.events.some((event) => event.phase === "approval_verify" || event.phase === "local_commit")).toBe(false);
}, 30_000);

test("a signed bootstrap approval with declined capabilities never reaches local commit", async () => {
  const fixture = await approvalCapture();
  const owner = await ownerDid(REQUESTER_KEY);
  const history = await fixture.enable("PRIVATE_DECLINED");
  const status = await fixture.connect("PRIVATE_DECLINED", owner);
  const state = new URL(status.approvalUrl!).searchParams.get("state")!;
  const stateRoot = fixture.store.tenantStateRoot("PRIVATE_DECLINED");
  const declined = await openKeyCallbackBody({
    tenantStateRoot: stateRoot, privateKey: REQUESTER_KEY, space: "account",
    abilities: { kv: { "spaces/": ["tinycloud.kv/get"] } },
  });
  await expect(fixture.diagnostics.exchange(() => fixture.store.completeApproval(state, callbackRequest(declined))))
    .rejects.toBeInstanceOf(Error);
  expect(await exists(join(stateRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
  await fixture.diagnostics.close();
  const snapshot = await history.snapshot({ all: true });
  expect(snapshot.events.filter((event) => event.type === "phase.finish" && event.phase === "approval_verify"))
    .toMatchObject([{ outcome: "denied" }]);
  expect(snapshot.events.some((event) => event.phase === "local_commit")).toBe(false);
  expect(snapshot.events.find((event) => event.type === "invocation.finish")?.business).toBe("failed");
}, 30_000);

async function approvalCapture() {
  const root = await mkdtemp(join(tmpdir(), "tinycloud-approval-diagnostics-"));
  directories.push(root);
  const historyRoot = join(root, "history");
  const config: RemoteStoreConfig = {
    stateDir: join(root, "state"),
    stateSecret: "synthetic-approval-secret-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "http://127.0.0.1:1",
    openkeyHost: "https://openkey.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
  };
  const diagnostics = new HostedDiagnostics({ root: historyRoot }, config.stateDir);
  cleanups.push(() => diagnostics.close());
  const store = new RemoteTenantStore(config, diagnostics);
  return {
    store, diagnostics, config, historyRoot,
    async enable(subject: string) {
      const partition = await resolveDiagnosticTenant(historyRoot, basename(store.tenantStateRoot(subject)), { create: true });
      const history = new DiagnosticStore(historyRoot, partition!);
      await history.control("enable", { scope: "tc-apps" });
      return history;
    },
    connect(subject: string, owner: string) {
      return diagnostics.exchange(() => diagnostics.tenant(basename(store.tenantStateRoot(subject)),
        () => store.connectStatus(subject, [owner]), true));
    },
    async pending(subject: string, state: string): Promise<Record<string, unknown>> {
      const nonce = state.split(".")[1]!;
      return JSON.parse(await readFile(join(store.tenantStateRoot(subject), ".tinycloud/profiles/agent/pending", `${nonce}.json`), "utf8"));
    },
  };
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
