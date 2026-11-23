import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
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

test("retiring an idle tenant removes exactly its custody and leaves every other file, the owner's tc-apps.json included, untouched", async () => {
  const requester = await ownerDid(REQUESTER_KEY);
  const subject = "openkey-user-idle";
  const { origin, retirements } = loopbackNode();
  const { store, stateDir } = await storeWith({ delegationExpiry: "1h", nodeHost: origin });
  const first = await store.connectStatus(subject, [requester]);
  const root = store.tenantStateRoot(subject);
  const tinycloud = join(root, ".tinycloud");
  const profile = join(tinycloud, "profiles/agent");
  // The owner's timezone preference, a file this server has never heard of, and a directory of the owner's sit beside the custody.
  const preference = `{\n  "timezone": "America/Los_Angeles",\n  "note": "kept exactly"\n}\n`;
  const note = `{"written":"by something else","n":[1,2,3]}`;
  const nested = "owner's notes\n";
  await writeFile(join(profile, "tc-apps.json"), preference);
  await writeFile(join(profile, "owner-note.json"), note);
  await writeFile(join(tinycloud, "owner-note.json"), note);
  await mkdir(join(profile, "notes"), { recursive: true });
  await writeFile(join(profile, "notes/a.md"), nested);
  const owned = [
    [join(profile, "tc-apps.json"), preference],
    [join(profile, "owner-note.json"), note],
    [join(tinycloud, "owner-note.json"), note],
    [join(profile, "notes/a.md"), nested],
  ] as const;
  // Custody, every kind the server or the operations runtime keeps: each store and its metadata, caches, a stale
  // atomic-write temporary, the profile lock and its staged owner file, grants, the call marker, lease exposures.
  // Seeded only where the store has not written one itself, and with a shape the store reads. `session.json` is
  // not seeded: the store would read a made-up one as a grant. Its metadata and temporary stand in for it.
  const stores = ["additional-delegations", "auth-requests", "registry-cache", "registry-sequences"];
  for (const name of stores) {
    if (!await exists(join(profile, `${name}.json`))) await writeFile(join(profile, `${name}.json`), name === "additional-delegations" ? "[]" : "{}");
    await writeFile(join(profile, `${name}.json.metadata.json`), "{}");
  }
  await writeFile(join(profile, "session.json.metadata.json"), "{}");
  await writeFile(join(profile, "session.json.123.abcdef.tmp"), "{}");
  await writeFile(join(profile, "delegation-binding-migration.json"), "{}");
  await mkdir(join(profile, ".lock"), { recursive: true });
  await writeFile(join(profile, ".lock/owner.json"), "{}");
  await writeFile(join(profile, ".lock-owner-0123abcd.tmp"), "{}");
  await writeFile(join(tinycloud, "native-grant.json"), "{}");
  await writeFile(join(tinycloud, "lease-exposures.json"), JSON.stringify({ unknownSince: 0, pending: {} }));
  await writeFile(join(tinycloud, "last-call"), "");
  await writeFile(join(tinycloud, "retiring.123.abcdef.tmp"), "");
  await mkdir(join(tinycloud, "profile-locks/agent/0"), { recursive: true });
  await writeFile(join(tinycloud, "profile-locks/agent/0/owner.json"), "{}");
  const custody = [
    ...[...stores.flatMap((name) => [`${name}.json`, `${name}.json.metadata.json`]),
      "key.json", "profile.json", "session.json.metadata.json", "session.json.123.abcdef.tmp", "delegation-binding-migration.json", ".lock", ".lock-owner-0123abcd.tmp", "pending"]
      .map((name) => join(profile, name)),
    ...["native-grant.json", "lease-exposures.json", "last-call", "retiring.123.abcdef.tmp", "profile-locks"].map((name) => join(tinycloud, name)),
  ];
  for (const path of custody) expect(await exists(path), path).toBe(true);
  expect(await readdir(join(profile, "pending"))).not.toHaveLength(0);
  await store.close();

  // The call marker is the idle anchor here: it is six days and a minute old.
  const old = new Date(Date.now() - TENANT_IDLE_MS - 60_000);
  await utimes(join(tinycloud, "last-call"), old, old);
  await utimes(join(profile, "key.json"), old, old);

  const { store: restarted } = await storeWith({ delegationExpiry: "1h", nodeHost: origin }, stateDir);
  expect(await restarted.sweepIdleTenants()).toBe(1);
  expect(retirements).toHaveLength(1);

  // Custody and key material are gone, the fence with it; nothing else was touched, byte for byte.
  for (const path of [...custody, join(tinycloud, "retiring")]) expect(await exists(path), path).toBe(false);
  for (const [path, content] of owned) expect(await readFile(path, "utf8"), path).toBe(content);
  expect((await readdir(profile)).sort()).toEqual(["notes", "owner-note.json", "tc-apps.json"]);
  expect((await readdir(tinycloud)).sort()).toEqual(["owner-note.json", "profiles"]);

  // The next call starts a new delegate beside the same files.
  const second = await restarted.connectStatus(subject, [requester]);
  expect(second).toMatchObject({ connected: false, approvalUrl: expect.any(String) });
  expect(second.sessionDid).not.toBe(first.sessionDid);
  for (const [path, content] of owned) expect(await readFile(path, "utf8"), path).toBe(content);
});

// A removal that stops after the key went: the fence is the last thing removed, so a stop leaves it. The stop is real,
// not simulated: the removal cannot delete the fence because its directory is read-only.
test.skipIf(process.getuid?.() === 0)("a retirement interrupted after the key was removed is finished by the next sweep without asking the node again", async () => {
  const requester = await ownerDid(REQUESTER_KEY);
  const subject = "openkey-user-idle";
  const { origin, retirements } = loopbackNode();
  const { store, stateDir } = await storeWith({ delegationExpiry: "1h", nodeHost: origin });
  const first = await store.connectStatus(subject, [requester]);
  const root = store.tenantStateRoot(subject);
  const tinycloud = join(root, ".tinycloud");
  const profile = join(tinycloud, "profiles/agent");
  const preference = `{"timezone":"Europe/Paris"}\n`;
  await writeFile(join(profile, "tc-apps.json"), preference);
  await store.close();
  // Nothing in `.tinycloud` but the profiles and the fence, so the fence is the only thing the read-only directory blocks.
  for (const name of await readdir(tinycloud)) if (name !== "profiles") await rm(join(tinycloud, name), { recursive: true, force: true });
  await writeFile(join(tinycloud, "retiring"), "true\n");
  const old = new Date(Date.now() - TENANT_IDLE_MS - 60_000);
  await utimes(join(profile, "key.json"), old, old);

  const { store: restarted } = await storeWith({ delegationExpiry: "1h", nodeHost: origin }, stateDir);
  await chmod(tinycloud, 0o500);
  cleanups.push(() => chmod(tinycloud, 0o700).catch(() => undefined));
  expect(await restarted.sweepIdleTenants()).toBe(0);
  // The node confirmed, the key is gone, the fence is the one thing left: the state a crash at that point leaves.
  expect(retirements).toHaveLength(1);
  expect(await exists(join(profile, "key.json"))).toBe(false);
  expect(await exists(join(tinycloud, "retiring"))).toBe(true);

  // An approval left behind in `pending/` by the interrupted removal is custody too.
  await mkdir(join(profile, "pending"), { recursive: true });
  await writeFile(join(profile, "pending/orphan.json"), "{}");
  await chmod(tinycloud, 0o700);
  expect(await restarted.sweepIdleTenants()).toBe(1);
  expect(retirements).toHaveLength(1);
  expect(await exists(join(tinycloud, "retiring"))).toBe(false);
  expect(await exists(join(profile, "pending"))).toBe(false);
  expect(await readFile(join(profile, "tc-apps.json"), "utf8")).toBe(preference);

  const second = await restarted.connectStatus(subject, [requester]);
  expect(second).toMatchObject({ connected: false, approvalUrl: expect.any(String) });
  expect(second.sessionDid).not.toBe(first.sessionDid);
});

/** A loopback node that records retirements, the way the node's POST /session/retire answers. */
function loopbackNode(): { origin: string; retirements: string[] } {
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
  return { origin: node.url.origin, retirements };
}

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
