import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, spyOn, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TinyCloudNode } from "@tinycloud/node-sdk";
import { invokeOperation } from "@tinycloud/operations";
import { RenewalRenewerChangedError } from "@tinycloud/sdk-core/delegations/renewal";

import { BOOTSTRAP_LEASE_SECONDS, RemoteTenantStore, TENANT_IDLE_MS, type ConnectStatus } from "./remote-store.js";
import { resetMcpRegistryFixture } from "./test-support/registry-fixture.mjs";
import {
  LINKS_API_ORIGIN,
  OPENKEY_API_ORIGIN,
  OPENKEY_ORIGIN,
  OTHER_OWNER_KEY,
  REQUESTER_KEY,
  installFakeOpenKey,
  openKeyDelegation,
  ownerDid,
  ownerRenewalLease,
  renewerIdentity,
  siweDelegationFromApproval,
  type ApprovalDelivery,
  type FakeOpenKey,
  type RenewerIdentity,
} from "./test-support/openkey-approval.js";

const BOOTSTRAP_ABILITIES = {
  kv: {
    "spaces/": ["tinycloud.kv/get", "tinycloud.kv/list"],
    "applications/": ["tinycloud.kv/get", "tinycloud.kv/list"],
  },
};
const OWNER_MISMATCH = { status: "rejected", stage: "owner", code: "APPROVAL_OWNER_MISMATCH" } as const;

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
let openkey: FakeOpenKey;

afterEach(async () => {
  try {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  } finally {
    resetMcpRegistryFixture();
  }
});

test("keeps hosted delegates isolated by OAuth subject", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const first = await store.connectStatus("openkey-user-a", [requester]);
  const second = await store.connectStatus("openkey-user-b", [requester]);
  const repeated = await store.connectStatus("openkey-user-a", [requester]);

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

test("a partial or unreadable stored session offers fresh approval without replacing the delegate key", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  for (const [subject, contents] of [
    ["partial-account", JSON.stringify({ delegationCid: "incomplete" })],
    ["unreadable-account", "{"],
  ]) {
    const initial = await store.connectStatus(subject, [requester]);
    const path = join(store.tenantStateRoot(subject), ".tinycloud/profiles/agent/session.json");
    await writeFile(path, contents);
    const renewed = await store.connectStatus(subject, [requester]);
    expect(renewed).toMatchObject({
      connected: false,
      sessionDid: initial.sessionDid,
      approvalUrl: expect.stringContaining("/connect?state="),
    });
    expect(await exists(path)).toBe(false);
  }
});

test("a new approval link refuses a signed session issued before the previous approval was cleared", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const subject = "renewed-account";
  const older = Date.now() - 60_000;
  const clock = spyOn(Date, "now").mockReturnValue(older);
  let first: ConnectStatus;
  let previous: Record<string, unknown>;
  try {
    first = await store.connectStatus(subject, [requester]);
    previous = await openKeyDelegation({
      tenantStateRoot: store.tenantStateRoot(subject),
      privateKey: REQUESTER_KEY,
      space: "account",
      abilities: BOOTSTRAP_ABILITIES,
    });
    expect(await deliver(store, subject, [requester], stateOf(first.approvalUrl!), previous))
      .toEqual({ status: "stored" });
  } finally {
    clock.mockRestore();
  }
  const sessionPath = join(store.tenantStateRoot(subject), ".tinycloud/profiles/agent/session.json");
  await writeFile(sessionPath, "{");
  const renewed = await store.connectStatus(subject, [requester]);
  const newState = stateOf(renewed.approvalUrl!);
  expect(renewed.approvalUrl).not.toBe(first!.approvalUrl);
  expect(await deliver(store, subject, [requester], newState, previous!))
    .toMatchObject({ status: "rejected", stage: "restore_approval" });
  expect(await exists(sessionPath)).toBe(false);
  const current = await openKeyDelegation({
    tenantStateRoot: store.tenantStateRoot(subject),
    privateKey: REQUESTER_KEY,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  expect(await deliver(store, subject, [requester], newState, current)).toEqual({ status: "stored" });
  expect(await exists(sessionPath)).toBe(true);
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
        session = await openKeyDelegation({
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
    const state = stateOf(String(details.approvalUrl));
    const { request } = await openkey.requestFor(await store.approvalLink(state));
    expect(request.reason).toContain(requester);
    expect(request.reason).not.toContain(foreignOwner);
    expect(request.permissions).toEqual([
      { service: "tinycloud.kv", space: "account", path: "spaces/", actions: BOOTSTRAP_ABILITIES.kv["spaces/"] },
      { service: "tinycloud.kv", space: "account", path: "applications/", actions: BOOTSTRAP_ABILITIES.kv["applications/"] },
    ]);
    const foreign = await openKeyDelegation({
      tenantStateRoot: stateRoot, privateKey: OTHER_OWNER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
    });
    expect(await deliver(store, subject, [requester], state, foreign)).toMatchObject(OWNER_MISMATCH);
  }
});

test("approval requests send OpenKey only the public delegate key", async () => {
  const store = await testStore();
  const status = await store.connectStatus("openkey-user-a", [await ownerDid(REQUESTER_KEY)]);
  const link = await store.approvalLink(stateOf(status.approvalUrl!));
  const { request } = await openkey.requestFor(link);
  const jwk = JSON.parse(await readFile(
    join(store.tenantStateRoot("openkey-user-a"), ".tinycloud/profiles/agent/key.json"),
    "utf8",
  )) as { d: string; x: string };

  expect(new URL(link).origin).toBe(OPENKEY_ORIGIN);
  expect(request.targetPublicJwk).toEqual({ kty: "OKP", crv: "Ed25519", x: jwk.x });
  expect(JSON.stringify(request)).not.toContain(jwk.d);
  expect(link).not.toContain(jwk.d);
  // The request names the delegate's key (its DID without the verification-method fragment).
  expect(request.issuer).toBe(status.sessionDid.split("#")[0]!);
  expect(request.targetDid).toBe(request.issuer);
  expect(request.permissions).toHaveLength(2);
  expect(openkey.calls.filter((call) => call.origin === LINKS_API_ORIGIN)).toEqual([
    { origin: LINKS_API_ORIGIN, path: "/v1/links" },
  ]);
});

test("connect refuses a session signed by another OpenKey owner before storing it", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const state = stateOf(status.approvalUrl!);

  const foreign = await openKeyDelegation({
    tenantStateRoot: tenantRoot,
    privateKey: OTHER_OWNER_KEY,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  expect(await deliver(store, "openkey-user-a", [requester], state, foreign)).toMatchObject(OWNER_MISMATCH);
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);

  // The requester's own approval, through the same link, is stored as the tenant session.
  const own = await openKeyDelegation({
    tenantStateRoot: tenantRoot,
    privateKey: REQUESTER_KEY,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  expect(await deliver(store, "openkey-user-a", [requester], state, own)).toEqual({ status: "stored" });
  expect(JSON.parse(await readFile(join(tenantRoot, ".tinycloud/profiles/agent/session.json"), "utf8")))
    .toMatchObject({ delegationCid: own.delegationCid, address: own.address });
});

test("approvals without the full signed proof are refused", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const state = stateOf(status.approvalUrl!);
  const own = await openKeyDelegation({
    tenantStateRoot: tenantRoot,
    privateKey: REQUESTER_KEY,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  for (const field of ["siwe", "signature", "address", "chainId"]) {
    const { [field]: _omitted, ...partial } = own;
    expect(await deliver(store, "openkey-user-a", [requester], state, partial, { ownerDid: requester }))
      .toMatchObject({ status: "rejected", stage: "restore_approval", code: "CALLBACK_INCOMPLETE" });
  }
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
});

test("delegation approvals from another owner are refused before anything is stored", async () => {
  const hermetic = await createHermeticNode();
  const store = await testStore(hermetic.host);
  const requester = hermetic.ownerDid;
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const connect = await store.connectStatus("openkey-user-a", [requester]);
  const bootstrap = await openKeyDelegation({
    tenantStateRoot: tenantRoot,
    privateKey: hermetic.ownerPrivateKey,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  await activateOnNode(hermetic.host, bootstrap);
  expect(await deliver(store, "openkey-user-a", [requester], stateOf(connect.approvalUrl!), bootstrap))
    .toEqual({ status: "stored" });

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
  const state = stateOf(decorated.approval.url);
  const { request } = await openkey.requestFor(await store.approvalLink(state));
  expect(request.reason).toContain(requester);

  const abilities = { kv: { "agents/demo/profile": ["tinycloud.kv/get"] } };
  const foreignApproval = await openKeyDelegation({
    tenantStateRoot: tenantRoot,
    privateKey: OTHER_OWNER_KEY,
    space: "applications",
    abilities,
  });
  const logged = openkey.diagnostics.length;
  expect(await deliver(store, "openkey-user-a", [requester], state, foreignApproval)).toMatchObject(OWNER_MISMATCH);
  expect(openkey.diagnostics.slice(logged).join("\n")).not.toContain(String(foreignApproval.address));
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/additional-delegations.json"))).toBe(false);

  // The requester's own approval is imported against the stored request.
  const ownApproval = await openKeyDelegation({
    tenantStateRoot: tenantRoot,
    privateKey: hermetic.ownerPrivateKey,
    space: "applications",
    abilities,
  });
  expect(await deliver(store, "openkey-user-a", [requester], state, ownApproval)).toEqual({ status: "stored" });
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
  const owners = [hermetic.ownerDid];
  const connect = await store.connectStatus("openkey-user-a", owners);
  const bootstrap = await openKeyDelegation({
    tenantStateRoot: tenantRoot,
    privateKey: hermetic.ownerPrivateKey,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  await activateOnNode(hermetic.host, bootstrap);
  expect(await deliver(store, "openkey-user-a", owners, stateOf(connect.approvalUrl!), bootstrap))
    .toEqual({ status: "stored" });
  const authority = await invokeOperation(
    "tinycloud.kv.get",
    1,
    { profile: "agent", stateRoot: tenantRoot },
    { space: "applications", key: "agents/demo/profile", representation: "json" },
  );
  const decorated = await store.decorateAuthorityResult("openkey-user-a", owners, authority) as {
    approval: { url: string };
  };
  // Correctly signed by the requester, but broader than what was requested.
  const broader = await openKeyDelegation({
    tenantStateRoot: tenantRoot,
    privateKey: hermetic.ownerPrivateKey,
    space: "applications",
    abilities: { kv: { "agents/": ["tinycloud.kv/get"] } },
  });
  const outside = await deliver(store, "openkey-user-a", owners, stateOf(decorated.approval.url), broader);
  // Exceeding the stored request is refused after activation, so it carries no activation reason.
  expect(outside).toEqual({ status: "rejected", stage: "auth_import", code: "DELEGATION_REJECTED", detail: "none" });
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/additional-delegations.json"))).toBe(false);

  // The same signed delegation planted in the store, with no binding or bound
  // to the narrower request, grants nothing on replay.
  const planted = await siweDelegationFromApproval(broader, tenantRoot, hermetic.host);
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

test("a stored session the node cannot confirm reports unavailable, not a new approval", async () => {
  const hermetic = await createHermeticNode();
  const store = await testStore(hermetic.host);
  const requester = hermetic.ownerDid;
  const connect = await store.connectStatus("openkey-user-a", [requester]);
  const bootstrap = await openKeyDelegation({
    tenantStateRoot: store.tenantStateRoot("openkey-user-a"),
    privateKey: hermetic.ownerPrivateKey,
    space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  await activateOnNode(hermetic.host, bootstrap);
  expect(await deliver(store, "openkey-user-a", [requester], stateOf(connect.approvalUrl!), bootstrap))
    .toEqual({ status: "stored" });
  const sessionPath = join(store.tenantStateRoot("openkey-user-a"), ".tinycloud/profiles/agent/session.json");

  expect(await store.connectStatus("openkey-user-a", [requester])).toMatchObject({ connected: true });
  hermetic.stop();
  const unavailable = await store.connectStatus("openkey-user-a", [requester]);
  expect(unavailable).toMatchObject({ connected: false, sessionDid: connect.sessionDid });
  expect(unavailable.approvalUrl).toBeUndefined();
  expect(unavailable.expiresAt).toBeUndefined();
  expect(await exists(sessionPath)).toBe(true);
});

test("approval results are fetched only from the configured OpenKey origin", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-mcp-"));
  directories.push(stateDir);
  const requester = await ownerDid(REQUESTER_KEY);
  const store = await testStore(undefined, stateDir);
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const link = await store.approvalLink(stateOf(status.approvalUrl!));
  await store.close();
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  await openkey.approve(link, await openKeyDelegation({
    tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  }));

  // The same state, served by a server configured with another OpenKey API origin.
  const moved = await testStore(undefined, stateDir, "https://api.elsewhere.test");
  const resultCalls = () => openkey.calls.filter((call) => call.path.startsWith("/api/")).length;
  const before = resultCalls();
  await moved.validateTenant("openkey-user-a", [requester]);
  expect(resultCalls()).toBe(before);
  expect(openkey.diagnostics).toContain("[tinycloud-mcp-http] approval dropped: reason=openkey_origin_changed");
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
  expect(await readdir(join(tenantRoot, ".tinycloud/profiles/agent/pending"))).toEqual([]);
});

test("a restarted server collects the approval its predecessor's link asked for", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-mcp-"));
  directories.push(stateDir);
  const requester = await ownerDid(REQUESTER_KEY);
  const before = await testStore(undefined, stateDir);
  const status = await before.connectStatus("openkey-user-a", [requester]);
  const link = await before.approvalLink(stateOf(status.approvalUrl!));
  await before.close();
  const tenantRoot = before.tenantStateRoot("openkey-user-a");
  const own = await openKeyDelegation({
    tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  });
  const { id } = await openkey.approve(link, own);

  const after = await testStore(undefined, stateDir);
  expect(await openkey.delivery(id, () => after.validateTenant("openkey-user-a", [requester])))
    .toEqual({ status: "stored" });
  expect(JSON.parse(await readFile(join(tenantRoot, ".tinycloud/profiles/agent/session.json"), "utf8")))
    .toMatchObject({ delegationCid: own.delegationCid });
});

test("concurrent calls store and acknowledge one approval once", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const link = await store.approvalLink(stateOf(status.approvalUrl!));
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const { id } = await openkey.approve(link, await openKeyDelegation({
    tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  }));

  await Promise.all([
    store.validateTenant("openkey-user-a", [requester]),
    store.validateTenant("openkey-user-a", [requester]),
    store.connectStatus("openkey-user-a", [requester]),
    store.validateTenant("openkey-user-a", [requester]),
  ]);
  expect(openkey.acknowledged(id)).toBe(true);
  expect(openkey.fetches(id)).toBe(1);
  expect(openkey.calls.filter((call) => call.path.endsWith("/ack"))).toHaveLength(1);
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(true);
});

test("a result OpenKey no longer holds leaves the link usable for a new approval", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const state = stateOf(status.approvalUrl!);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const own = await openKeyDelegation({
    tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  });
  const firstLink = await store.approvalLink(state);
  const { id } = await openkey.approve(firstLink, own);
  openkey.expireResult(id);
  expect(await openkey.delivery(id, () => store.validateTenant("openkey-user-a", [requester])))
    .toEqual({ status: "rejected", stage: "collect", code: "RESULT_EXPIRED" });
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);

  const secondLink = await store.approvalLink(state);
  expect(secondLink).not.toBe(firstLink);
  expect(await deliver(store, "openkey-user-a", [requester], state, own)).toEqual({ status: "stored" });
});

test("collection stops once a request and its result window have ended", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const status = await store.connectStatus("openkey-user-a", [requester]);
  await store.approvalLink(stateOf(status.approvalUrl!));
  await store.close();
  const resultCalls = () => openkey.calls.filter((call) => call.path.startsWith("/api/")).length;
  const before = resultCalls();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000);
  try {
    await store.validateTenant("openkey-user-a", [requester]);
  } finally {
    clock.mockRestore();
  }
  expect(resultCalls()).toBe(before);
  expect(await readdir(join(store.tenantStateRoot("openkey-user-a"), ".tinycloud/profiles/agent/pending")))
    .toEqual([]);
});

test("approval collection never logs keys, links or the approved delegation", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const state = stateOf(status.approvalUrl!);
  const jwk = JSON.parse(await readFile(join(tenantRoot, ".tinycloud/profiles/agent/key.json"), "utf8")) as {
    d: string;
  };
  const secrets: string[] = [jwk.d, state];
  for (const privateKey of [OTHER_OWNER_KEY, REQUESTER_KEY]) {
    const link = await store.approvalLink(state);
    const [pendingName] = await readdir(join(tenantRoot, ".tinycloud/profiles/agent/pending"));
    const pending = JSON.parse(await readFile(join(tenantRoot, ".tinycloud/profiles/agent/pending", pendingName!), "utf8")) as {
      openkey: { relayPrivateKey: string; ackId: string };
    };
    const delegation = await openKeyDelegation({
      tenantStateRoot: tenantRoot, privateKey, space: "account", abilities: BOOTSTRAP_ABILITIES,
    });
    const { id } = await openkey.approve(link, delegation);
    secrets.push(link, new URL(link).hash, pending.openkey.relayPrivateKey, pending.openkey.ackId,
      String(delegation.signature), String(delegation.siwe), String(record(delegation.delegationHeader).Authorization));
    await openkey.delivery(id, () => store.validateTenant("openkey-user-a", [requester]));
  }
  expect(openkey.diagnostics.some((line) => line.includes("approval result rejected:"))).toBe(true);
  const logged = openkey.diagnostics.join("\n");
  for (const secret of secrets) expect(logged).not.toContain(secret);
});

test("a result naming an owner other than the approval's signer is refused before anything is stored", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const link = await store.approvalLink(stateOf(status.approvalUrl!));
  const own = await openKeyDelegation({
    tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  });
  const { id } = await openkey.approve(link, own, { ownerDid: await ownerDid(OTHER_OWNER_KEY) });
  expect(await openkey.delivery(id, () => store.validateTenant("openkey-user-a", [requester])))
    .toMatchObject({ status: "rejected", stage: "restore_approval", code: "RESULT_OWNER_MISMATCH" });
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
  expect(openkey.acknowledged(id)).toBe(false);
  expect(openkey.fetches(id)).toBe(1);
});

test("an OpenKey result reply cut short or larger than the bound is refused, and nothing is stored", async () => {
  for (const reply of ["truncated", "oversize"] as const) {
    const store = await testStore();
    const requester = await ownerDid(REQUESTER_KEY);
    const tenantRoot = store.tenantStateRoot("openkey-user-a");
    const status = await store.connectStatus("openkey-user-a", [requester]);
    const link = await store.approvalLink(stateOf(status.approvalUrl!));
    const { id } = await openkey.approve(link, await openKeyDelegation({
      tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
    }));
    openkey.resultReply = reply;
    try {
      expect(await openkey.delivery(id, () => store.validateTenant("openkey-user-a", [requester])))
        .toMatchObject({ status: "rejected", stage: "collect", code: "RESULT_INVALID" });
    } finally {
      openkey.resultReply = "sealed";
    }
    expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
    expect(openkey.acknowledged(id)).toBe(false);
    expect(openkey.fetches(id)).toBe(1);
  }
});

test("a call waits on a slow OpenKey for at most its collection budget", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const link = await store.approvalLink(stateOf(status.approvalUrl!));
  const { id } = await openkey.approve(link, await openKeyDelegation({
    tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  }));
  openkey.replyDelayMs = 30_000;
  try {
    const started = performance.now();
    expect(await store.connectStatus("openkey-user-a", [requester])).toMatchObject({ connected: false });
    expect(performance.now() - started).toBeLessThan(5_000);
  } finally {
    openkey.replyDelayMs = 0;
  }
  // The held attempts end at their own timeouts; the link's result is collected afterwards.
  expect(await openkey.delivery(id, () => store.validateTenant("openkey-user-a", [requester])))
    .toEqual({ status: "stored" });
});

test("a claimed result becomes collectable again by its claim time, not its file time", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-mcp-"));
  directories.push(stateDir);
  const requester = await ownerDid(REQUESTER_KEY);
  const before = await testStore(undefined, stateDir);
  const status = await before.connectStatus("openkey-user-a", [requester]);
  const link = await before.approvalLink(stateOf(status.approvalUrl!));
  await before.close();
  const tenantRoot = before.tenantStateRoot("openkey-user-a");
  const { id } = await openkey.approve(link, await openKeyDelegation({
    tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  }));
  // A server claimed the result and stopped mid-way; the claim file keeps the pending file's older mtime.
  const pendingDir = join(tenantRoot, ".tinycloud/profiles/agent/pending");
  const [name] = await readdir(pendingDir);
  const pending = JSON.parse(await readFile(join(pendingDir, name!), "utf8")) as Record<string, unknown>;
  const claimed = join(pendingDir, `${name!}.processing`);
  const claim = async (minutesAgo: number) => {
    await writeFile(claimed, JSON.stringify({ ...pending, claimedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() }));
    const fileTime = new Date(Date.now() - 60 * 60_000);
    await utimes(claimed, fileTime, fileTime);
  };
  await rm(join(pendingDir, name!));
  await claim(1);

  const after = await testStore(undefined, stateDir);
  await after.validateTenant("openkey-user-a", [requester]);
  expect(openkey.fetches(id)).toBe(0);
  expect(await exists(claimed)).toBe(true);

  await claim(5);
  expect(await openkey.delivery(id, () => after.validateTenant("openkey-user-a", [requester])))
    .toEqual({ status: "stored" });
  expect(await exists(claimed)).toBe(false);
});

test("a link whose request names other OpenKey origins opens a new request on the configured ones", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-mcp-"));
  directories.push(stateDir);
  const requester = await ownerDid(REQUESTER_KEY);
  const before = await testStore(undefined, stateDir);
  const status = await before.connectStatus("openkey-user-a", [requester]);
  const state = stateOf(status.approvalUrl!);
  const firstLink = await before.approvalLink(state);
  await before.close();

  const moved = await testStore(undefined, stateDir, "https://api.elsewhere.test");
  const resultCalls = () => openkey.calls.filter((call) => call.path.startsWith("/api/")).length;
  const calls = resultCalls();
  const secondLink = await moved.approvalLink(state);
  await moved.close();
  expect(secondLink).not.toBe(firstLink);
  expect(openkey.diagnostics).toContain("[tinycloud-mcp-http] approval dropped: reason=openkey_origin_changed");
  expect(await openkey.requestFor(secondLink)).toBeDefined();
  const pendingDir = join(moved.tenantStateRoot("openkey-user-a"), ".tinycloud/profiles/agent/pending");
  const [name] = await readdir(pendingDir);
  expect(JSON.parse(await readFile(join(pendingDir, name!), "utf8")))
    .toMatchObject({ openkey: { apiOrigin: "https://api.elsewhere.test", link: secondLink } });
  expect(resultCalls()).toBe(calls);
});

test("a bootstrap request asks for the renewal lease, and a pending request without that ask is not reused", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const state = stateOf(status.approvalUrl!);
  const link = await store.approvalLink(state);
  expect((await openkey.requestFor(link)).request.renewal)
    .toEqual({ version: 1, leaseLifetimeSeconds: BOOTSTRAP_LEASE_SECONDS });
  expect((await store.connectStatus("openkey-user-a", [requester])).approvalUrl).toBe(status.approvalUrl);

  // The same pending approval as an earlier server wrote it, before it asked for a lease.
  const pendingDir = join(store.tenantStateRoot("openkey-user-a"), ".tinycloud/profiles/agent/pending");
  const [name] = await readdir(pendingDir);
  const pending = JSON.parse(await readFile(join(pendingDir, name!), "utf8")) as {
    openkey: { request: Record<string, unknown> };
  };
  const { renewal: _renewal, ...request } = pending.openkey.request;
  await writeFile(join(pendingDir, name!), JSON.stringify({ ...pending, openkey: { ...pending.openkey, request } }));
  const next = await store.connectStatus("openkey-user-a", [requester]);
  expect(stateOf(next.approvalUrl!)).not.toBe(state);
});

test("a leased approval is admitted at the node and stored with its lease", async () => {
  const node = renewalNode(renewerIdentity());
  const store = await testStore(node.host);
  const requester = await ownerDid(REQUESTER_KEY);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const own = await openKeyDelegation({
    tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  });
  const renewal = await ownerRenewalLease({
    privateKey: REQUESTER_KEY, original: own, identity: node.identity, lifetimeSeconds: BOOTSTRAP_LEASE_SECONDS,
  });
  expect(await deliver(store, "openkey-user-a", [requester], stateOf(status.approvalUrl!), own, { renewal }))
    .toEqual({ status: "stored" });
  expect(node.admitted).toEqual([renewal.receipt.leaseAuthorization]);
  expect(JSON.parse(await readFile(join(tenantRoot, ".tinycloud/profiles/agent/session.json"), "utf8"))).toMatchObject({
    delegationCid: own.delegationCid,
    renewal: { receipt: { leaseCid: renewal.receipt.leaseCid, leaseExpiresAt: renewal.receipt.leaseExpiresAt } },
  });
});

test("a lease the node would never renew is refused before anything is stored", async () => {
  const cases = [
    { code: "RENEWAL_LEASE_MISMATCH", leaseKey: OTHER_OWNER_KEY, advertised: undefined, grantMinutes: 60 },
    { code: "RENEWAL_RENEWER_CHANGED", leaseKey: REQUESTER_KEY, advertised: renewerIdentity(1), grantMinutes: 60 },
    { code: "RENEWAL_GRANT_ENDS_TOO_SOON", leaseKey: REQUESTER_KEY, advertised: undefined, grantMinutes: 10 },
  ];
  for (const { code, leaseKey, advertised, grantMinutes } of cases) {
    const node = renewalNode(renewerIdentity());
    const store = await testStore(node.host);
    const requester = await ownerDid(REQUESTER_KEY);
    const tenantRoot = store.tenantStateRoot("openkey-user-a");
    const status = await store.connectStatus("openkey-user-a", [requester]);
    const link = await store.approvalLink(stateOf(status.approvalUrl!));
    const own = await openKeyDelegation({
      tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
      expiresAt: new Date(Date.now() + grantMinutes * 60_000),
    });
    const renewal = await ownerRenewalLease({
      privateKey: leaseKey, original: own, identity: node.identity, lifetimeSeconds: BOOTSTRAP_LEASE_SECONDS,
    });
    // The node replaced its renewer after OpenKey issued the lease.
    if (advertised !== undefined) node.identity = advertised;
    const { id } = await openkey.approve(link, own, { renewal });
    expect(await openkey.delivery(id, () => store.validateTenant("openkey-user-a", [requester])), code)
      .toMatchObject({ status: "rejected", stage: "renewal", code });
    expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
    expect(openkey.acknowledged(id)).toBe(false);
    expect(node.admitted).toEqual([]);
  }
});

test("a lease the node cannot admit yet is admitted on a later collection", async () => {
  const node = renewalNode(renewerIdentity());
  const store = await testStore(node.host);
  const requester = await ownerDid(REQUESTER_KEY);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const link = await store.approvalLink(stateOf(status.approvalUrl!));
  const own = await openKeyDelegation({
    tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  });
  const renewal = await ownerRenewalLease({
    privateKey: REQUESTER_KEY, original: own, identity: node.identity, lifetimeSeconds: BOOTSTRAP_LEASE_SECONDS,
  });
  node.admissionStatus = 503;
  const { id } = await openkey.approve(link, own, { renewal });
  expect(await store.connectStatus("openkey-user-a", [requester])).toMatchObject({ connected: false });
  expect(openkey.diagnostics).toContain("[tinycloud-mcp-http] approval renewal admission deferred: code=NODE_UNAVAILABLE");
  expect(openkey.diagnostics.some((line) => line.includes("approval result rejected:"))).toBe(false);
  expect(openkey.acknowledged(id)).toBe(false);
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);

  node.admissionStatus = 200;
  expect(await openkey.delivery(id, () => store.validateTenant("openkey-user-a", [requester])))
    .toEqual({ status: "stored" });
  expect(node.admitted.at(-1)).toBe(renewal.receipt.leaseAuthorization);
});

test("past its signed end, a leased session asks again once its renewer changed, and is unavailable while the node cannot answer", async () => {
  const node = renewalNode(renewerIdentity());
  const store = await testStore(node.host);
  const requester = await ownerDid(REQUESTER_KEY);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const own = await openKeyDelegation({
    tenantStateRoot: tenantRoot, privateKey: REQUESTER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  });
  const renewal = await ownerRenewalLease({
    privateKey: REQUESTER_KEY, original: own, identity: node.identity, lifetimeSeconds: BOOTSTRAP_LEASE_SECONDS,
  });
  expect(await deliver(store, "openkey-user-a", [requester], stateOf(status.approvalUrl!), own, { renewal }))
    .toEqual({ status: "stored" });
  const sessionPath = join(tenantRoot, ".tinycloud/profiles/agent/session.json");

  // Two hours on, the one-hour grant has passed its signed end; only the lease can carry it, and node-sdk's
  // renewal restore answers for the node.
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60_000);
  const renewalRestore = spyOn(TinyCloudNode.prototype, "restoreSessionWithRenewal");
  try {
    renewalRestore.mockRejectedValue(new TypeError("fetch failed"));
    const unavailable = await store.connectStatus("openkey-user-a", [requester]);
    expect(unavailable).toMatchObject({ connected: false });
    expect(unavailable.approvalUrl).toBeUndefined();

    renewalRestore.mockRejectedValue(new RenewalRenewerChangedError());
    const changed = await store.connectStatus("openkey-user-a", [requester]);
    expect(changed).toMatchObject({ connected: false });
    expect(changed.approvalUrl).toBeDefined();
    expect(renewalRestore).toHaveBeenCalledTimes(2);
  } finally {
    renewalRestore.mockRestore();
    clock.mockRestore();
  }
  expect(await exists(sessionPath)).toBe(true);
});

test("a link's background poll runs every 2 s for its first minute, then every 10 s", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const timers = spyOn(globalThis, "setTimeout");
  const delays = () => timers.mock.calls.map((call) => call[1]);
  let clock: ReturnType<typeof spyOn> | undefined;
  try {
    const opened = Date.now();
    await store.approvalLink(stateOf(status.approvalUrl!));
    expect(delays()).toContain(2_000);
    expect(delays()).not.toContain(10_000);
    // A minute on, the next poll is scheduled 10 s out. The poll's own 2 s timer must fire for real: its
    // tick awaits OpenKey I/O, which fake timers do not drive; the wait ends as soon as it reschedules.
    clock = spyOn(Date, "now").mockReturnValue(opened + 61_000);
    for (let waited = 0; !delays().includes(10_000) && waited < 5_000; waited += 50) await Bun.sleep(50);
    expect(delays()).toContain(10_000);
  } finally {
    clock?.mockRestore();
    timers.mockRestore();
    await store.close();
  }
});

test("at most 64 links are polled in the background; the next call collects the rest", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const opened: Array<{ subject: string; link: string; id: string }> = [];
  for (let index = 0; index <= 64; index++) {
    const subject = `openkey-user-${index}`;
    const status = await store.connectStatus(subject, [requester]);
    const link = await store.approvalLink(stateOf(status.approvalUrl!));
    opened.push({ subject, link, id: (await openkey.requestFor(link)).id });
  }
  // The polls' first 2 s timers fire for real (each tick awaits OpenKey I/O, which fake timers do not
  // drive); the wait ends once every polled link was asked.
  const discovered = (id: string) =>
    openkey.calls.some((call) => call.path === `/api/approval-requests/${id}/result`);
  for (let waited = 0; !opened.slice(0, 64).every(({ id }) => discovered(id)) && waited < 10_000; waited += 100) {
    await Bun.sleep(100);
  }
  expect(opened.slice(0, 64).every(({ id }) => discovered(id))).toBe(true);
  const last = opened[64]!;
  expect(discovered(last.id)).toBe(false);

  const { id } = await openkey.approve(last.link, await openKeyDelegation({
    tenantStateRoot: store.tenantStateRoot(last.subject), privateKey: REQUESTER_KEY, space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  }));
  expect(await openkey.delivery(id, () => store.validateTenant(last.subject, [requester]))).toEqual({ status: "stored" });
}, 60_000);

test("one tenant's links hold at most four background polls, so other tenants' links are polled", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const greedy = "openkey-user-greedy";
  const links: Array<{ link: string; id: string }> = [];
  for (let index = 0; index < 6; index++) {
    const decorated = await store.decorateAuthorityResult(greedy, [requester], {
      status: "authority_required",
      operation: "tinycloud.kv.get",
      request: {
        requestId: `request-${index}`,
        requested: [{ service: "tinycloud.kv", space: "applications", path: `agents/demo-${index}`, actions: ["tinycloud.kv/get"] }],
      },
    }) as { approval: { url: string } };
    const link = await store.approvalLink(stateOf(decorated.approval.url));
    links.push({ link, id: (await openkey.requestFor(link)).id });
  }
  const other = await store.connectStatus("openkey-user-other", [requester]);
  const otherLink = await store.approvalLink(stateOf(other.approvalUrl!));
  const otherId = (await openkey.requestFor(otherLink)).id;
  const asked = (id: string) => openkey.calls.some((call) => call.path === `/api/approval-requests/${id}/result`);
  for (let waited = 0; !(asked(otherId) && links.slice(0, 4).every(({ id }) => asked(id))) && waited < 10_000; waited += 100) {
    await Bun.sleep(100);
  }
  expect(asked(otherId)).toBe(true);
  expect(links.slice(0, 4).every(({ id }) => asked(id))).toBe(true);
  expect(links.slice(4).some(({ id }) => asked(id))).toBe(false);
}, 30_000);

test("an approval link needs the account that requested it, and a stored link without one stores nothing", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  await expect(store.connectStatus("openkey-user-a", [])).rejects.toThrow("needs the account that requested it");

  const status = await store.connectStatus("openkey-user-b", [requester]);
  const state = stateOf(status.approvalUrl!);
  const pendingDirectory = join(store.tenantStateRoot("openkey-user-b"), ".tinycloud/profiles/agent/pending");
  const [pendingName] = await readdir(pendingDirectory);
  const pendingPath = join(pendingDirectory, pendingName!);
  const pending = JSON.parse(await readFile(pendingPath, "utf8")) as Record<string, unknown>;
  await writeFile(pendingPath, JSON.stringify({ ...pending, ownerDids: [] }));
  const signed = await openKeyDelegation({
    tenantStateRoot: store.tenantStateRoot("openkey-user-b"), privateKey: REQUESTER_KEY, space: "account",
    abilities: BOOTSTRAP_ABILITIES,
  });
  expect(await deliver(store, "openkey-user-b", [requester], state, signed)).toMatchObject(OWNER_MISMATCH);
  expect(await exists(join(store.tenantStateRoot("openkey-user-b"), ".tinycloud/profiles/agent/session.json"))).toBe(false);
});

test("the OpenKey API origin must use https", async () => {
  const config = {
    stateDir: "/var/empty",
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
  };
  expect(() => new RemoteTenantStore({ ...config, openkeyHost: "https://openkey.test", openkeyApiHost: "http://api.openkey.test" }))
    .toThrow("The OpenKey API origin must use https.");
  expect(() => new RemoteTenantStore({ ...config, openkeyHost: "http://openkey.test" }))
    .toThrow("The OpenKey API origin must use https.");
  expect(() => new RemoteTenantStore({ ...config, openkeyHost: "https://openkey.test", openkeyApiHost: "https://api.openkey.test" }))
    .not.toThrow();
});

test("createPending refuses an empty owner list for every kind of approval link", async () => {
  const store = await testStore();
  await expect(store.decorateAuthorityResult("openkey-user-a", [], {
    status: "authority_required",
    operation: "tinycloud.kv.get",
    request: {
      requestId: "request-empty-owners",
      requested: [{ service: "tinycloud.kv", space: "applications", path: "agents/demo", actions: ["tinycloud.kv/get"] }],
    },
  })).rejects.toThrow("needs the account that requested it");
  await expect(store.decorateAuthorityResult("openkey-user-a", [], {
    status: "error",
    operation: "tinycloud.kv.get",
    error: { code: "SESSION_NOT_FOUND" },
  })).rejects.toThrow("needs the account that requested it");
  expect(await readdir(join(store.tenantStateRoot("openkey-user-a"), ".tinycloud/profiles/agent/pending")).catch(() => []))
    .toEqual([]);
});

test("a wallet outside the link's accounts cannot become the owner of a first approval", async () => {
  const store = await testStore();
  const requester = await ownerDid(REQUESTER_KEY);
  const status = await store.connectStatus("openkey-user-a", [requester]);
  const tenantRoot = store.tenantStateRoot("openkey-user-a");
  const foreign = await openKeyDelegation({
    tenantStateRoot: tenantRoot, privateKey: OTHER_OWNER_KEY, space: "account", abilities: BOOTSTRAP_ABILITIES,
  });
  expect(await deliver(store, "openkey-user-a", [requester], stateOf(status.approvalUrl!), foreign)).toMatchObject(OWNER_MISMATCH);
  const profile = JSON.parse(await readFile(join(tenantRoot, ".tinycloud/profiles/agent/profile.json"), "utf8")) as Record<string, unknown>;
  expect(profile.ownerDid).toBeUndefined();
  expect(await exists(join(tenantRoot, ".tinycloud/profiles/agent/session.json"))).toBe(false);
});

test("an idle tenant loses its key and authority after retirement; a recent call keeps a tenant across a restart", async () => {
  const hermetic = await createHermeticNode();
  const store = await testStore(hermetic.host);
  const requester = hermetic.ownerDid;
  const subjects = ["openkey-user-idle", "openkey-user-called", "openkey-user-marked"];
  const sessionDids = new Map<string, string>();
  for (const subject of subjects) {
    const connect = await store.connectStatus(subject, [requester]);
    const bootstrap = await openKeyDelegation({
      tenantStateRoot: store.tenantStateRoot(subject), privateKey: hermetic.ownerPrivateKey, space: "account",
      abilities: BOOTSTRAP_ABILITIES,
    });
    await activateOnNode(hermetic.host, bootstrap);
    expect(await deliver(store, subject, [requester], stateOf(connect.approvalUrl!), bootstrap))
      .toEqual({ status: "stored" });
    sessionDids.set(subject, connect.sessionDid);
  }
  // A scoped approval left open on the idle tenant goes with it.
  const idleRoot = store.tenantStateRoot("openkey-user-idle");
  const authority = await invokeOperation(
    "tinycloud.kv.get", 1, { profile: "agent", stateRoot: idleRoot },
    { space: "applications", key: "agents/demo/profile", representation: "json" },
  );
  const { approval } = await store.decorateAuthorityResult("openkey-user-idle", [requester], authority) as {
    approval: { url: string };
  };
  await store.approvalLink(stateOf(approval.url));
  expect(await readdir(join(idleRoot, ".tinycloud/profiles/agent/pending"))).not.toHaveLength(0);
  const stateDir = dirname(dirname(store.tenantStateRoot(subjects[0]!)));
  await store.close();

  // Every key and session was written before the idle threshold; only "marked" has a recent persisted call.
  const old = new Date(Date.now() - TENANT_IDLE_MS - 60_000);
  const exposuresPath = join(idleRoot, ".tinycloud/lease-exposures.json");
  const exposures = JSON.parse(await readFile(exposuresPath, "utf8")) as {
    pending: Record<string, { createdAt: number; expiresAt: number }>;
  };
  for (const entry of Object.values(exposures.pending)) {
    entry.createdAt = old.getTime() - 300_000;
    entry.expiresAt = old.getTime();
  }
  await writeFile(exposuresPath, JSON.stringify(exposures));
  for (const subject of subjects) {
    const files = [".tinycloud/profiles/agent/key.json", ".tinycloud/profiles/agent/session.json"];
    if (subject !== "openkey-user-marked") files.push(".tinycloud/last-call");
    for (const file of files) await utimes(join(store.tenantStateRoot(subject), file), old, old);
  }
  const restarted = await testStore(hermetic.host, stateDir);
  expect(await restarted.connectStatus("openkey-user-called", [requester])).toMatchObject({ connected: true });
  const upstream = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "POST" && url === `${hermetic.host}/session/retire`) return Response.json({ recorded: true });
    return upstream(input, init);
  }, upstream);
  try {
    expect(await restarted.sweepIdleTenants()).toBe(1);
  } finally {
    globalThis.fetch = upstream;
  }

  expect(await exists(restarted.tenantStateRoot("openkey-user-idle"))).toBe(false);
  for (const subject of ["openkey-user-called", "openkey-user-marked"]) {
    expect(await restarted.connectStatus(subject, [requester]))
      .toEqual({ connected: true, sessionDid: sessionDids.get(subject)! });
  }
  const reconnect = await restarted.connectStatus("openkey-user-idle", [requester]);
  expect(reconnect).toMatchObject({ connected: false, approvalUrl: expect.any(String) });
  expect(reconnect.sessionDid).not.toBe(sessionDids.get("openkey-user-idle")!);
  expect(await restarted.sweepIdleTenants()).toBe(0);
});

/**
 * Open a `/connect` link's OpenKey request, approve it with `delegation`, and
 * drive collection with the tenant's next call until the result is stored or refused.
 */
async function deliver(
  store: RemoteTenantStore,
  subject: string,
  ownerDids: readonly string[],
  state: string,
  delegation: Record<string, unknown>,
  options: Parameters<FakeOpenKey["approve"]>[2] = {},
): Promise<ApprovalDelivery> {
  const link = await store.approvalLink(state);
  const { id } = await openkey.approve(link, delegation, options);
  return openkey.delivery(id, () => store.validateTenant(subject, ownerDids));
}

function stateOf(approvalUrl: string): string {
  return new URL(approvalUrl).searchParams.get("state")!;
}

interface RenewalNode {
  readonly host: string;
  /** The renewer the node advertises; a test replaces it to model a renewer change. */
  identity: RenewerIdentity;
  /** HTTP status lease admission answers with. */
  admissionStatus: number;
  /** Lease authorizations the node admitted. */
  readonly admitted: string[];
}

/** A loopback node that advertises a renewer and admits owner leases; nothing else. */
function renewalNode(identity: RenewerIdentity): RenewalNode {
  const admitted: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/tinycloud/node-keys") return Response.json(node.identity);
      if (path === "/delegate" && request.method === "POST") {
        if (node.admissionStatus !== 200) return new Response("unavailable", { status: node.admissionStatus });
        admitted.push(request.headers.get("authorization") ?? "");
        return Response.json({ cid: "admitted", activated: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const node: RenewalNode = { host: server.url.origin, identity, admissionStatus: 200, admitted };
  cleanups.push(async () => server.stop(true));
  return node;
}

async function activateOnNode(host: string, delegation: Record<string, unknown>): Promise<void> {
  const header = record(delegation.delegationHeader).Authorization;
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
    "./test-support/hermetic-node.mjs",
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

/**
 * A store whose OpenKey is the fake, installed over any loopback node fixture
 * the test started first. Several stores in one test share the fake.
 */
async function testStore(
  nodeHost = "https://node.tinycloud.test",
  existingStateDir?: string,
  openkeyApiHost = OPENKEY_API_ORIGIN,
): Promise<RemoteTenantStore> {
  const stateDir = existingStateDir ?? await mkdtemp(join(tmpdir(), "tinycloud-hosted-mcp-"));
  if (existingStateDir === undefined) directories.push(stateDir);
  if (!cleanups.some((cleanup) => cleanup === restoreOpenKey)) {
    openkey = installFakeOpenKey();
    cleanups.unshift(restoreOpenKey);
  }
  const store = new RemoteTenantStore({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost,
    openkeyHost: OPENKEY_ORIGIN,
    openkeyApiHost,
    linksApiOrigin: LINKS_API_ORIGIN,
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
  });
  cleanups.push(() => store.close());
  return store;
}

async function restoreOpenKey(): Promise<void> {
  openkey.restore();
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
