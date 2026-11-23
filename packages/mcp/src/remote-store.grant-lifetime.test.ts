import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BOOTSTRAP_LEASE_SECONDS, RemoteTenantStore, TENANT_IDLE_MS } from "./remote-store.js";
import { resetMcpRegistryFixture } from "./test-support/registry-fixture.mjs";
import {
  LINKS_API_ORIGIN,
  OPENKEY_API_ORIGIN,
  OPENKEY_ORIGIN,
  REQUESTER_KEY,
  installFakeOpenKey,
  openKeyDelegation,
  ownerDid,
  type FakeOpenKey,
} from "./test-support/openkey-approval.js";

const DAY = 86_400;
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  try {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  } finally {
    resetMcpRegistryFixture();
  }
});

const SCOPED_AUTHORITY = {
  status: "authority_required",
  operation: "tinycloud.kv.get",
  request: {
    requestId: "request-task",
    requested: [{ service: "tinycloud.kv", space: "applications", path: "agents/demo", actions: ["tinycloud.kv/get"] }],
  },
} as const;

test("the signed connection request is standing, asks for up to 30 days and a 90 day lease, and reaches no secrets; a scoped task request is 1 hour with no lease and no purpose", async () => {
  const { store, openkey } = await storeWith({ delegationExpiry: "1h" });
  const requester = await ownerDid(REQUESTER_KEY);

  const connect = await store.connectStatus("openkey-user-a", [requester]);
  const bootstrap = (await openkey.requestFor(await store.approvalLink(stateOf(connect.approvalUrl!)))).request;
  // The request carries the signed maximums. What the owner approves, and whether the lease stays ticked, is OpenKey's screen.
  expect(bootstrap.grantLifetimeSeconds).toBe(30 * DAY);
  expect(bootstrap.purpose).toBe("standing");
  expect(bootstrap.renewal).toEqual({ version: 1, leaseLifetimeSeconds: 90 * DAY });
  expect(BOOTSTRAP_LEASE_SECONDS).toBe(90 * DAY);
  // Only plain key-value reads of the account's two listings: nothing that reaches secrets or decryption (OpenKey's Once tier).
  expect(bootstrap.permissions.map((permission) => [permission.service, permission.path, ...permission.actions].join(" ")).sort())
    .toEqual(["tinycloud.kv applications/ tinycloud.kv/get tinycloud.kv/list", "tinycloud.kv spaces/ tinycloud.kv/get tinycloud.kv/list"]);

  const scoped = await store.decorateAuthorityResult("openkey-user-a", [requester], SCOPED_AUTHORITY) as {
    approval: { url: string };
  };
  const task = (await openkey.requestFor(await store.approvalLink(stateOf(scoped.approval.url)))).request;
  expect(task.grantLifetimeSeconds).toBe(3600);
  expect(task.renewal).toBeUndefined();
  expect(task.purpose).toBeUndefined();
  expect(task.permissions.flatMap((permission) => permission.actions)).toEqual(["tinycloud.kv/get"]);
});

test("the configured connection lifetime changes only the connection request, and a task lifetime changes only tasks", async () => {
  const { store, openkey } = await storeWith({ delegationExpiry: "2h", bootstrapDelegationExpiry: "7d" });
  const requester = await ownerDid(REQUESTER_KEY);

  const connect = await store.connectStatus("openkey-user-a", [requester]);
  expect((await openkey.requestFor(await store.approvalLink(stateOf(connect.approvalUrl!)))).request.grantLifetimeSeconds)
    .toBe(7 * DAY);
  const scoped = await store.decorateAuthorityResult("openkey-user-a", [requester], SCOPED_AUTHORITY) as {
    approval: { url: string };
  };
  expect((await openkey.requestFor(await store.approvalLink(stateOf(scoped.approval.url)))).request.grantLifetimeSeconds)
    .toBe(7200);
});

test("a connection lifetime shorter than a minute is refused at start", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tinycloud-hosted-mcp-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  expect(() => new RemoteTenantStore({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: OPENKEY_ORIGIN,
    openkeyApiHost: OPENKEY_API_ORIGIN,
    linksApiOrigin: LINKS_API_ORIGIN,
    approvalTtlSeconds: 300,
    delegationExpiry: "1h",
    bootstrapDelegationExpiry: "30s",
  })).toThrow("must be a duration of at least 60 seconds");
});

test("a scoped approval opened under a longer task lifetime is not served again, collected or stored; one within the ceiling is reused", async () => {
  const requester = await ownerDid(REQUESTER_KEY);
  const subject = "openkey-user-a";
  const { store: longer, openkey, stateDir } = await storeWith({ delegationExpiry: "30d" });
  const old = await longer.decorateAuthorityResult(subject, [requester], SCOPED_AUTHORITY) as { approval: { url: string } };
  const oldState = stateOf(old.approval.url);
  const oldLink = await longer.approvalLink(oldState);
  const oldRequest = await openkey.requestFor(oldLink);
  expect(oldRequest.request.grantLifetimeSeconds).toBe(30 * DAY);
  // The owner already approved it, before the server's task lifetime came down to an hour.
  await openkey.approve(oldLink, await openKeyDelegation({
    tenantStateRoot: longer.tenantStateRoot(subject),
    privateKey: REQUESTER_KEY,
    space: "applications",
    abilities: { kv: { "agents/demo": ["tinycloud.kv/get"] } },
  }));
  await longer.close();

  const { store: shorter } = await storeWith({ delegationExpiry: "1h" }, stateDir);
  const pendingDir = join(shorter.tenantStateRoot(subject), ".tinycloud/profiles/agent/pending");
  const files = await readdir(pendingDir);
  const before = await Promise.all(files.map((name) => readFile(join(pendingDir, name), "utf8")));
  const logged = openkey.diagnostics.length;

  // Collection holds it: the result is never fetched, so never admitted or stored, and the file is untouched.
  await shorter.validateTenant(subject, [requester]);
  expect(openkey.fetches(oldRequest.id)).toBe(0);
  expect(openkey.diagnostics.slice(logged)).toContain("[tinycloud-mcp-http] approval held: reason=grant_lifetime_over_ceiling");
  expect(await exists(join(shorter.tenantStateRoot(subject), ".tinycloud/profiles/agent/additional-delegations.json"))).toBe(false);
  expect(await Promise.all((await readdir(pendingDir)).map((name) => readFile(join(pendingDir, name), "utf8")))).toEqual(before);

  // The owner's next visit asks again, within the ceiling, and a repeat visit reuses that request.
  const newLink = await shorter.approvalLink(oldState);
  expect(newLink).not.toBe(oldLink);
  expect(openkey.diagnostics).toContain("[tinycloud-mcp-http] approval dropped: reason=grant_lifetime_over_ceiling");
  expect((await openkey.requestFor(newLink)).request.grantLifetimeSeconds).toBe(3600);
  expect(await shorter.approvalLink(oldState)).toBe(newLink);
});

test("a connection approval opened with another lease, or without a standing purpose, is replaced by the current ask", async () => {
  const requester = await ownerDid(REQUESTER_KEY);
  const subject = "openkey-user-a";
  const { store, openkey } = await storeWith({ delegationExpiry: "1h" });
  const first = await store.connectStatus(subject, [requester]);
  const firstState = stateOf(first.approvalUrl!);
  const firstLink = await store.approvalLink(firstState);
  const pendingDir = join(store.tenantStateRoot(subject), ".tinycloud/profiles/agent/pending");
  const [name] = await readdir(pendingDir);
  const path = join(pendingDir, name!);
  const pending = JSON.parse(await readFile(path, "utf8")) as { openkey: { request: Record<string, unknown> } };

  for (const [label, request] of [
    ["a 30 day lease", { ...pending.openkey.request, renewal: { version: 1, leaseLifetimeSeconds: 30 * DAY } }],
    ["no standing purpose", Object.fromEntries(Object.entries(pending.openkey.request).filter(([key]) => key !== "purpose"))],
  ] as const) {
    await writeFile(path, JSON.stringify({ ...pending, openkey: { ...pending.openkey, request } }));
    // A newly served connection link is a new, compliant request; the older one is not reused.
    const next = await store.connectStatus(subject, [requester]);
    expect(stateOf(next.approvalUrl!), label).not.toBe(firstState);
    const link = await store.approvalLink(stateOf(next.approvalUrl!));
    expect(link, label).not.toBe(firstLink);
    const current = (await openkey.requestFor(link)).request;
    expect(current.purpose, label).toBe("standing");
    expect(current.renewal, label).toEqual({ version: 1, leaseLifetimeSeconds: 90 * DAY });
    await rm(join(pendingDir, (await readdir(pendingDir)).find((file) => file !== name && file.endsWith(".json"))!), { force: true });
  }
});

test("retiring an idle tenant removes its key, grants and approvals but keeps the owner's tc-apps.json byte for byte", async () => {
  const requester = await ownerDid(REQUESTER_KEY);
  const subject = "openkey-user-idle";
  // A loopback node that records the retirement, the way the node's POST /session/retire answers.
  const retirements: string[] = [];
  const node = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/info") return Response.json({ nodeId: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" });
      if (path === "/session/retire" && request.method === "POST") {
        retirements.push(request.headers.get("authorization") ?? "");
        return Response.json({ recorded: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => node.stop(true));
  const { store, stateDir } = await storeWith({ delegationExpiry: "1h", nodeHost: node.url.origin });
  const first = await store.connectStatus(subject, [requester]);
  const root = store.tenantStateRoot(subject);
  const profile = join(root, ".tinycloud/profiles/agent");
  // The owner's timezone preference sits in the same profile directory as the delegate's custody.
  const preference = `{\n  "timezone": "America/Los_Angeles",\n  "note": "kept exactly"\n}\n`;
  await writeFile(join(profile, "tc-apps.json"), preference);
  await writeFile(join(root, ".tinycloud/native-grant.json"), "{}");
  await writeFile(join(profile, "registry-cache.json"), "{}");
  await mkdir(join(profile, "extra"), { recursive: true });
  await writeFile(join(profile, "extra/cache.json"), "{}");
  await writeFile(join(root, ".tinycloud/last-call"), "");
  const custody = ["key.json", "profile.json", "registry-cache.json", "extra"].map((name) => join(profile, name));
  for (const path of [...custody, join(root, ".tinycloud/native-grant.json")]) expect(await exists(path)).toBe(true);
  expect(await readdir(join(profile, "pending"))).not.toHaveLength(0);
  await store.close();

  const old = new Date(Date.now() - TENANT_IDLE_MS - 60_000);
  await utimes(join(profile, "key.json"), old, old);
  await rm(join(root, ".tinycloud/last-call"));

  const { store: restarted } = await storeWith({ delegationExpiry: "1h", nodeHost: node.url.origin }, stateDir);
  expect(await restarted.sweepIdleTenants()).toBe(1);
  expect(retirements).toHaveLength(1);

  // Custody and key material are gone; the owner's preference is untouched.
  for (const path of [...custody, join(profile, "pending"), join(root, ".tinycloud/native-grant.json"), join(root, ".tinycloud/retiring")]) {
    expect(await exists(path), path).toBe(false);
  }
  expect(await readFile(join(profile, "tc-apps.json"), "utf8")).toBe(preference);
  expect((await readdir(profile)).sort()).toEqual(["tc-apps.json"]);

  // The next call starts a new delegate beside the same preference.
  const second = await restarted.connectStatus(subject, [requester]);
  expect(second).toMatchObject({ connected: false, approvalUrl: expect.any(String) });
  expect(second.sessionDid).not.toBe(first.sessionDid);
  expect(await readFile(join(profile, "tc-apps.json"), "utf8")).toBe(preference);
});

async function storeWith(
  lifetimes: { delegationExpiry: string; bootstrapDelegationExpiry?: string; nodeHost?: string },
  existingStateDir?: string,
): Promise<{ store: RemoteTenantStore; openkey: FakeOpenKey; stateDir: string }> {
  const stateDir = existingStateDir ?? await mkdtemp(join(tmpdir(), "tinycloud-hosted-mcp-"));
  const openkey = existingStateDir === undefined ? installFakeOpenKey() : currentOpenKey!;
  currentOpenKey = openkey;
  const store = new RemoteTenantStore({
    stateDir,
    stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"),
    nodeHost: "https://node.tinycloud.test",
    openkeyHost: OPENKEY_ORIGIN,
    openkeyApiHost: OPENKEY_API_ORIGIN,
    linksApiOrigin: LINKS_API_ORIGIN,
    approvalTtlSeconds: 300,
    ...lifetimes,
  });
  cleanups.push(() => store.close());
  if (existingStateDir === undefined) {
    cleanups.push(() => openkey.restore(), () => rm(stateDir, { recursive: true, force: true }));
  }
  return { store, openkey, stateDir };
}

let currentOpenKey: FakeOpenKey | undefined;

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function stateOf(approvalUrl: string): string {
  return new URL(approvalUrl).searchParams.get("state")!;
}
