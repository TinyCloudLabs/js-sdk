import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, spyOn, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invokeOperation } from "@tinycloud/operations";

import { RemoteTenantStore, type ConnectStatus } from "./remote-store.js";
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
  siweDelegationFromApproval,
  type ApprovalDelivery,
  type FakeOpenKey,
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
  const status = await store.connectStatus("openkey-user-a");
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
  options: { readonly ownerDid?: string } = {},
): Promise<ApprovalDelivery> {
  const link = await store.approvalLink(state);
  const { id } = await openkey.approve(link, delegation, options);
  return openkey.delivery(id, () => store.validateTenant(subject, ownerDids));
}

function stateOf(approvalUrl: string): string {
  return new URL(approvalUrl).searchParams.get("state")!;
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
