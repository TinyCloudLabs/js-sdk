import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
interface ProcessResult { stdout: string; stderr: string; code: number }
interface ChildEvidence { pid: number; start: string; mode: string }

/** Installed-artifact acceptance, not a full-disk/deployment durability claim.
 * Requires Linux /proc and an unprivileged owner so chmod produces native EACCES.
 * The caller must serialize this with other consumers of its disposable install.
 */
export async function verifyInstalledDiagnosticFailures(fixture: string, nodeBinary: string): Promise<void> {
  assert.equal(process.platform, "linux", "Failure acceptance requires Linux process-origin evidence");
  assert.notEqual(process.getuid?.(), 0, "Run failure acceptance as an unprivileged owner: root bypasses chmod faults");
  const home = await mkdtemp(join(fixture, "diagnostic-failures-"));
  const packageRoot = join(fixture, "node_modules/@tinycloud/operations");
  const manifestPath = join(packageRoot, "package.json");
  const manifest = await readFile(manifestPath, "utf8");
  const shimName = `acceptance-${home.slice(home.lastIndexOf("/") + 1)}.cjs`;
  const shim = join(packageRoot, shimName);
  const configPath = join(home, "fault.json");
  const childPath = join(home, "child.json");
  const appendPath = join(home, "append.json");
  const fifoPath = join(home, "native-hung-append");
  const runner = join(home, "acceptance.mjs");
  const guard = join(home, "business-guard.cjs");
  const profileRoot = join(home, "profiles");
  const env = {
    PATH: process.env.PATH, HOME: home, TC_HOME: profileRoot,
    XDG_STATE_HOME: join(home, "state"), NO_COLOR: "1",
    TC_DIAGNOSTICS_CONTEXT: JSON.stringify({ version: 1, scope: "tc-apps" }),
  };
  let activeRoot: string | undefined;

  async function execute(args: string[], root: string, guarded = false): Promise<ProcessResult> {
    try {
      const result = await execFile(nodeBinary, args, {
        cwd: fixture, env: { ...env, TC_DIAGNOSTICS_HOME: root, ...(guarded ? { NODE_OPTIONS: `--require=${guard}` } : {}) },
        timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
      });
      return { ...result, code: 0 };
    } catch (error) {
      const result = error as Error & { code?: number | string; signal?: string; killed?: boolean; stdout?: string; stderr?: string };
      assert.equal(result.signal, null, `Unexpected child signal: ${String(result.signal)}`);
      assert.notEqual(result.killed, true, "Acceptance child exceeded its execution bound");
      assert.equal(typeof result.code, "number", result.message);
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code as number };
    }
  }

  async function configure(mode: string): Promise<void> {
    // The bridge/child intentionally inherit neither env nor execArgv. Only the
    // disposable worker entry reads these fixture-owned, embedded paths.
    await rm(childPath, { force: true });
    await rm(appendPath, { force: true });
    await writeFile(configPath, JSON.stringify({ mode, childPath, appendPath, fifoPath }), { mode: 0o600 });
  }

  async function assertChildStopped(requireAppend: boolean): Promise<void> {
    const child = JSON.parse(await readFile(childPath, "utf8")) as ChildEvidence;
    assert(Number.isSafeInteger(child.pid) && child.pid > 0);
    assert.match(child.start, /^\d+$/);
    if (requireAppend) {
      const append = JSON.parse(await readFile(appendPath, "utf8")) as ChildEvidence & { boundary: string };
      assert.deepEqual({ pid: append.pid, start: append.start, mode: append.mode }, child);
      assert.equal(append.boundary, "FileHandle.write:.jsonl");
    }
    const deadline = performance.now() + 5_000;
    for (;;) {
      let stat: string;
      try { stat = await readFile(`/proc/${child.pid}/stat`, "utf8"); }
      catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
        return;
      }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (fields[19] !== child.start) return; // PID reuse is not our child.
      // A zombie cannot execute or hold files open; reaping belongs to its parent/init.
      if (fields[0] === "Z" || fields[0] === "X") return;
      assert(performance.now() < deadline, `Filesystem child ${child.pid} survived bounded cleanup (${fields[0]})`);
      await delay(10);
    }
  }

  try {
    await execFile("mkfifo", ["--mode=600", fifoPath]);
    await writeFile(shim, `
'use strict';
const {isMainThread}=require('node:worker_threads');
if(isMainThread&&typeof process.send==='function'){
  const fs=require('node:fs'), promises=require('node:fs/promises');
  const config=JSON.parse(fs.readFileSync(${JSON.stringify(configPath)},'utf8'));
  const stat=fs.readFileSync('/proc/self/stat','utf8');
  const identity={pid:process.pid,start:stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/)[19],mode:config.mode};
  fs.writeFileSync(config.childPath,JSON.stringify(identity),{mode:0o600});
  const open=promises.open;
  let recorded=false;
  promises.open=async function(path,...args){
    const handle=await open.call(this,path,...args);
    if(String(path).endsWith('.jsonl')){
      const write=handle.write.bind(handle);
      handle.write=async(...args)=>{
        if(!recorded){
          recorded=true;
          fs.writeFileSync(config.appendPath,JSON.stringify({...identity,boundary:'FileHandle.write:.jsonl'}),{mode:0o600});
        }
        // Controlled native-boundary injection: no disk or /dev/shm is filled.
        if(config.mode==='enospc') throw Object.assign(new Error('controlled_native_append'),{code:'ENOSPC'});
        if(config.mode==='death') process.kill(process.pid,'SIGKILL');
        // A real libuv filesystem operation blocks on a private FIFO with no writer.
        if(config.mode==='hung') await promises.readFile(config.fifoPath);
        return write(...args);
      };
    }
    return handle;
  };
  require('node:module').syncBuiltinESMExports();
}
require('./dist/diagnostics-worker.cjs');
`, { mode: 0o600, flag: "wx" });
    const installed = JSON.parse(manifest) as { exports: Record<string, unknown> };
    assert(installed.exports["./diagnostics-worker"], "Installed package must expose its real worker");
    installed.exports["./diagnostics-worker"] = { import: `./${shimName}`, require: `./${shimName}` };
    await writeFile(manifestPath, JSON.stringify(installed));
    await writeFile(guard, `
const fs=require('node:fs'),fsp=require('node:fs/promises'),net=require('node:net');
let violations=0;
function deny(){violations++;throw new Error('synthetic_business_boundary_denied');}
globalThis.fetch=deny;
net.Socket.prototype.connect=deny;
const protectedRoot=${JSON.stringify(profileRoot)};
for(const [object,methods] of [[fs,['open','openSync','readFile','readFileSync','writeFile','writeFileSync','mkdir','mkdirSync']],[fsp,['open','readFile','writeFile','mkdir']]]){
  for(const method of methods){
    const original=object[method];
    object[method]=function(path,...args){
      if(String(path)===protectedRoot||String(path).startsWith(protectedRoot+'/')) deny();
      return original.call(this,path,...args);
    };
  }
}
require('node:module').syncBuiltinESMExports();
process.once('exit',()=>{if(violations)process.exitCode=97;});
`, { mode: 0o600 });
    await writeFile(runner, `
import assert from 'node:assert/strict';
import {chmod,readFile,readdir,appendFile,open} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DIAGNOSTIC_LIMITS,DiagnosticStore,createDiagnosticRuntime,makeDiagnosticContext,reviewDiagnosticSnapshot,repairDiagnosticLock} from '@tinycloud/operations/diagnostics';
const mode=process.argv[2],root=process.env.TC_DIAGNOSTICS_HOME;
const store=new DiagnosticStore();
if(mode==='enable'){
  await store.control('enable',{scope:'tc-apps'});
}else if(mode==='recover_hung'){
  // The parent has independently observed the filesystem child's death.
  await assert.rejects(store.snapshot({all:true}),error=>error.code==='locked');
  assert.deepEqual(await repairDiagnosticLock(root,{writers_stopped:true}),{repaired:true});
  const review=reviewDiagnosticSnapshot(await store.snapshot({all:true}));
  assert.equal(review.event_count,0);assert(review.coverage.gaps.includes('coverage_unknown'));
  assert.equal(review.invocations.length,0);assert.equal(review.findings.length,0);
  console.log(JSON.stringify({mode,events:review.event_count,coverage:review.coverage.gaps}));
}else{
  const runtime=createDiagnosticRuntime({source:'cli'});
  async function settled(){
    const deadline=performance.now()+5000;
    while(runtime.health().pending||runtime.health().maintenance_pending){
      assert(performance.now()<deadline,JSON.stringify(runtime.health()));await delay(5);
    }
    return runtime.health();
  }
  try{
    if(mode==='denied'){
      // Verify the native denial itself, not only our error classification.
      await assert.rejects(open(root,'r'),error=>error.code==='EACCES'||error.code==='EPERM');
      assert.equal(await runtime.binding(),undefined);
      assert.equal(runtime.health().failure,'permission');
      assert.equal(runtime.health().accepted,0);
      await assert.rejects(store.status(),error=>error.code==='permission');
      console.log(JSON.stringify({mode,admitted:false,failure:'permission'}));
    }else{
      const policy=await store.control('enable',{scope:'tc-apps'});
      const binding=await runtime.binding();assert(binding);
      const first=makeDiagnosticContext(binding,'cli');
      assert.equal(runtime.emit({type:'invocation.start',activity:'kv'},first),true);
      const admitted=runtime.health();
      assert.equal(admitted.accepted,1);
      let terminal;
      if(mode==='hung'){
        const deadline=performance.now()+5000;
        while(!(await readFile(${JSON.stringify(appendPath)}).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false;}))){
          assert(performance.now()<deadline,'Filesystem child never reached the append boundary');await delay(5);
        }
        const started=performance.now(),drained=runtime.drainSync(),elapsed=performance.now()-started;
        assert.equal(drained.acknowledged,0);assert(drained.pending>=1);
        assert.equal(runtime.health().pending,1);assert.equal(runtime.health().failure,'timeout');
        assert(elapsed>=DIAGNOSTIC_LIMITS.drain_ms-5&&elapsed<DIAGNOSTIC_LIMITS.drain_ms+1000);
        terminal={elapsed_ms:elapsed,pending:drained.pending,budget_ms:DIAGNOSTIC_LIMITS.drain_ms};
        await runtime.close();
      }
      const health=await settled();
      if(mode==='enospc'||mode==='death'||mode==='hung'){
        assert.equal(health.accepted,1);assert.equal(health.acknowledged,0);
        assert.equal(health.dropped,1);assert.equal(health.pending,0);assert.equal(health.queue_bytes,0);
        assert.equal(health.failure,mode==='enospc'?'quota':'worker');
        await runtime.close();
        if(mode==='death'){
          // An append-time kill abandons a real lock. Never silently erase it.
          await assert.rejects(store.snapshot({all:true}),error=>error.code==='locked');
          assert.deepEqual(await repairDiagnosticLock(root,{writers_stopped:true}),{repaired:true});
        }
        let coverage;
        if(mode!=='hung'){
          const review=reviewDiagnosticSnapshot(await store.snapshot({all:true}));
          assert.equal(review.event_count,0);
          assert(review.coverage.gaps.includes('coverage_unknown'));
          assert.equal(review.invocations.length,0);
          assert.equal(review.findings.length,0);
          coverage=review.coverage.gaps;
        }
        assert.equal(runtime.health().ready,false);
        assert.equal(runtime.health().pending,0);
        console.log(JSON.stringify({mode,admitted,settled:health,coverage,terminal}));
      }else if(mode==='barrier'){
        assert.equal(health.acknowledged,1);
        const second=makeDiagnosticContext(binding,'cli');
        assert.equal(runtime.emit({type:'invocation.start',activity:'kv'},second),true);
        assert.equal((await settled()).acknowledged,2);
        const segments=join(root,'partitions',policy.partition_id,'segments');
        const names=(await readdir(segments)).filter(name=>name.endsWith('.jsonl'));
        assert.equal(names.length,1,'Mixed-selection fixture must share a real segment');
        const segment=join(segments,names[0]);
        // Force real maintenance work: a crash-tail needs an atomic rewrite.
        await appendFile(segment,'{"synthetic_incomplete":');
        await chmod(segments,0o500);
        try{
          await assert.rejects(store.control('pause'),error=>error.code==='permission');
          const paused=await store.status();
          assert.equal(paused.paused,true);assert.equal(paused.enabled,true);
          assert.equal(paused.generation,policy.generation+1);
        }finally{await chmod(segments,0o700);}
        // A stale admitted event is rejected by the published fence, not saved.
        const stale=makeDiagnosticContext(binding,'cli');
        assert.equal(runtime.emit({type:'invocation.finish',business:'unknown'},stale),true);
        assert.equal((await settled()).dropped,1);
        const resumed=await store.control('resume');
        assert.equal(resumed.generation,policy.generation+2);
        const freshBinding=await runtime.binding();assert(freshBinding);
        const before=await store.snapshot({all:true});
        assert.deepEqual(before.events.map(event=>event.invocation_id).sort(),[first.invocation_id,second.invocation_id].sort());
        await chmod(segments,0o500);
        try{
          await assert.rejects(store.delete({invocation_ids:[first.invocation_id]}),error=>{
            assert.equal(error.name,'DiagnosticDeletionError');
            assert.equal(error.incomplete,true);assert.equal(error.code,'permission');return true;
          });
          const fenced=await store.status();
          assert.equal(fenced.paused,true);assert.equal(fenced.enabled,true);
          assert.equal(fenced.generation,resumed.generation+1);
        }finally{await chmod(segments,0o700);}
        // Failed mixed rewrite must retain the selected AND unrelated line.
        const retained=await store.snapshot({all:true});
        assert.deepEqual(retained.events.map(event=>event.event_id).sort(),before.events.map(event=>event.event_id).sort());
        const staleAfterDelete=makeDiagnosticContext(freshBinding,'cli');
        assert.equal(runtime.emit({type:'invocation.finish',business:'unknown'},staleAfterDelete),true);
        assert.equal((await settled()).dropped,2);
        const removed=await store.delete({all:true},{pause_after:true});
        assert.equal(removed.complete,true);assert.equal(removed.paused,true);assert.equal(removed.events,2);
        assert.equal(runtime.emit({type:'invocation.finish',business:'unknown'},staleAfterDelete),true);
        assert.equal((await settled()).dropped,3);
        await runtime.close();
        const final=await store.snapshot({all:true});assert.equal(final.events.length,0);
        assert(reviewDiagnosticSnapshot(final).coverage.gaps.includes('coverage_unknown'));
        assert.equal((await store.status()).paused,true);
        console.log(JSON.stringify({mode,maintenance_failure:'permission',deletion_incomplete:true,stale_dropped:3,deleted:removed.events,paused:removed.paused}));
      }else assert.fail('Unknown fixture mode');
    }
  }finally{await runtime.close();}
}
`, { mode: 0o600 });

    for (const mode of ["enospc", "death", "hung", "barrier"]) {
      activeRoot = join(home, `runtime-${mode}`);
      await configure(mode);
      const result = await execute([runner, mode], activeRoot);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      const evidence = JSON.parse(result.stdout) as { mode: string };
      assert.equal(evidence.mode, mode);
      await assertChildStopped(true);
      if (mode === "hung") {
        const recovered = await execute([runner, "recover_hung"], activeRoot);
        assert.equal(recovered.code, 0, recovered.stderr);
        assert.equal(recovered.stderr, "");
        console.log(`Installed hung-writer recovery evidence: ${recovered.stdout.trim()}`);
      }
      console.log(`Installed diagnostic failure evidence: ${result.stdout.trim()}`);
    }

    const cli = join(fixture, "node_modules/@tinycloud/cli/bin/tc");
    for (const args of [["--help"], ["--synthetic-invalid-option"]]) {
      const offRoot = join(home, `off-${args[0]}`);
      await configure("off");
      const baseline = await execute([cli, ...args], offRoot, true);
      assert.equal(baseline.code, args[0] === "--help" ? 0 : 1);
      await assert.rejects(readFile(offRoot), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      await assert.rejects(readFile(childPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      for (const mode of ["enospc", "death", "hung", "denied"]) {
        activeRoot = join(home, `cli-${mode}-${args[0]}`);
        await configure(mode);
        const enabled = await execute([runner, "enable"], activeRoot);
        assert.equal(enabled.code, 0, enabled.stderr);
        assert.equal(enabled.stderr, "");
        if (mode === "denied") await chmod(activeRoot, 0o000);
        try {
          if (mode === "denied") {
            const denial = await execute([runner, "denied"], activeRoot);
            assert.equal(denial.code, 0, denial.stderr);
            assert.equal(denial.stderr, "");
            await assertChildStopped(false);
            await configure(mode);
          }
          const fault = await execute([cli, ...args], activeRoot, true);
          assert.deepEqual(fault, baseline, `CLI stdout/stderr/exit parity: ${mode} ${args.join(" ")}`);
          await assert.rejects(readFile(childPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
        } finally {
          if (mode === "denied") await chmod(activeRoot, 0o700);
        }
      }
    }
    await assert.rejects(readFile(profileRoot), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    console.log("Installed unrelated CLI help/parser: exact stdout, stderr and exit parity with no diagnostic worker under off and configured fault modes; network and synthetic profile access guarded. Native ENOSPC/death/FIFO/denial boundaries are exercised separately above, not inferred from unrelated commands.");
  } finally {
    // Restore the caller's installed package even when an assertion fails.
    await writeFile(manifestPath, manifest);
    await rm(shim, { force: true });
    if (activeRoot) await chmod(activeRoot, 0o700).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}
