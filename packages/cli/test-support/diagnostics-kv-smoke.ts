// Run only in a disposable HOME/TC_HOME supplied by diagnostics.e2e.test.ts.
// This fixture has no ambient server/private-key input and uses loopback only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHermeticEncryptedNode } from "../../node-sdk/src/test-support/hermetic-encrypted-node.js";
import { profileConfigPath, sessionPath, writeJsonAtomic } from "@tinycloud/operations/state";
import { DiagnosticStore, type DiagnosticReview } from "@tinycloud/operations/diagnostics";

assert(process.env.HOME?.includes("tc-diagnostic-cli-"));
assert(process.env.TC_HOME?.startsWith(process.env.HOME));
assert(process.env.TC_DIAGNOSTICS_HOME?.startsWith(process.env.HOME));
const root = process.env.TC_DIAGNOSTICS_HOME;
const cli = resolve(import.meta.dir, "../bin/tc");
const key = "xyz.tinycloud.agent-data/synthetic-byte-fixture";
const database = "xyz.tinycloud.agent-data.index";
const sqlCanary = "SELECT 7 AS private_sql_canary";
const node = await createHermeticEncryptedNode({ nativeBearerPath: key, nativeSqlDatabase: database });
assert(new URL(node.host).hostname === "127.0.0.1" || new URL(node.host).hostname === "localhost");

async function run(args: string[], env: Record<string, string> = {}, input?: Buffer, shell?: string) {
  const child = spawn(shell ?? "node", shell ? [join(process.env.HOME!, ".local/share/tc-apps/tc"), ...args] : [cli, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (bytes: Buffer) => stdout.push(bytes));
  child.stderr.on("data", (bytes: Buffer) => stderr.push(bytes));
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

try {
  const session = node.ownerRestorableSession;
  await writeJsonAtomic(profileConfigPath("owner"), {
    name: "owner", host: node.host, chainId: session.chainId,
    spaceName: "applications", spaceId: session.spaceId,
    did: node.ownerDid, sessionDid: session.verificationMethod.split("#")[0],
    posture: "local-owner-key", operatorType: "human", authMethod: "local",
    privateKey: node.ownerPrivateKey, address: session.address,
    createdAt: "2026-07-15T00:00:00.000Z",
  });
  await writeJsonAtomic(sessionPath("owner"), session);
  const args = ["--quiet", "--json", "--profile", "owner", "--host", node.host];
  const value = Buffer.from([0, 255, 65, 13, 10, 66]);
  const put = [...args, "kv", "put", key, "--stdin", "--space", session.spaceId];
  const get = [...args, "kv", "get", key, "--raw", "--space", session.spaceId];
  const before = node.nativeBearerStats();
  const offPut = await run(put, {}, value);
  const offGet = await run(get);
  assert.equal(offPut.code, 0, offPut.stderr.toString());
  assert.equal(offGet.code, 0, offGet.stderr.toString());
  assert.deepEqual(offGet.stdout, value);
  const enabled = await run(["diagnostics", "enable", "--scope", "tc-apps"]);
  assert.equal(enabled.code, 0, enabled.stderr.toString());
  const run_id = randomUUID();
  const onPut = await run(put, { TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, run_id }) }, value);
  const onGet = await run(get, { TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, run_id, role: "verification" }) });
  const brokenRoot = join(process.env.HOME!, "failed-sink-file");
  await writeFile(brokenRoot, "synthetic");
  const failedPut = await run(put, { TC_DIAGNOSTICS_HOME: brokenRoot }, value);
  const failedGet = await run(get, { TC_DIAGNOSTICS_HOME: brokenRoot });
  for (const result of [onPut, failedPut]) assert.deepEqual(result, offPut);
  for (const result of [onGet, failedGet]) assert.deepEqual(result, offGet);
  const after = node.nativeBearerStats();
  assert.equal(after.kvWrites - before.kvWrites, 3);
  assert.equal(after.kvReads - before.kvReads, 3);
  let snapshot = await new DiagnosticStore(root).snapshot({ all: true });
  let events = snapshot.events;
  assert.equal(events.filter((event) => event.type === "invocation.start").length, 2);
  assert.equal(events.filter((event) => event.type === "invocation.finish").length, 2);
  assert.equal(events.filter((event) => event.type === "attempt.start" && event.service === "kv").length, 2);
  assert.equal(events.filter((event) => event.type === "attempt.finish" && event.service === "kv").length, 2);
  assert(events.some((event) => event.action === "put" && event.mutation === "confirmed" && event.verification === "write_response"));
  assert(events.some((event) => event.action === "get" && event.verification === "read_back" && event.verification_result === "found"));
  assert(events.every((event) => event.run_id === run_id));
  const sql = [...args, "sql", "query", sqlCanary, "--db", database, "--space", session.spaceId];
  const sqlContext = { TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, run_id }) };
  const sqlBefore = node.nativeBearerStats();
  assert.equal((await run(["diagnostics", "pause"])).code, 0);
  const sqlOff = await run(sql);
  assert.equal((await run(["diagnostics", "resume"])).code, 0);
  const sqlOn = await run(sql, sqlContext);
  const sqlFailedSink = await run(sql, { TC_DIAGNOSTICS_HOME: brokenRoot });
  assert.equal(sqlOff.code, 0, sqlOff.stderr.toString());
  assert.deepEqual(JSON.parse(sqlOff.stdout.toString()), { columns: ["synthetic"], rows: [[7]], rowCount: 1 });
  assert.deepEqual(sqlOn, sqlOff);
  assert.deepEqual(sqlFailedSink, sqlOff);
  assert.equal(node.nativeBearerStats().sqlRequests - sqlBefore.sqlRequests, 3);

  // Input validation fails before the actual service dispatch, not a fake fetch.
  const invalid = await run([...sql, "--params", "private_invalid_json_canary"], sqlContext);
  assert.notEqual(invalid.code, 0);
  assert.equal(node.nativeBearerStats().sqlRequests - sqlBefore.sqlRequests, 3);
  const execute = [...args, "sql", "execute", "INSERT INTO private_sql_canary VALUES (7)", "--db", database, "--space", session.spaceId];
  node.setSqlFault("lose_ack");
  const lost = await run(execute, sqlContext);
  assert.notEqual(lost.code, 0);
  assert.equal(node.nativeBearerStats().sqlRequests - sqlBefore.sqlRequests, 4);
  assert.equal(node.nativeBearerStats().sqlEffects - sqlBefore.sqlEffects, 1);
  snapshot = await new DiagnosticStore(root).snapshot({ all: true });
  events = snapshot.events;
  const sqlStarts = events.filter((event) => event.type === "attempt.start" && event.service === "sql");
  assert.equal(sqlStarts.length, 2);
  assert.equal(new Set(sqlStarts.map((event) => event.attempt_id)).size, 2);
  assert.equal(events.filter((event) => event.type === "attempt.finish" && event.service === "sql").length, 2);
  assert.equal(events.filter((event) => event.type === "retry.scheduled").length, 0);
  const lostInvocation = sqlStarts.find((event) => event.action === "execute")!.invocation_id;
  assert(events.some((event) => event.invocation_id === lostInvocation && event.mutation === "unknown"));
  assert(!events.some((event) => event.invocation_id === lostInvocation && event.mutation === "confirmed"));
  const invalidInvocation = events.filter((event) => event.type === "invocation.start" &&
    !events.some((attempt) => attempt.type === "attempt.start" && attempt.invocation_id === event.invocation_id));
  assert.equal(invalidInvocation.length, 1);

  if (process.env.TC_DIAGNOSTICS_TEST_WRAPPER) {
    const directory = join(process.env.HOME!, ".local/share/tc-apps");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await copyFile(process.env.TC_DIAGNOSTICS_TEST_WRAPPER, join(directory, "tc"));
    await writeFile(join(directory, "cli-path"), `${cli}\n`, { mode: 0o600 });
    for (const shell of ["dash", "bash"]) {
      const workflow_id = randomUUID();
      const context = { TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, scope: "tc-apps", run_id, workflow_id }) };
      const requestsBefore = node.nativeBearerStats().sqlRequests;
      // The wrapper's existing retry is exercised on a read only. SQLService
      // itself has no retry, and the lost mutation above is never reissued.
      node.setSqlFault("lose_ack");
      const recovered = await run(["sql", "query", sqlCanary, ...args, "--db", database, "--space", session.spaceId], context, undefined, shell);
      assert.deepEqual(recovered, sqlOff);
      assert.equal(node.nativeBearerStats().sqlRequests - requestsBefore, 2);
      const normalized = Buffer.from("wrapper-private-canary\n");
      const wrapperPut = await run(["kv", "put", key, "--stdin", ...args, "--space", session.spaceId], context, Buffer.from("wrapper-private-canary\n\n\n"), shell);
      assert.equal(wrapperPut.code, 0, wrapperPut.stderr.toString());
      assert.equal(wrapperPut.stderr.length, 0);
      const failedWrapperPut = await run(["kv", "put", key, "--stdin", ...args, "--space", session.spaceId],
        { ...context, TC_DIAGNOSTICS_HOME: brokenRoot }, Buffer.from("wrapper-private-canary\n\n\n"), shell);
      assert.deepEqual(failedWrapperPut, wrapperPut);
      const raw = await run(get, { TC_DIAGNOSTICS_HOME: brokenRoot });
      assert.deepEqual(raw.stdout, normalized);
      const linked = (await new DiagnosticStore(root).snapshot({ all: true })).events.filter((event) => event.workflow_id === workflow_id);
      const physical = linked.filter((event) => event.type === "attempt.start" && event.layer === "transport");
      assert.equal(physical.length, 3);
      assert.equal(new Set(physical.map((event) => event.attempt_id)).size, 3);
      assert.equal(new Set(physical.map((event) => event.invocation_id)).size, 3);
      assert(linked.some((event) => event.source === "wrapper" && event.type === "retry.scheduled"));
      assert(physical.every((event) => linked.some((start) => start.source === "cli" && start.type === "invocation.start" &&
        start.invocation_id === event.invocation_id && linked.some((child) =>
          child.source === "wrapper" && child.type === "attempt.start" && child.layer === "wrapper_child" && child.attempt_id === start.parent_id))),
        JSON.stringify({ shell, linkage: linked.filter((event) => event.type === "invocation.start" || event.type === "attempt.start" || event.type === "capture.health") }));
    }
    snapshot = await new DiagnosticStore(root).snapshot({ all: true });
    events = snapshot.events;
  }
  const encoded = JSON.stringify(snapshot);
  for (const forbidden of [key, database, sqlCanary, "private_invalid_json_canary", "wrapper-private-canary", node.host, node.ownerPrivateKey, session.delegationHeader.Authorization]) assert(!encoded.includes(forbidden));
  const selection = join(process.env.HOME!, "selection.json");
  await writeFile(selection, JSON.stringify({ invocation_ids: [...new Set(events.map((event) => event.invocation_id))] }), { mode: 0o600 });
  const exported = await run([
    "diagnostics", "export", "--selection", selection,
    "--out", join(root, "exports", randomUUID()), "--expires-at", new Date(Date.now() + 60_000).toISOString(),
  ]);
  assert.equal(exported.code, 0, exported.stderr.toString());
  const transfer = JSON.parse(exported.stdout.toString()).path as string;
  const recipient = { TC_DIAGNOSTICS_HOME: join(process.env.HOME!, "receiver"), TC_HOME: join(process.env.HOME!, "reader-profiles") };
  const imported = await run(["diagnostics", "import", transfer], recipient);
  const duplicate = await run(["diagnostics", "import", transfer], recipient);
  assert.equal(imported.code, 0, imported.stderr.toString());
  assert.equal(duplicate.code, 0, duplicate.stderr.toString());
  assert.equal(JSON.parse(imported.stdout.toString()).import_id, JSON.parse(duplicate.stdout.toString()).import_id);
  const review = await run(["diagnostics", "review", "--selection", selection, "--json"], recipient);
  assert.equal(review.code, 0, review.stderr.toString());
  assert(!review.stdout.toString().includes(key));
  const report = JSON.parse(review.stdout.toString()) as DiagnosticReview;
  assert.deepEqual(report.timeline.map((node) => node.event.event_id).sort(), events.map((event) => event.event_id).sort());
  assert.equal(report.invocations.length, events.filter((event) => event.type === "invocation.start").length);
  assert(report.invocations.every((invocation) => invocation.finish === "observed"));
  assert(report.invocations.some((invocation) => invocation.business === "complete"));
  assert(report.invocations.some((invocation) => invocation.mutation === "confirmed" && invocation.verification === "write_response"));
  assert(report.invocations.some((invocation) => invocation.verification === "read_back" && invocation.verification_result === "found"));
  assert.equal(report.retries.find((layer) => layer.layer === "transport")?.starts, events.filter((event) => event.type === "attempt.start" && event.layer === "transport").length);
  assert.equal(report.retries.find((layer) => layer.layer === "transport")?.finishes, events.filter((event) => event.type === "attempt.finish" && event.layer === "transport").length);
  assert(report.coverage.gaps.includes("import_untrusted"));
  await assert.rejects(access(recipient.TC_HOME), { code: "ENOENT" });
  process.stdout.write("diagnostic-kv-parity-ok\n");
  process.stdout.write(`${JSON.stringify({ sql: node.nativeBearerStats(), wrapper: Boolean(process.env.TC_DIAGNOSTICS_TEST_WRAPPER) })}\n`);
} finally {
  node.stop();
}
