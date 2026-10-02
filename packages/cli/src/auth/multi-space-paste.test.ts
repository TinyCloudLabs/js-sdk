import { afterAll, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { createHermeticEncryptedNode } from "../../../node-sdk/src/test-support/hermetic-encrypted-node.js";
import { hashApplicationManifests } from "../../../sdk-core/src/account/applicationRecords.js";
import { appReadSelection, canonicalPermissions, registryReadPermissions } from "./app-read-policy.js";

const home = await mkdtemp(join(tmpdir(), "tc-multi-paste-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { verifyScopedLogin } = await import("./scoped-login.js");
const { loadAdditionalDelegations } = await import("../lib/permissions.js");
const discoveryManifests = [{ app_id: "agent-demo", name: "Agent Demo", defaults: false, includePublicSpace: false,
  permissions: [{ service: "tinycloud.kv", space: "applications", path: "agents/demo/", skipPrefix: true, actions: ["get", "list", "put"] }] }];
const discoveryApplication = { appId: "agent-demo", manifests: discoveryManifests, manifestHash: hashApplicationManifests(discoveryManifests) };
const boundary = await createHermeticEncryptedNode({ accountKvEntries: { "applications/agent-demo": discoveryApplication } });
let discoveryAvailable = true;
let discoveryPreflights = 0;
const discoveryWeb = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request =>
  new URL(request.url).pathname === "/.well-known/tinycloud-app-read.json"
    ? (++discoveryPreflights, discoveryAvailable
      ? Response.json({ schemaVersion: 1, protocolVersion: 1, implementationVersion: "1", apiBacked: true, discovery: "app-read", scope: "registry-and-selected-app", transport: "paste" })
      : new Response("unsupported API", { status: 503 }))
    : new Response("not found", { status: 404 }) });
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner(boundary.ownerPrivateKey);
const address = await signer.getAddress();
const owner = boundary.ownerDid;
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const account = wasm.makeSpaceId(address, 1, "account");
const app = wasm.makeSpaceId(address, 1, "applications");
const requested: PermissionEntry[] = [
  { service: "tinycloud.kv", space: "account", path: "applications/agent-demo", actions: ["tinycloud.kv/get"] },
  { service: "tinycloud.kv", space: app, path: "agents/demo/profile", actions: ["tinycloud.kv/get"] },
];
const profileDir = join(home, ".tinycloud", "profiles", "multi");
const permissionsPath = join(home, "permissions.json");
const manifestPath = join(home, "manifest.json");
const cli = fileURLToPath(new URL("../index.ts", import.meta.url));
const resolveSpace = (space: string) => space.startsWith("tinycloud:") ? space : wasm.makeSpaceId(address, 1, space);

async function proof(entries = requested, options: { expired?: boolean; wrongKey?: boolean } = {}) {
  const spaceAbilities: Record<string, Record<string, Record<string, string[]>>> = {};
  for (const entry of entries) {
    const abilities = spaceAbilities[resolveSpace(entry.space!)] ??= {};
    const paths = abilities[entry.service.replace(/^tinycloud\./, "")] ??= {};
    paths[entry.path] = [...entry.actions];
  }
  const jwk = options.wrongKey ? JSON.parse(wasm.createSessionManager().jwk("default")!) : key;
  const prepared = wasm.prepareSession({ abilities: {}, spaceAbilities, address, chainId: 1,
    domain: "synthetic.invalid", spaceId: resolveSpace(entries[0]!.space!), jwk,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expirationTime: new Date(Date.now() + (options.expired ? -30_000 : 3600_000)).toISOString() });
  const signature = await signer.signMessage(prepared.siwe);
  return { ...wasm.completeSessionSetup({ ...prepared, signature }), address, chainId: 1,
    siwe: prepared.siwe, signature, verificationMethod: did, hostActivated: true };
}

function command(args: string[], input?: object, captureUrl = false): Promise<{ exit: number | null; result: any; urls: number; url?: string }> {
  return new Promise((resolve, reject) => {
    const installed = process.env.TINYCLOUD_TEST_CLI;
    const child = spawn(installed ?? process.execPath, [...(installed ? [] : [cli]), "--quiet", "--json", "--profile", "multi", ...args], {
      env: { ...process.env, TC_HOME: home, TC_OPENKEY_HOST: discoveryWeb.url.origin }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", url: string | undefined;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Synthetic CLI timed out")); }, 15_000);
    child.on("error", reject);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => {
      stderr += chunk;
      if (captureUrl && !url) {
        url = stderr.match(/Open this URL in a browser to authenticate:\s*\n\s*(https?:\/\/[^\s]+)/)?.[1];
        if (url) child.kill();
      }
    });
    child.on("close", exit => {
      clearTimeout(timer);
      let result: any;
      for (const output of [stdout, stderr]) {
        const start = output.search(/\{\s*"(?:error|authenticated|requested)"\s*:/);
        if (start >= 0) try { result = JSON.parse(output.slice(start)); } catch { /* Withhold transport text. */ }
      }
      resolve({ exit, result: result ?? { error: { code: "NO_JSON_RECEIPT" } }, urls: (stderr.match(/Open this URL in a browser to authenticate:/g) ?? []).length, ...(url ? { url } : {}) });
    });
    if (input) child.stdin.end(JSON.stringify(input) + "\n");
    child.stdin.on("error", () => {});
  });
}
const loginArgs = (manifest = false) => ["auth", "login", "--method", "openkey", "--paste", manifest ? "--manifest" : "--permissions", manifest ? manifestPath : permissionsPath];

beforeEach(async () => {
  discoveryAvailable = true; discoveryPreflights = 0;
  await rm(profileDir, { recursive: true, force: true });
  await ProfileManager.setKey("multi", key);
  await ProfileManager.setProfile("multi", { name: "multi", host: boundary.host, did, sessionDid: did,
    chainId: 1, spaceName: "account", createdAt: new Date().toISOString() });
  await writeFile(permissionsPath, JSON.stringify(requested), { mode: 0o600 });
  await writeFile(manifestPath, JSON.stringify({ app_id: "multi-reader", space: "applications", permissions: requested.map(entry => ({ ...entry, skipPrefix: true })) }), { mode: 0o600 });
});
afterAll(async () => { discoveryWeb.stop(true); boundary.stop(); await rm(home, { recursive: true, force: true }); });

test.each([false, true])("one paste approval carries account and app permissions (manifest=%s)", async manifest => {
  const generated = await command(loginArgs(manifest), undefined, true);
  expect(Boolean(generated.url)).toBe(true);
  expect(generated.urls).toBe(1);
  const url = new URL(generated.url!);
  expect(url.searchParams.has("callback")).toBe(false);
  const request = JSON.parse(Buffer.from(url.searchParams.get("permissions")!, "base64url").toString());
  expect(request.permissions).toEqual(requested);
  expect(await ProfileManager.getSession("multi")).toBeNull();
  const response = await proof();
  // Simulate only the node activation normally performed by OpenKey. The local
  // host checks the real signed proof; no account data is fabricated by login.
  const activation = await fetch(`${boundary.host}/delegate`, { method: "POST", headers: response.delegationHeader });
  expect(activation.ok).toBe(true);
  const imported = await command(loginArgs(manifest), response);
  expect(imported.result).toMatchObject({ authenticated: true, scoped: true });
  expect(imported.exit).toBe(0);
  expect(imported.urls).toBe(1);
  const saved = await ProfileManager.getSession("multi") as any;
  expect(saved.permissions).toHaveLength(2);
  expect(await loadAdditionalDelegations("multi")).toHaveLength(0);

  // A separate CLI process restores the one proof and checks both scopes.
  const caps = await command(["auth", "caps", "--manifest", manifestPath]);
  expect(caps.result).toMatchObject({ covered: true });
  for (const [space, path] of [[account, "applications/agent-demo"], [app, "agents/demo/profile"]]) {
    const read = await command(["kv", "get", path!, "--space", space!]);
    expect(read.exit).toBe(0);
  }
});

test("additional multi-space proof retains primary files and replays both spaces", async () => {
  await writeFile(permissionsPath, JSON.stringify([requested[0]]));
  expect((await command(loginArgs(), await proof([requested[0]!]))).exit).toBe(0);
  const before = await Promise.all(["session.json", "profile.json", "key.json"].map(name => readFile(join(profileDir, name), "utf8")));
  await writeFile(permissionsPath, JSON.stringify(requested));
  const imported = await command([...loginArgs(), "--additional"], await proof());
  expect(imported.result).toMatchObject({ authenticated: true, additional: true });
  expect(await Promise.all(["session.json", "profile.json", "key.json"].map(name => readFile(join(profileDir, name), "utf8")))).toEqual(before);
  const grants = await loadAdditionalDelegations("multi");
  expect(grants).toHaveLength(1);
  expect(new Set(grants[0]!.delegation.resources!.map(entry => entry.space)).size).toBe(2);
  expect((await command(["auth", "caps", "--manifest", manifestPath])).result).toMatchObject({ covered: true });
});

test.each([
  ["missing", "OPENKEY_SCOPE_INCOMPLETE"], ["broadened", "OPENKEY_GRANT_BROADENED"],
  ["wrong-space", "OPENKEY_GRANT_BROADENED"], ["wrong-key", "OPENKEY_PROOF_INVALID"], ["expired", "AUTH_EXPIRED"],
] as const)("one proof rejects %s authority before installation", async (kind, code) => {
  const entries = kind === "missing" ? [requested[0]!] : kind === "broadened"
    ? [...requested, { ...requested[1]!, path: "agents/sibling/private" }]
    : kind === "wrong-space" ? [requested[0]!, { ...requested[1]!, space: "other" }] : requested;
  const result = await command(loginArgs(), await proof(entries, { wrongKey: kind === "wrong-key", expired: kind === "expired" }));
  expect(result.result).toMatchObject({ error: { code } });
  expect(await ProfileManager.getSession("multi")).toBeNull();
});

test("exported verifier rejects requested foreign-owner resources even when the proof is signed", async () => {
  const foreign = [...requested, { ...requested[1]!, space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:foreign" }];
  await expect(verifyScopedLogin(await proof(foreign), key, did, foreign, owner, true)).rejects.toMatchObject({ code: "OPENKEY_SCOPE_MISMATCH" });
});

test("app-read discovery sends the bound task without a fixed permission query", async () => {
  await writeFile(manifestPath, JSON.stringify({ app_id: "registry-reader", space: "account", defaults: false, includePublicSpace: false,
    permissions: registryReadPermissions(owner).map(entry => ({ ...entry, skipPrefix: true })) }));
  const result = await command([...loginArgs(true), "--discover-app-read", "--reason", "Find my last weigh-in"], undefined, true);
  expect(Boolean(result.url)).toBe(true);
  const url = new URL(result.url!);
  expect(url.searchParams.get("discovery")).toBe("app-read");
  expect(url.searchParams.get("reason")).toBe("Find my last weigh-in");
  expect(url.searchParams.has("permissions")).toBe(false);
  expect(url.searchParams.has("callback")).toBe(false);
  expect(await ProfileManager.getSession("multi")).toBeNull();
});

test("app-read discovery requires the bound registry manifest", async () => {
  const result = await command([...loginArgs(), "--discover-app-read"], await proof());
  expect(result.result).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  expect(result.urls).toBe(0);
});

test("one discovery proof reads the actual canonical registry before install, then restores both scopes in fresh CLI processes", async () => {
  const registry = registryReadPermissions(owner);
  const selected = appReadSelection(discoveryApplication, { ownerDid: owner, host: boundary.host, jwk: { kty: key.kty, crv: key.crv, x: key.x } });
  await writeFile(manifestPath, JSON.stringify({ app_id: "registry-reader", defaults: false, includePublicSpace: false,
    permissions: registry.map(entry => ({ ...entry, skipPrefix: true })) }));
  const args = [...loginArgs(true), "--discover-app-read", "--reason", "Read my registered app's profile"];
  const generated = await command(args, undefined, true);
  expect(generated.urls).toBe(1);
  expect(new URL(generated.url!).searchParams.get("discovery")).toBe("app-read");
  expect(await ProfileManager.getSession("multi")).toBeNull();
  const response = { ...await proof(selected.permissions), appReadSelection: selected };
  expect((await fetch(`${boundary.host}/delegate`, { method: "POST", headers: response.delegationHeader })).ok).toBe(true);
  const imported = await command(args, response);
  expect(imported.result).toMatchObject({ authenticated: true, appReadSelection: selected });
  expect(imported.exit).toBe(0);
  expect(canonicalPermissions(imported.result.permissions)).toEqual(selected.permissions);
  const saved = await ProfileManager.getSession("multi") as any;
  expect(canonicalPermissions(saved.permissions)).toEqual(selected.permissions);
  expect(await loadAdditionalDelegations("multi")).toHaveLength(0);
  const approved = join(home, "approved-discovery.json");
  await writeFile(approved, JSON.stringify({ app_id: selected.appId, defaults: false, includePublicSpace: false,
    permissions: selected.permissions.map(entry => ({ ...entry, skipPrefix: true })) }));
  expect((await command(["auth", "caps", "--manifest", approved])).result).toMatchObject({ covered: true });
  for (const [space, path] of [[account, "applications/agent-demo"], [app, "agents/demo/profile"]]) {
    expect((await command(["kv", "get", path!, "--space", space!])).exit).toBe(0);
  }
  boundary.assertDelegatedKvResources([`tinycloud.kv/get:${account}/kv/applications/agent-demo`, `tinycloud.kv/get:${app}/kv/agents/demo/profile`].map(value => value.toLowerCase()));
});

test.each([false, true])("fixed local selection rereads canonical app before additive installation (changed=%s)", async changed => {
  const basePermission = { ...requested[1]!, path: "agents/sibling/private" };
  await writeFile(permissionsPath, JSON.stringify([basePermission]));
  expect((await command(loginArgs(), await proof([basePermission]))).exit).toBe(0);
  const before = await Promise.all(["session.json", "profile.json", "key.json"].map(name => readFile(join(profileDir, name), "utf8")));
  const selected = appReadSelection(discoveryApplication, { ownerDid: owner, host: boundary.host, jwk: { kty: key.kty, crv: key.crv, x: key.x } });
  const pendingApplication = changed ? { ...discoveryApplication, manifestHash: "0".repeat(16) } : discoveryApplication;
  const pending = appReadSelection(pendingApplication, { ownerDid: owner, host: boundary.host, jwk: { kty: key.kty, crv: key.crv, x: key.x } });
  const selectionPath = join(home, "selected-app.json");
  await writeFile(selectionPath, JSON.stringify(pending), { mode: 0o600 });
  await writeFile(manifestPath, JSON.stringify({ app_id: selected.appId, name: "Agent Demo", defaults: false, includePublicSpace: false,
    permissions: selected.permissions.map(entry => ({ ...entry, skipPrefix: true })) }), { mode: 0o600 });
  discoveryAvailable = false;
  const response = await proof(selected.permissions);
  expect((await fetch(`${boundary.host}/delegate`, { method: "POST", headers: response.delegationHeader })).ok).toBe(true);
  const result = await command([...loginArgs(true), "--additional", "--app-read-selection", selectionPath], response);
  expect(result.result).toMatchObject(changed ? { error: { code: "OPENKEY_DISCOVERY_MISMATCH" } } : { authenticated: true, additional: true, appReadSelection: selected });
  expect(await Promise.all(["session.json", "profile.json", "key.json"].map(name => readFile(join(profileDir, name), "utf8")))).toEqual(before);
  expect(await loadAdditionalDelegations("multi")).toHaveLength(changed ? 0 : 1);
  expect(discoveryPreflights).toBe(0);
});

test.skipIf(!process.env.TINYCLOUD_TEST_HANDOFF || !process.env.TINYCLOUD_TEST_CLI)("installed helper imports one discovered app proof and checks its derived manifest through the installed CLI", async () => {
  const { createHandoff } = await import(process.env.TINYCLOUD_TEST_HANDOFF!);
  const selected = appReadSelection(discoveryApplication, { ownerDid: owner, host: boundary.host, jwk: { kty: key.kty, crv: key.crv, x: key.x } });
  await writeFile(manifestPath, JSON.stringify({ app_id: "registry-reader", name: "Registry Reader", defaults: false, includePublicSpace: false,
    permissions: registryReadPermissions(owner).map(entry => ({ ...entry, skipPrefix: true })) }));
  const original = await readFile(manifestPath, "utf8");
  const statePath = join(home, "handoff-private", "pending.json");
  let approvals = 0;
  const options = { statePath, env: { ...process.env, TC_OPENKEY_HOST: discoveryWeb.url.origin },
    openApproval: async () => { approvals++; return { mode: "file", status: "file-created" }; } };
  const handoff = createHandoff(options);
  const context = { conversationId: "synthetic-helper-session" };
  const prepared = await handoff.prepare({ cli: process.env.TINYCLOUD_TEST_CLI, tcHome: home, profile: "multi", host: boundary.host,
    manifestPath, discovery: "app-read", task: "Read my registered app's profile", ...context });
  expect(prepared.status).toBe("login-required");
  expect((await handoff.authorize(context)).status).toBe("awaiting-approval");
  const response = { ...await proof(selected.permissions), appReadSelection: selected };
  expect((await fetch(`${boundary.host}/delegate`, { method: "POST", headers: response.delegationHeader })).ok).toBe(true);
  const ready = await handoff.importResponse(JSON.stringify(response), context);
  expect(ready.status).toBe("ready");
  expect(ready.appReadSelection).toEqual(selected);
  const approved = JSON.parse(await readFile(`${statePath}.approved.json`, "utf8"));
  expect(approved.name).toBe(selected.appId);
  expect(approved.permissions.every((entry: any) => entry.skipPrefix === true)).toBe(true);
  expect(canonicalPermissions(approved.permissions.map(({ skipPrefix, ...entry }: any) => entry))).toEqual(selected.permissions);
  expect((await createHandoff(options).status(context)).status).toBe("ready");
  expect((await createHandoff(options).authorize(context)).status).toBe("ready");
  expect(approvals).toBe(1);
  expect(await readFile(manifestPath, "utf8")).toBe(original);
  for (const [space, path] of [[account, "applications/agent-demo"], [app, "agents/demo/profile"]]) {
    expect((await command(["kv", "get", path!, "--space", space!])).exit).toBe(0);
  }
}, 20000);


test.skipIf(!process.env.TINYCLOUD_TEST_SETUP || !process.env.TINYCLOUD_TEST_CLI).each(["cold", "no-registry", "registry-only"])("real installed setup handles %s authority and fresh warm conversation", async mode => {
  const partial = mode !== "cold";
  // The existing crypto boundary recognizes proof CIDs but does not validate
  // ancestor resource scope. This local host gate models its HTTP 401 response
  // until the additional registry proof is approved; CLI and setup stay real.
  let registryDenied = mode === "no-registry";
  const hostProxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const url = new URL(request.url);
    if (registryDenied && url.pathname === "/invoke") return new Response("Unauthorized Action: registry / tinycloud.kv/list", { status: 401 });
    return fetch(new Request(new URL(url.pathname + url.search, boundary.host), request));
  } });
  const setupHost = hostProxy.url.origin;
  const existing = await ProfileManager.getProfile("multi");
  await ProfileManager.setProfile("multi", { ...existing, host: setupHost });
  try {
    const { createSetup } = await import(process.env.TINYCLOUD_TEST_SETUP!);
    const { runTc } = await import(new URL("./handoff.mjs", `file://${process.env.TINYCLOUD_TEST_SETUP!}`));
    const executable = process.env.TINYCLOUD_TEST_CLI!;
    const nodePath = process.env.TINYCLOUD_TEST_NODE;
    const env = { ...process.env, TC_HOME: home, TC_OPENKEY_HOST: discoveryWeb.url.origin };
    const stateRoot = await mkdtemp(join(home, "real-setup-"));
    const originalRequest = "Read my registered agent app profile and report its name and role";
    const release = { version: "0.2.0-lean-auth.1", cliVersion: "0.10.1-lean-auth.1", cliPath: executable,
      ...(nodePath ? { nodePath } : {}), manifestSha256: "a".repeat(64),
      registryTemplatePath: fileURLToPath(new URL("../templates/registry-read.json", `file://${process.env.TINYCLOUD_TEST_SETUP!}`)) };
    const cliRead = async (args: string[]) => JSON.parse(await runTc(["--profile", "multi", "--host", setupHost, "--json", ...args], { executable, nodePath, env }));
    let approvals = 0, approvalUrl: string | undefined;
    const options = { stateRoot, env, verifyRelease: async () => release,
      runTc: async (args: string[], execution: object) => {
        try { return await runTc(args, execution); }
        catch (error) { Object.assign(error as object, { testCommand: args.filter(arg => ["account", "apps", "list", "read-scope", "auth", "caps", "context", "profile"].includes(arg)).join(" ") }); throw error; }
      },
      openApproval: async (url: string) => { approvals++; approvalUrl = url; return { mode: "file", status: "file-created" }; } };
    const primaryFiles = () => Promise.all(["profile.json", "session.json", "key.json"].map(name => readFile(join(profileDir, name), "utf8")));
    let before: string[] | undefined;
    let unrelatedCid: string | undefined;
    if (partial) {
      const primaryPermissions = mode === "registry-only" ? registryReadPermissions(owner) : [requested[1]!];
      const primary = await proof(primaryPermissions);
      expect((await fetch(`${setupHost}/delegate`, { method: "POST", headers: primary.delegationHeader })).ok).toBe(true);
      await writeFile(permissionsPath, JSON.stringify(primaryPermissions));
      expect((await command(loginArgs(), primary)).exit).toBe(0);
      const unrelated = { ...requested[1]!, path: "agents/sibling/private" };
      const extra = await proof([unrelated]);
      expect((await fetch(`${setupHost}/delegate`, { method: "POST", headers: extra.delegationHeader })).ok).toBe(true);
      await writeFile(permissionsPath, JSON.stringify([unrelated]));
      expect((await command([...loginArgs(), "--additional"], extra)).exit).toBe(0);
      unrelatedCid = extra.delegationCid;
      before = await primaryFiles();
      // This is a real HTTP authorization failure, not a mocked setup error.
      if (mode === "no-registry") await expect(cliRead(["account", "apps", "list", "--live"])).rejects.toMatchObject({ code: "AUTH_UNAUTHORIZED" });
      else expect((await cliRead(["account", "apps", "list", "--live"])).applications).toHaveLength(1);
    }
    const cold = createSetup(options).forSession(`real-setup-cold-${mode}`);
    const pending = await cold.setup({ originalRequest, profile: "multi", tcHome: home, host: setupHost });
    expect(pending.status).toBe("awaiting-approval");
    expect(approvals).toBe(1);
    expect(pending.task).toBe(originalRequest);
    const url = new URL(approvalUrl!);
    expect(url.searchParams.get("did")).toBe(did);
    expect(url.searchParams.get("host")).toBe(setupHost);
    expect(url.searchParams.get("discoveryProtocolVersion")).toBe(mode === "registry-only" ? null : "1");
    const selected = appReadSelection(discoveryApplication, { ownerDid: owner, host: setupHost,
      jwk: JSON.parse(Buffer.from(url.searchParams.get("jwk")!, "base64url").toString()) });
    const response = { ...await proof(selected.permissions), ...(mode === "registry-only" ? {} : { appReadSelection: selected }) };
    expect((await fetch(`${setupHost}/delegate`, { method: "POST", headers: response.delegationHeader })).ok).toBe(true);
    registryDenied = false;
    const ready = await cold.importResponse(JSON.stringify(response), { messageId: `synthetic-${mode}` });
    expect(ready.status).toBe("ready");
    expect(ready.task).toBe(originalRequest);
    expect(ready.application.appId).toBe("agent-demo");
    expect(ready.resources).toEqual(selected.permissions);
    expect(ready.cliContext).toMatchObject({ executable, env: { TC_HOME: home } });
    if (partial) {
      expect(await primaryFiles()).toEqual(before);
      const extra = await loadAdditionalDelegations("multi");
      expect(extra).toHaveLength(2);
      expect(extra.some(entry => entry.delegation.cid === unrelatedCid)).toBe(true);
    }
    const record = await cliRead(["kv", "get", "agents/demo/profile", "--space", app]);
    expect(JSON.stringify(record)).toContain('"Ada"');
    const preflightsBeforeWarm = discoveryPreflights;
    discoveryAvailable = false;
    // A fresh helper session has no approved-scope receipt for this conversation.
    const warm = await createSetup(options).forSession(`real-setup-warm-${mode}`).setup({ originalRequest, contextHandle: ready.contextHandle });
    expect(warm.status).toBe("ready");
    expect(warm.application.appId).toBe("agent-demo");
    expect(warm.resources).toEqual(selected.permissions);
    expect(approvals).toBe(1);
    expect(discoveryPreflights).toBe(preflightsBeforeWarm);
    const warmRecord = await cliRead(["kv", "get", "agents/demo/profile", "--space", app]);
    expect(JSON.stringify(warmRecord)).toContain('"operator"');
    if (partial) expect(await primaryFiles()).toEqual(before);
  } finally { hostProxy.stop(true); }
}, 60000);
