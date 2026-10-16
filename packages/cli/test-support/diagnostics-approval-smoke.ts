// Isolated protocol acceptance: real built CLI + WASM signatures + loopback node.
// SQL.md's SIWE paste login and request-bound auth import are distinct protocols.
// The node fixture counts authorized SQL dispatch/effects; it is not a SQL engine.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { grantAuthRequest, NodeWasmBindings, PrivateKeySigner, type AuthRequestArtifact, type PermissionEntry } from "@tinycloud/node-sdk";
import { DiagnosticStore, reviewDiagnosticSnapshot } from "@tinycloud/operations/diagnostics";
import { readAdditionalDelegations, readAuthRequests, readSession } from "@tinycloud/operations/state";
import { createHermeticEncryptedNode } from "../../node-sdk/src/test-support/hermetic-encrypted-node.js";
import { openKeyDelegate } from "../src/test-support/openkey-delegate.js";

const home = await mkdtemp(join(tmpdir(), "tc-diagnostic-approval-"));
const cli = resolve(import.meta.dir, "../bin/tc");
const executable = process.env.NODE_BINARY ?? "node";
const database = "xyz.tinycloud.agent-data.index";
const sql = "INSERT INTO private_approval_canary VALUES (7)";
const query = "SELECT 7 AS private_approval_canary";
// State helpers and every child see only this newly-created profile root.
process.env.TC_HOME = join(home, "profiles");
const node = await createHermeticEncryptedNode({ nativeBearerPath: "synthetic-approval", nativeSqlDatabase: database });
const origin = new URL(node.host);
assert.equal(origin.hostname, "127.0.0.1");
const guard = join(home, "loopback-only.cjs");
const blockedLog = join(home, "blocked-network");
await writeFile(guard, `
const fs = require('node:fs'), net = require('node:net'), dns = require('node:dns');
const origin = ${JSON.stringify(node.host)}, port = ${JSON.stringify(origin.port)};
function deny() { fs.appendFileSync(${JSON.stringify(blockedLog)}, 'blocked\\n'); throw new Error('external_network_blocked'); }
const originalFetch = globalThis.fetch;
globalThis.fetch = function(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== origin) return deny();
  return originalFetch(input, init);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = normalized[0];
  const host = typeof options === 'object' ? options.host : normalized[1];
  const targetPort = typeof options === 'object' ? options.port : options;
  if (host !== '127.0.0.1' || String(targetPort) !== port) return deny();
  return connect.apply(this, args);
};
dns.lookup = deny;
require('node:module').syncBuiltinESMExports();
`, { mode: 0o600 });
const baseEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, TC_HOME: process.env.TC_HOME,
  XDG_STATE_HOME: join(home, "state"), NO_COLOR: "1",
  NODE_OPTIONS: `--require=${guard}`, TC_OPENKEY_HOST: node.host, TC_OPENKEY_API_HOST: node.host,
};
// The fixture's SDK also has no route to an external fetch origin.
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  assert.equal(url.origin, node.host, "fixture attempted a non-loopback fetch");
  return originalFetch(input, init);
}) as typeof fetch;

interface CommandResult { code: number | null; stdout: string; stderr: string }
async function run(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<CommandResult> {
  const child = spawn(executable, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on("data", (data: Buffer) => stdout.push(data));
  child.stderr.on("data", (data: Buffer) => stderr.push(data));
  child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") throw error; });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.notEqual(child.signalCode, "SIGKILL", "built CLI exceeded fixture deadline");
    return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  } finally { clearTimeout(timer); }
}
function objectOutput(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text.slice(text.indexOf("{")));
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
interface SavedGrant {
  delegation: { cid: string; delegationHeader: { Authorization: string } };
  authorityRequest: { requestId: string; requested: PermissionEntry[] };
}
const summaries: Record<string, unknown>[] = [];
const dispatches: { capture: string; httpRequests: number; activationRequests: number; sqlRequests: number; sqlEffects: number }[] = [];
try {
  for (const capture of ["disabled", "enabled", "failed"] as const) {
    const profile = `approval-${capture}`;
    const root = join(home, `diagnostics-${capture}`);
    const run_id = randomUUID(), workflow_id = randomUUID();
    const env = { ...baseEnv, TC_DIAGNOSTICS_HOME: root };
    assert.equal((await run(["init", "--name", profile, "--key-only"], env)).code, 0);
    if (capture === "enabled") {
      const enabled = await run(["diagnostics", "enable", "--scope", "tc-apps"], env);
      assert.equal(enabled.code, 0, enabled.stderr);
    } else if (capture === "failed") {
      await writeFile(root, "synthetic failed diagnostic sink", { mode: 0o600 });
    }
    const scopedEnv = { ...env, TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, scope: "tc-apps", run_id, workflow_id }) };
    const args = ["--json", "--quiet", "--profile", profile, "--host", node.host];
    const execute = [...args, "sql", "execute", "--db", database, "--space", node.applicationsSpaceId, "--", sql];
    const before = node.nativeBearerStats();
    const requestsBefore = node.requests().length;
    const unauthenticated = await run(execute, scopedEnv);
    assert.notEqual(unauthenticated.code, 0);
    assert.equal(node.nativeBearerStats().sqlRequests, before.sqlRequests);
    assert.equal(await readSession(profile), null);

    // Use the real request printed by EOF, not an independently invented DID/scope.
    const manifest = join(home, `${profile}.json`);
    await writeFile(manifest, JSON.stringify({ manifest_version: 1, app_id: "xyz.tinycloud.agent-data", name: "Synthetic SQL approval", space: "applications", defaults: false,
      permissions: [{ service: "tinycloud.sql", path: database, skipPrefix: true, actions: ["read", "write"] }] }), { mode: 0o600 });
    const login = [...args, "auth", "login", "--paste", "--manifest", manifest, "--expiry", "1h"];
    const handoff = await run(login, scopedEnv);
    assert.equal(handoff.code, 3);
    const handoffError = objectOutput(handoff.stderr).error;
    assert(handoffError !== null && typeof handoffError === "object");
    assert.equal((handoffError as Record<string, unknown>).code, "PASTE_CODE_MISSING");
    const match = handoff.stderr.match(/http:\/\/127\.0\.0\.1:\d+\/delegate\?[^\s]+/);
    assert(match, "paste EOF did not expose a loopback approval URL");
    const approvalUrl = new URL(match[0]);
    const did = approvalUrl.searchParams.get("did");
    const encodedKey = approvalUrl.searchParams.get("jwk");
    const encodedPermissions = approvalUrl.searchParams.get("permissions");
    assert(did && encodedKey && encodedPermissions);
    assert.equal(approvalUrl.searchParams.get("host"), node.host);
    const publicKey = objectOutput(Buffer.from(encodedKey, "base64url").toString());
    assert.equal(publicKey.d, undefined);
    const requested = objectOutput(Buffer.from(encodedPermissions, "base64url").toString()).permissions as PermissionEntry[];
    assert(requested.some((permission) => permission.service === "tinycloud.sql" && permission.path === database));
    assert.equal(await readSession(profile), null);
    const builder = openKeyDelegate({ wasm: new NodeWasmBindings(), signer: new PrivateKeySigner(node.ownerPrivateKey), sessionKey: publicKey, sessionDid: did });
    const approval = await builder.delegate(did, { permissions: requested });
    assert.deepEqual(builder.refusals, []);
    const code = Buffer.from(JSON.stringify(approval)).toString("base64");
    const resumed = await run(login, scopedEnv, `${code}\n`);
    assert.equal(resumed.code, 0, resumed.stderr);
    const signedIn = objectOutput(resumed.stdout);
    assert.equal(signedIn.authenticated, true);
    assert.deepEqual(signedIn.declined, []);
    const savedSession = await readSession<{ delegationCid: string; verificationMethod: string }>(profile);
    assert.equal(savedSession?.delegationCid, approval.delegationCid);
    assert.equal(savedSession?.verificationMethod.split("#", 1)[0], did.split("#", 1)[0]);
    assert.equal(node.nativeBearerStats().sqlRequests, before.sqlRequests);
    assert.equal(node.nativeBearerStats().sqlEffects, before.sqlEffects);

    // Separate persisted-request protocol: the CLI writes the pending request,
    // the actual SDK owner signs it, and fresh CLI invocations verify/import it.
    const permission = join(home, `${profile}-request.json`);
    await writeFile(permission, JSON.stringify({ permissions: [{ service: "tinycloud.sql", space: node.applicationsSpaceId, path: database, actions: ["tinycloud.sql/read", "tinycloud.sql/write"] }] }), { mode: 0o600 });
    const requestResult = await run([...args, "auth", "request", "--permission", permission, "--expiry", "1h", "--emit"], scopedEnv);
    assert.equal(requestResult.code, 0, requestResult.stderr);
    const request = objectOutput(requestResult.stdout) as unknown as AuthRequestArtifact;
    assert.equal(request.sessionDid.split("#", 1)[0], did.split("#", 1)[0]);
    const pending = await readAuthRequests<AuthRequestArtifact>(profile);
    assert.deepEqual(pending.map((entry) => entry.requestId), [request.requestId]);
    const granted = await grantAuthRequest(node.owner, request);
    assert.equal(granted.delegation.delegateDID.split("#", 1)[0], did.split("#", 1)[0]);
    const artifact = JSON.stringify(granted);
    const importArgs = [...args, "auth", "import", "--paste"];
    const imported = await run(importArgs, scopedEnv, artifact);
    assert.equal(imported.code, 0, imported.stderr);
    assert.equal(objectOutput(imported.stdout).activated, true);
    const records = await readAdditionalDelegations<SavedGrant>(profile);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.delegation.cid, granted.delegationCid);
    assert.equal(records[0]!.authorityRequest.requestId, request.requestId);
    const duplicate = await run(importArgs, scopedEnv, artifact);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(objectOutput(duplicate.stdout).activated, true);
    assert.deepEqual(await readAdditionalDelegations<SavedGrant>(profile), records);
    assert.equal(node.nativeBearerStats().sqlRequests, before.sqlRequests);
    assert.equal(node.nativeBearerStats().sqlEffects, before.sqlEffects);

    const retry = await run(execute, scopedEnv);
    assert.equal(retry.code, 0, retry.stderr);
    assert.deepEqual(objectOutput(retry.stdout), { changes: 1, lastInsertRowId: 1 });
    assert.equal(node.nativeBearerStats().sqlRequests - before.sqlRequests, 1);
    assert.equal(node.nativeBearerStats().sqlEffects - before.sqlEffects, 1);
    const queried = await run([...args, "sql", "query", "--db", database, "--space", node.applicationsSpaceId, "--", query], scopedEnv);
    assert.equal(queried.code, 0, queried.stderr);
    assert.deepEqual(objectOutput(queried.stdout), { columns: ["synthetic"], rows: [[7]], rowCount: 1 });
    assert.equal(node.nativeBearerStats().sqlRequests - before.sqlRequests, 2);
    assert.equal(node.nativeBearerStats().sqlEffects - before.sqlEffects, 1);
    assert.deepEqual(await readAdditionalDelegations<SavedGrant>(profile), records);
    const after = node.nativeBearerStats();
    assert(after.delegationAttempts > before.delegationAttempts, "no real grant activation reached loopback");
    dispatches.push({ capture, httpRequests: node.requests().length - requestsBefore,
      activationRequests: after.delegationAttempts - before.delegationAttempts,
      sqlRequests: after.sqlRequests - before.sqlRequests, sqlEffects: after.sqlEffects - before.sqlEffects });

    if (capture === "enabled") {
      const snapshot = await new DiagnosticStore(root).snapshot({ all: true });
      const events = snapshot.events;
      assert(events.every((event) => event.run_id === run_id && event.workflow_id === workflow_id));
      const awaiting = events.find((event) => event.business === "awaiting_owner");
      const verified = events.find((event) => event.phase === "approval_verify" && event.type === "phase.finish" && event.outcome === "pass");
      assert(awaiting && verified);
      assert.notEqual(awaiting.invocation_id, verified.invocation_id);
      assert(events.some((event) => event.invocation_id === verified.invocation_id && event.phase === "approval_commit" && event.type === "phase.finish" && event.outcome === "complete"));
      const imports = events.filter((event) => event.phase === "approval_commit" && event.type === "phase.finish" && event.canonical_status === "ok");
      assert.equal(imports.length, 2);
      const attempts = events.filter((event) => event.type === "attempt.start" && event.service === "sql");
      assert.deepEqual(attempts.map((event) => event.action).sort(), ["execute", "query"]);
      assert.equal(new Set(attempts.map((event) => event.invocation_id)).size, 2);
      for (const attempt of attempts) {
        assert.notEqual(attempt.invocation_id, awaiting.invocation_id);
        assert.notEqual(attempt.invocation_id, verified.invocation_id);
        assert(!imports.some((event) => event.invocation_id === attempt.invocation_id));
        assert(events.some((event) => event.invocation_id === attempt.invocation_id && event.phase === "replay" && event.replay_installed === 1));
      }
      const reviewed = reviewDiagnosticSnapshot(snapshot);
      assert(reviewed.invocations.some((invocation) => invocation.business === "awaiting_owner"));
      assert(events.some((event) => event.action === "execute" && event.mutation === "confirmed"));
      const metadata = JSON.stringify(snapshot);
      for (const secret of [code, artifact, approvalUrl.href, approval.delegationHeader.Authorization, String(approval.siwe), String(approval.signature), granted.delegationCid, request.requestId, did, node.host, node.ownerPrivateKey, database, sql, query, profile]) {
        assert(!metadata.includes(secret), "approval material leaked into diagnostic metadata");
      }
      assert(!/https?:\/\//.test(metadata));
    } else if (capture === "disabled") {
      assert.deepEqual((await new DiagnosticStore(root).snapshot({ all: true })).events, []);
    }
    summaries.push({ unauthenticated: unauthenticated.code, handoff: handoff.code, resumed: resumed.code, imported: imported.code, duplicate: duplicate.code,
      write: objectOutput(retry.stdout), query: objectOutput(queried.stdout), sqlRequests: 2, sqlEffects: 1, savedGrants: records.length });
  }
  assert.deepEqual(summaries[1], summaries[0]);
  assert.deepEqual(summaries[2], summaries[0]);
  await assert.rejects(readFile(blockedLog), { code: "ENOENT" });
  process.stdout.write(`diagnostic-approval-parity-ok\n${JSON.stringify({ modes: 3, dispatches, grantsPerProfile: 1, linkage: "explicit-workflow", sqlEngine: false })}\n`);
} finally {
  globalThis.fetch = originalFetch;
  node.stop();
  await rm(home, { recursive: true, force: true });
}
