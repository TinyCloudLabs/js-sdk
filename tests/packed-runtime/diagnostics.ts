import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { packPackage } from "./tinycloud-entrypoints.js";

const execFile = promisify(execFileCallback);

/** Executes installed ESM/CJS consumers and the packaged worker, not source imports. */
export async function verifyInstalledDiagnostics(fixture: string, nodeBinary = process.env.NODE_BINARY ?? "node"): Promise<void> {
  const home = await mkdtemp(join(fixture, "diagnostic-home-"));
  const root = join(home, "history");
  const env = { PATH: process.env.PATH, HOME: home, TC_HOME: home, TC_DIAGNOSTICS_HOME: root, NO_COLOR: "1" };
  const producer = join(fixture, "diagnostic-producer.mjs");
  const reader = join(fixture, "diagnostic-reader.mjs");
  try {
    await writeFile(producer, `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import * as esm from '@tinycloud/operations/diagnostics';
const cjs=createRequire(import.meta.url)('@tinycloud/operations/diagnostics');
const runtime=esm.createDiagnosticRuntime({source:'cli'});
const binding=await runtime.binding();
assert(binding);
// Warm one actual append, not an arbitrary sleep. Cold one/eight-process exits
// are measured separately; this regression isolates mixed-bundle correctness.
esm.withDiagnosticContext(esm.makeDiagnosticContext(binding,'cli'),()=>esm.emitDiagnostic({type:'capture.health',outcome:'accepted'}));
const readyDeadline=performance.now()+2000;
while(runtime.health().pending>0&&performance.now()<readyDeadline) await delay(5);
assert.equal(runtime.health().acknowledged,1,JSON.stringify(runtime.health()));
const ids=[];
await Promise.all(Array.from({length:8},(_,index)=>{
  const entry=index%2?esm:cjs;
  const other=index%2?cjs:esm;
  const scope=entry.makeDiagnosticContext(binding,'cli');
  ids.push(scope.invocation_id);
  return entry.withDiagnosticContext(scope,async()=>{
    assert.equal(other.getDiagnosticContext().invocation_id,scope.invocation_id);
    other.emitDiagnostic({type:'invocation.start',activity:'kv'});
    const operation=entry.diagnosticId();
    await entry.withDiagnosticContext({...scope,operation_id:operation,parent_id:scope.invocation_id},async()=>{
      const finish=other.beginDiagnosticPhase('execution',{operation_id:operation});
      await Promise.resolve();
      assert.equal(other.getDiagnosticContext().invocation_id,scope.invocation_id);
      other.withDiagnosticContext(undefined,()=>assert.equal(entry.getDiagnosticContext(),undefined));
      finish({outcome:'complete'});
    });
    other.emitDiagnostic({type:'invocation.finish',activity:'kv',business:'unknown'});
  });
}));
assert.equal(esm.getDiagnosticContext(),undefined);
assert.equal(cjs.getDiagnosticContext(),undefined);
process.once('exit',()=>{
  const started=performance.now();
  const drain=runtime.drainSync();
  process.stdout.write(JSON.stringify({ids,drain,terminal_wait_ms:performance.now()-started})+'\\n');
});
if(process.argv[2]==='natural') process.exitCode=23; else process.exit(23);
`, { mode: 0o600 });
    await writeFile(reader, `
import assert from 'node:assert/strict';
import {DiagnosticStore} from '@tinycloud/operations/diagnostics';
const ids=JSON.parse(process.argv[2]);
const snapshot=await new DiagnosticStore().snapshot({invocation_ids:ids});
assert.equal(snapshot.events.length,32);
for(const id of ids){
  const events=snapshot.events.filter(event=>event.invocation_id===id);
  assert.deepEqual(events.map(event=>event.type),['invocation.start','phase.start','phase.finish','invocation.finish']);
  assert.equal(events[1].operation_id,events[2].operation_id);
  assert.equal(events[1].parent_id,id);
  assert.equal(events[2].parent_id,id);
  assert.notEqual(events[1].operation_id,events[1].parent_id);
  assert(events.every(event=>event.source==='cli'));
}
assert.equal(new Set(snapshot.events.map(event=>event.process_id)).size,1);
assert.equal(new Set(snapshot.events.map(event=>event.source_id)).size,1);
assert.equal(new Set(snapshot.events.map(event=>event.sequence)).size,32);
console.log(JSON.stringify({persisted:snapshot.events.length,invocations:ids.length}));
`, { mode: 0o600 });
    const absent = await execFile(nodeBinary, ["--input-type=module", "-e", `
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {DiagnosticStore} from '@tinycloud/operations/diagnostics';
const store=new DiagnosticStore();
assert.equal((await store.status()).enabled,false);
assert.equal(await access(process.env.TC_DIAGNOSTICS_HOME).then(()=>true,()=>false),false);
await store.control('enable',{scope:'tc-apps'});
`], { cwd: fixture, env, timeout: 15_000 });
    assert.equal(absent.stderr, "");
    for (const mode of ["direct", "natural"]) {
      let output: string;
      try {
        await execFile(nodeBinary, [producer, mode], { cwd: fixture, env, timeout: 15_000 });
        throw new Error("Diagnostic producer did not preserve its exit status.");
      } catch (error) {
        const result = error as Error & { code?: number; stdout?: string; stderr?: string };
        assert.equal(result.code, 23);
        assert.equal(result.stderr, "");
        output = result.stdout ?? "";
      }
      const evidence = JSON.parse(output) as { ids: string[]; drain: { pending: number; acknowledged: number }; terminal_wait_ms: number };
      assert.equal(evidence.drain.pending, 0);
      assert.equal(evidence.drain.acknowledged, 33);
      const readback = await execFile(nodeBinary, [reader, JSON.stringify(evidence.ids)], { cwd: fixture, env, timeout: 15_000 });
      assert.equal(readback.stderr, "");
      assert.deepEqual(JSON.parse(readback.stdout), { persisted: 32, invocations: 8 });
      console.log(`Installed diagnostic worker: 32 complete acknowledged lines after one readiness append, 8 isolated ESM/CJS scopes, acyclic phase parents, ${mode} exit 23; ${evidence.terminal_wait_ms.toFixed(2)} ms warmed default drain.`);
    }
  } finally {
    await rm(producer, { force: true });
    await rm(reader, { force: true });
    await rm(home, { recursive: true, force: true });
  }
}

/** Runs the generated recipe with installed product dependencies, not a source link. */
export async function verifyInstalledDiagnosticReproduction(fixture: string, nodeBinary = process.env.NODE_BINARY ?? "node"): Promise<void> {
  const home = await mkdtemp(join(fixture, "diagnostic-reproduction-"));
  const generator = join(home, "generate.mjs");
  const guard = join(home, "guard.cjs");
  const env = {
    PATH: process.env.PATH, HOME: home, TC_HOME: join(home, "ambient-profile-trap"),
    TC_DIAGNOSTICS_HOME: join(home, "history"), NO_COLOR: "1", NODE_OPTIONS: `--require=${guard}`,
  };
  try {
    await writeFile(guard, `
const fs=require('node:fs'), fsp=require('node:fs/promises'), net=require('node:net');
let forbidden=0;
function deny(){forbidden++;throw new Error('synthetic_boundary_denied');}
globalThis.fetch=deny;
net.Socket.prototype.connect=deny;
for(const [object,method] of [[fs,'readFileSync'],[fs,'readFile'],[fs,'openSync'],[fsp,'readFile'],[fsp,'open']]){
  const original=object[method];
  object[method]=function(path,...args){
    if(String(path)===process.env.TC_HOME||String(path).startsWith(process.env.TC_HOME+'/')) deny();
    return original.call(this,path,...args);
  };
}
require('node:module').syncBuiltinESMExports();
process.once('exit',()=>{if(forbidden)process.exitCode=97;});
`, { mode: 0o600 });
    await writeFile(generator, `
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
  DiagnosticStore, createDiagnosticRuntime, makeDiagnosticContext,
  withDiagnosticContext, emitDiagnostic, diagnosticFixtureRevision,
  selectDiagnosticCase, bundleDiagnosticCase, reviewDiagnostics,
} from '@tinycloud/operations/diagnostics';
import {reproduceDiagnosticFixture} from '@tinycloud/operations/diagnostics-reproduction';
const fixture={schema_version:1,kind:'wrong_units',fixture_id:randomUUID(),reviewed:true,synthetic:true,
  expected:{value:12,unit:'U1'},observed:{value:12,unit:'U2'}};
const store=new DiagnosticStore();
await store.control('enable',{scope:'tc-apps',detail_policy:'encrypted-excluded-backups'});
const runtime=createDiagnosticRuntime({source:'client'});
try {
  const binding=await runtime.binding();assert(binding);
  await withDiagnosticContext(makeDiagnosticContext(binding,'client'),async()=>{
    emitDiagnostic({type:'invocation.start',activity:'apps_write'});
    const result=await reproduceDiagnosticFixture(fixture);
    assert.deepEqual(result.observed,fixture.observed);
    assert.equal(result.independent_read_back,true);
    emitDiagnostic({type:'invocation.finish',business:'unknown',exit_code:0});
  });
} finally {await runtime.close();}
const snapshot=await store.snapshot({all:true});
const start=snapshot.events.find(event=>event.type==='invocation.start');
const finish=snapshot.events.find(event=>event.type==='invocation.finish');
assert(start&&finish);
const intent=randomUUID(),observed=randomUUID(),expiry=new Date(Date.now()+3600000).toISOString();
const selection={
  schema_version:1,expires_at:expiry,purpose:'synthetic_reproduction',owner_selected:true,
  no_secrets_or_unrelated_content:true,detail_policy:'encrypted-excluded-backups',
  event_ids:snapshot.events.map(event=>event.event_id),
  passages:[
    {id:intent,kind:'intent',origin:'owner',text:'Store 12 U1',event_ids:[start.event_id],unit:{value:'U1',start:9,end:11}},
    {id:observed,kind:'record_excerpt',origin:'selected_record',text:'Stored 12 U2',event_ids:[finish.event_id],unit:{value:'U2',start:10,end:12}},
  ],
  feedback:{classification:'wrong_units',passage_ids:[intent,observed]},
  equivalence:{fixture_id:fixture.fixture_id,fixture_revision:diagnosticFixtureRevision(fixture),task_class:'record_write_readback',cache_state:'cold'},
};
const manifest=join(process.env.HOME,'selection.json'),input=join(process.env.HOME,'fixture.json');
await writeFile(manifest,JSON.stringify(selection),{mode:0o600});
await writeFile(input,JSON.stringify(fixture),{mode:0o600});
const selected=await selectDiagnosticCase(store,manifest);
const review=await reviewDiagnostics(store,{case_ids:[selected.case_id],include_detail:true});
assert.equal(review.findings[0].status,'selected_evidence_supports');
const bundle=await bundleDiagnosticCase(store,{case_id:selected.case_id,fixture:input,
  out:join(process.env.TC_DIAGNOSTICS_HOME,'exports',randomUUID()),expires_at:expiry});
console.log(JSON.stringify({path:bundle.path,expected:fixture.expected,observed:fixture.observed}));
`, { mode: 0o600 });
    const generated = await execFile(nodeBinary, [generator], { cwd: fixture, env, timeout: 30_000 });
    assert.equal(generated.stderr, "");
    const bundle = JSON.parse(generated.stdout) as { path: string; expected: { value: number; unit: string }; observed: { value: number; unit: string } };
    const result = await execFile(nodeBinary, [join(bundle.path, "reproduce.mjs"), "--reviewed-synthetic"], { cwd: bundle.path, env, timeout: 30_000 });
    assert.equal(result.stderr, "");
    const proof = JSON.parse(result.stdout) as {
      expected: unknown; observed: unknown; write_outcome: string; read_outcome: string;
      independent_read_back: boolean; semantic_match: boolean; finding: string; production_replay: boolean;
    };
    assert.deepEqual(proof.expected, bundle.expected);
    assert.deepEqual(proof.observed, bundle.observed);
    assert.equal(proof.write_outcome, "ok");
    assert.equal(proof.read_outcome, "ok");
    assert.equal(proof.independent_read_back, true);
    assert.equal(proof.semantic_match, false);
    assert.equal(proof.finding, "wrong_units");
    assert.equal(proof.production_replay, false);
    console.log("Installed generated recipe: real tc-apps write and independent read reproduce selected U1/U2 mismatch; network and ambient profile access denied.");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export async function runPackedDiagnostics(): Promise<void> {
  const fixture = await mkdtemp(join(tmpdir(), "tc-diagnostic-pack-"));
  try {
    await mkdir(join(fixture, "node_modules"));
    await writeFile(join(fixture, "package.json"), '{"private":true,"type":"module"}\n');
    // Deliberately install only operations. Diagnostics cannot depend on the
    // operations registry, Node SDK/WASM, Commander, MCP, or optional packages.
    await packPackage(resolve(import.meta.dir, "../../packages/operations"), fixture);
    await verifyInstalledDiagnostics(fixture);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

if (import.meta.main) await runPackedDiagnostics();
