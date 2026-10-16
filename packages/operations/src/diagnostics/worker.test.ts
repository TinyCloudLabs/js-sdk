import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const entry = fileURLToPath(new URL("../../dist/diagnostics.js", import.meta.url));

async function nodeScenario(body: string, enable = true) {
  const home = await mkdtemp(join(tmpdir(), "tc-diagnostic-worker-")); homes.push(home);
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required for the packaged diagnostic worker acceptance tests");
  const script = `
    import {pathToFileURL} from 'node:url';
    import {mkdir,rm,readFile,readdir,writeFile,lstat,symlink} from 'node:fs/promises';
    import {join} from 'node:path';
    import {setTimeout as sleep} from 'node:timers/promises';
    const {DiagnosticStore,createDiagnosticRuntime,makeDiagnosticContext,resolveDiagnosticTenant,reviewDiagnosticSnapshot,DIAGNOSTIC_LIMITS} = await import(pathToFileURL(process.env.DIAGNOSTIC_ENTRY).href);
    const root = join(process.env.HOME,'diagnostics');
    const store = new DiagnosticStore(root);
    const policy = ${enable ? "await store.control('enable',{scope:'tc-apps'})" : "undefined"};
    const runtime = createDiagnosticRuntime({root,source:'cli'});
    const binding = await runtime.binding();
    if (${enable} && !binding) throw new Error('Synthetic diagnostic policy was not discovered');
    const context = binding ? makeDiagnosticContext(binding,'cli') : undefined;
    const settle = async () => {
      const deadline = performance.now() + (Math.ceil(DIAGNOSTIC_LIMITS.queue_events / DIAGNOSTIC_LIMITS.batch_events) + 1) * DIAGNOSTIC_LIMITS.lock_ms + 2000;
      while(runtime.health().pending && performance.now()<deadline) await sleep(5);
      if(runtime.health().pending) throw new Error('Diagnostic worker did not settle');
    };
    try { ${body} } finally { await runtime.close(); }
  `;
  const child = Bun.spawn([node, "--input-type=module", "--eval", script], {
    env: { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: join(home, "state"), DIAGNOSTIC_ENTRY: entry },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe(""); expect(exit).toBe(0);
  return JSON.parse(stdout);
}

test("packaged Node worker acknowledges complete JSONL lines and synchronous drains preserve accounting", async () => {
  const result = await nodeScenario(`
    const accepted = runtime.emit({type:'invocation.start',activity:'kv'},context);
    const cold = runtime.drainSync(50);
    await settle();
    const final = runtime.drainSync(50);
    const directory = join(root,'partitions',policy.partition_id,'segments');
    const names = await readdir(directory);
    const text = await readFile(join(directory,names[0]),'utf8');
    const events = text.trimEnd().split('\\n').map(JSON.parse);
    const snapshot = await store.snapshot({all:true});
    console.log(JSON.stringify({accepted,cold,final,complete:text.endsWith('\\n'),events:events.map(e=>({invocation_id:e.invocation_id,type:e.type})),expected:context.invocation_id,snapshot:snapshot.events.map(e=>e.invocation_id)}));
  `);
  expect(result.accepted).toBe(true);
  expect(result.cold.acknowledged + result.cold.dropped + result.cold.pending).toBe(1);
  expect(result.final).toEqual({ acknowledged: 1, dropped: 0, pending: 0 });
  expect(result.complete).toBe(true);
  expect(result.events).toEqual([{ invocation_id: result.expected, type: "invocation.start" }]);
  expect(result.snapshot).toEqual([result.expected]);
});

test("saturation recovery persists exact bounded loss counts in stored review without changing business acknowledgments", async () => {
  const result = await nodeScenario(`
    const lock = join(root,'.writer-lock');
    await mkdir(lock,{mode:0o700});
    let accepted=0,maxPending=0,maxBytes=0;
    const submitted=DIAGNOSTIC_LIMITS.queue_events+16;
    for(let index=0;index<submitted;index++) {
      if(runtime.emit({type:'operation.step',ordinal:index},context)) accepted++;
      const health=runtime.health(); maxPending=Math.max(maxPending,health.pending);maxBytes=Math.max(maxBytes,health.queue_bytes);
    }
    await settle();
    const blocked = runtime.health();
    await rm(lock,{recursive:true});
    const resumed = runtime.emit({type:'invocation.finish',business:'complete'},context);
    await settle();
    const snapshot = await store.snapshot({all:true});
    const review = reviewDiagnosticSnapshot(snapshot);
    console.log(JSON.stringify({accepted,maxPending,maxBytes,submitted,limits:DIAGNOSTIC_LIMITS,blocked,resumed,final:runtime.health(),
      business:snapshot.events.filter(e=>e.type!=='capture.health').map(e=>e.type),
      losses:snapshot.events.filter(e=>e.type==='capture.health'),gaps:review.coverage.gaps,invocation:context.invocation_id}));
  `);
  expect(result.maxPending).toBeLessThanOrEqual(result.limits.queue_events);
  expect(result.maxBytes).toBeLessThanOrEqual(result.limits.queue_bytes);
  expect(result.blocked).toMatchObject({ acknowledged: 0, dropped: result.submitted, pending: 0 });
  expect(result.resumed).toBe(true);
  expect(result.final).toMatchObject({ acknowledged: 1, dropped: result.submitted, pending: 0 });
  expect(result.business).toEqual(["invocation.finish"]);
  expect(result.losses.reduce((sum: number, event: { dropped: number }) => sum + event.dropped, 0)).toBe(result.submitted);
  expect(result.losses.map((event: { failure: string }) => event.failure).sort()).toEqual(["lock_contention", "queue_full"]);
  for (const event of result.losses) {
    expect(event.invocation_id).toBe(result.invocation);
    expect(event.ordinal).toBeUndefined();
    expect(event.business).toBeUndefined();
  }
  expect(result.gaps).toContain("dropped_events");
  expect(result.gaps).toContain("sink_failure");
}, 10000);

test("packaged batching retains nonzero history and appends every new ordinal", async () => {
  const result = await nodeScenario(`
    runtime.emit({type:'invocation.start'},context);
    await settle();
    const directory=join(root,'partitions',policy.partition_id,'segments');
    const path=join(directory,(await readdir(directory))[0]);
    const original=await readFile(path,'utf8');
    const fixture=original.repeat(Math.floor(1024*1024/Buffer.byteLength(original)));
    await writeFile(path,fixture);
    const started=performance.now();
    for(let ordinal=0;ordinal<32;ordinal++) runtime.emit({type:'operation.step',ordinal},context);
    await settle();
    const elapsed_ms=performance.now()-started;
    const snapshot=await store.snapshot({all:true});
    console.log(JSON.stringify({elapsed_ms,fixture_bytes:Buffer.byteLength(fixture),health:runtime.health(),ordinals:snapshot.events.filter(e=>e.type==='operation.step').map(e=>e.ordinal).sort((a,b)=>a-b),starts:snapshot.events.filter(e=>e.type==='invocation.start').map(e=>e.invocation_id),expected:context.invocation_id}));
  `);
  expect(result.fixture_bytes).toBeGreaterThan(1024 * 1024 - 4096);
  expect(result.health).toMatchObject({ acknowledged: 33, dropped: 0, pending: 0 });
  expect(result.ordinals).toEqual(Array.from({ length: 32 }, (_, index) => index));
  expect(result.starts).toEqual([result.expected]);
});

test("disabled scoped discovery stays read-only and the retired runtime captures its first later enabled call", async () => {
  const result = await nodeScenario(`
    const absent = await lstat(root).then(()=>false,error=>error.code==='ENOENT');
    await sleep(250);
    const idle = runtime.health();
    const enabled = await store.control('enable',{scope:'tc-apps'});
    const admitted = await runtime.binding();
    if (!admitted) throw new Error('Retired probe poisoned the runtime');
    const accepted = runtime.emit({type:'operation.step',ordinal:7},makeDiagnosticContext(admitted,'cli'));
    await settle();
    console.log(JSON.stringify({initial:binding===undefined,absent,idle,accepted,partition:admitted.partition_id,expected:enabled.partition_id,events:(await store.snapshot({all:true})).events.map(event=>event.ordinal)}));
  `, false);
  expect(result.initial).toBe(true);
  expect(result.absent).toBe(true);
  expect(result.idle).toMatchObject({ ready: false, accepted: 0, pending: 0 });
  expect(result.idle.failure).toBeUndefined();
  expect(result.accepted).toBe(true);
  expect(result.partition).toBe(result.expected);
  expect(result.events).toEqual([7]);
});

test("hosted producer discovery never creates tenant maps and honors explicit operator enablement", async () => {
  const result = await nodeScenario(`
    await runtime.close();
    const hosted = createDiagnosticRuntime({root,source:'mcp_http',hosted:true,separateFrom:join(process.env.HOME,'state')});
    try {
      const missing = await hosted.bindingForTenant('a'.repeat(64));
      const absent = await lstat(root).then(()=>false,error=>error.code==='ENOENT');
      const partition = await resolveDiagnosticTenant(root,'a'.repeat(64),{create:true});
      const tenant = new DiagnosticStore(root,partition);
      await tenant.control('enable',{scope:'tc-apps'});
      const admitted = await hosted.bindingForTenant('a'.repeat(64));
      if (!admitted) throw new Error('Enabled tenant was not discovered');
      const accepted = hosted.emit({type:'operation.step',ordinal:9},makeDiagnosticContext(admitted,'mcp_http'));
      const deadline=performance.now()+3000;
      while(hosted.health().pending&&performance.now()<deadline) await sleep(5);
      await tenant.control('disable');
      const disabled=await hosted.bindingForTenant('a'.repeat(64));
      const stale=hosted.emit({type:'operation.step',ordinal:10},makeDiagnosticContext(admitted,'mcp_http'));
      console.log(JSON.stringify({missing:missing===undefined,absent,accepted,partition:admitted.partition_id,expected:partition,disabled:disabled===undefined,stale,events:(await tenant.snapshot({all:true})).events.map(event=>event.ordinal)}));
    } finally { await hosted.close(); }
  `, false);
  expect(result.missing).toBe(true);
  expect(result.absent).toBe(true);
  expect(result.accepted).toBe(true);
  expect(result.partition).toBe(result.expected);
  expect(result.disabled).toBe(true);
  expect(result.stale).toBe(false);
  expect(result.events).toEqual([9]);
});

test.each(["TC_HOME", "TC_APPS_STATE"] as const)("packaged worker rejects protected roots through %s aliases", async (variable) => {
  const result = await nodeScenario(`
    await runtime.close();
    const target=join(process.env.HOME,'physical'),alias=join(process.env.HOME,'alias');
    await mkdir(target,{mode:0o700});await symlink(target,alias);
    process.env.${variable}=${variable === "TC_HOME" ? "alias" : "join(alias,'missing','apps')"};
    const protectedPath=${variable === "TC_HOME" ? "join(target,'.tinycloud')" : "join(target,'missing','apps')"};
    const results=[];
    for(const selected of [target,protectedPath,join(protectedPath,'diagnostics')]) {
      const candidate=createDiagnosticRuntime({root:selected,source:'cli'});
      try {
        const admitted=await candidate.binding();
        results.push({admitted:admitted!==undefined,failure:candidate.health().failure,files:await readdir(target)});
      } finally {await candidate.close();}
    }
    console.log(JSON.stringify(results));
  `, false);
  expect(result).toEqual([
    { admitted: false, failure: "unsafe_path", files: [] },
    { admitted: false, failure: "unsafe_path", files: [] },
    { admitted: false, failure: "unsafe_path", files: [] },
  ]);
});

test("packaged worker keeps disjoint protected aliases usable for actual capture", async () => {
  const result = await nodeScenario(`
    await runtime.close();
    const target=join(process.env.HOME,'physical'),alias=join(process.env.HOME,'alias');
    await mkdir(target,{mode:0o700});await symlink(target,alias);
    process.env.TC_HOME=alias;process.env.TC_APPS_STATE=join(alias,'missing','apps');
    const policy=await store.control('enable',{scope:'tc-apps'});
    const candidate=createDiagnosticRuntime({root,source:'cli'});
    try {
      const admitted=await candidate.binding();
      if(!admitted)throw new Error('Disjoint protected aliases blocked capture');
      const accepted=candidate.emit({type:'operation.step',ordinal:17},makeDiagnosticContext(admitted,'cli'));
      const deadline=performance.now()+3000;
      while(candidate.health().pending&&performance.now()<deadline)await sleep(5);
      console.log(JSON.stringify({accepted,health:candidate.health(),events:(await store.snapshot({all:true})).events.map(event=>event.ordinal),protectedFiles:await readdir(target)}));
    } finally {await candidate.close();}
  `, false);
  expect(result.accepted).toBe(true);
  expect(result.health).toMatchObject({ acknowledged: 1, dropped: 0, pending: 0 });
  expect(result.events).toEqual([17]);
  expect(result.protectedFiles).toEqual([]);
});

test("packaged worker rejects default app-state roots without a state override", async () => {
  const result = await nodeScenario(`
    await runtime.close();
    const selected=join(process.env.HOME,'.local','state','tc-apps','diagnostics');
    const candidate=createDiagnosticRuntime({root:selected,source:'cli'});
    try {
      const admitted=await candidate.binding();
      console.log(JSON.stringify({admitted:admitted!==undefined,absent:await lstat(join(process.env.HOME,'.local')).then(()=>false,error=>error.code==='ENOENT')}));
    } finally {await candidate.close();}
  `, false);
  expect(result).toEqual({ admitted: false, absent: true });
});

test("later tenant and invocation traffic persists only the original tenant's loss attribution", async () => {
  const result = await nodeScenario(`
    await runtime.close();
    const hosted=createDiagnosticRuntime({root,source:'mcp_http',hosted:true});
    const partitionA=await resolveDiagnosticTenant(root,'a'.repeat(64),{create:true});
    const partitionB=await resolveDiagnosticTenant(root,'b'.repeat(64),{create:true});
    const tenantA=new DiagnosticStore(root,partitionA),tenantB=new DiagnosticStore(root,partitionB);
    await tenantA.control('enable',{scope:'tc-apps'});await tenantB.control('enable',{scope:'tc-apps'});
    const bindingA=await hosted.bindingForTenant('a'.repeat(64)),bindingB=await hosted.bindingForTenant('b'.repeat(64));
    if(!bindingA||!bindingB) throw new Error('Synthetic tenant discovery failed');
    const contextA=makeDiagnosticContext(bindingA,'mcp_http'),contextB=makeDiagnosticContext(bindingB,'mcp_http');
    const wait=async()=>{const until=performance.now()+3000;while(hosted.health().pending&&performance.now()<until)await sleep(5);if(hosted.health().pending)throw new Error('Unsettled tenant writes');};
    try {
      const lock=join(root,'.writer-lock');await mkdir(lock,{mode:0o700});
      for(let ordinal=0;ordinal<80;ordinal++) hosted.emit({type:'operation.step',ordinal},contextA);
      await wait();await rm(lock,{recursive:true});
      hosted.emit({type:'invocation.finish',business:'complete'},contextB);await wait();
      const a=await tenantA.snapshot({all:true}),b=await tenantB.snapshot({all:true});
      console.log(JSON.stringify({a:a.events,b:b.events,invocationA:contextA.invocation_id,invocationB:contextB.invocation_id,
        partitionA,partitionB,gapsA:reviewDiagnosticSnapshot(a).coverage.gaps,gapsB:reviewDiagnosticSnapshot(b).coverage.gaps,health:hosted.health()}));
    } finally {await hosted.close();}
  `, false);
  expect(result.health).toMatchObject({ acknowledged: 1, dropped: 80, pending: 0 });
  expect(result.a.reduce((sum: number, event: { dropped: number }) => sum + event.dropped, 0)).toBe(80);
  for (const event of result.a) {
    expect(event.type).toBe("capture.health");
    expect(event.invocation_id).toBe(result.invocationA);
    expect(event.partition_id).toBe(result.partitionA);
  }
  expect(result.b).toHaveLength(1);
  expect(result.b[0]).toMatchObject({ type: "invocation.finish", invocation_id: result.invocationB, partition_id: result.partitionB });
  expect(result.gapsA).toContain("dropped_events");
  expect(result.gapsB).not.toContain("dropped_events");
});

test("delete generation rejects old recovery and failed health does not recursively become new loss", async () => {
  const result = await nodeScenario(`
    const lock=join(root,'.writer-lock');await mkdir(lock,{mode:0o700});
    for(let ordinal=0;ordinal<80;ordinal++) runtime.emit({type:'operation.step',ordinal},context);
    await settle();await rm(lock,{recursive:true});
    const before=runtime.health();
    const deleted=await store.delete({all:true},{pause_after:false});
    const current=await runtime.binding();
    if(!current||current.generation===binding.generation)throw new Error('Delete did not advance generation');
    const later=makeDiagnosticContext(current,'cli');
    for(let ordinal=0;ordinal<12;ordinal++){
      runtime.emit({type:'operation.step',ordinal},later);await settle();
    }
    const snapshot=await store.snapshot({all:true});
    console.log(JSON.stringify({before,after:runtime.health(),deleted,old:context.invocation_id,current:later.invocation_id,
      events:snapshot.events,gaps:reviewDiagnosticSnapshot(snapshot).coverage.gaps}));
  `);
  expect(result.before).toMatchObject({ acknowledged: 0, dropped: 80, pending: 0 });
  expect(result.after).toMatchObject({ acknowledged: 12, dropped: 80, pending: 0 });
  expect(result.events.map((event: { ordinal: number }) => event.ordinal)).toEqual(Array.from({ length: 12 }, (_, index) => index));
  for (const event of result.events) expect(event.invocation_id).toBe(result.current);
  expect(result.gaps).not.toContain("dropped_events");
});

test("many failed recovery attributions remain bounded and never inflate loss counters", async () => {
  const result = await nodeScenario(`
    const lock=join(root,'.writer-lock');await mkdir(lock,{mode:0o700});
    for(let ordinal=0;ordinal<512;ordinal++)runtime.emit({type:'operation.step',ordinal},makeDiagnosticContext(binding,'cli'));
    await settle();await rm(lock,{recursive:true});
    const before=runtime.health();
    await store.control('pause');await store.control('resume');
    const current=await runtime.binding();
    if(!current)throw new Error('Synthetic resumed policy missing');
    const later=makeDiagnosticContext(current,'cli');
    for(let ordinal=0;ordinal<12;ordinal++){runtime.emit({type:'operation.step',ordinal},later);await settle();}
    const afterFailedHealth=runtime.health();
    runtime.emit({type:'invocation.finish',business:'complete'},later);await settle();
    const snapshot=await store.snapshot({all:true});
    console.log(JSON.stringify({before,afterFailedHealth,final:runtime.health(),events:snapshot.events.map(event=>event.type)}));
  `);
  expect(result.before).toMatchObject({ acknowledged: 0, dropped: 512, pending: 0 });
  expect(result.afterFailedHealth).toMatchObject({ acknowledged: 12, dropped: 512, pending: 0 });
  expect(result.final).toMatchObject({ acknowledged: 13, dropped: 512, pending: 0 });
  expect(result.events).toEqual([...Array.from({ length: 12 }, () => "operation.step"), "invocation.finish"]);
}, 10000);

test("recovery overflow reports only retained attribution buckets instead of inventing an aggregate owner", async () => {
  const result = await nodeScenario(`
    const lock=join(root,'.writer-lock');await mkdir(lock,{mode:0o700});
    const lostInvocations=[];
    for(let ordinal=0;ordinal<512;ordinal++){
      const lost=makeDiagnosticContext(binding,'cli');lostInvocations.push(lost.invocation_id);
      runtime.emit({type:'operation.step',ordinal},lost);
    }
    await settle();await rm(lock,{recursive:true});
    const later=makeDiagnosticContext(binding,'cli');
    for(let ordinal=0;ordinal<72;ordinal++){runtime.emit({type:'operation.step',ordinal},later);await settle();}
    const snapshot=await store.snapshot({all:true});
    console.log(JSON.stringify({health:runtime.health(),reports:snapshot.events.filter(event=>event.type==='capture.health'),
      lostInvocations,later:later.invocation_id,business:snapshot.events.filter(event=>event.type!=='capture.health').map(event=>event.ordinal)}));
  `);
  expect(result.health).toMatchObject({ acknowledged: 72, dropped: 512, pending: 0 });
  expect(result.business).toEqual(Array.from({ length: 72 }, (_, index) => index));
  expect(result.reports.length).toBeLessThanOrEqual(128);
  for (const event of result.reports) {
    expect(event.dropped).toBe(1);
    expect(result.lostInvocations).toContain(event.invocation_id);
    expect(event.invocation_id).not.toBe(result.later);
  }
  expect(result.reports.some((event: { failure: string }) => event.failure === "queue_full")).toBe(true);
  expect(result.reports.some((event: { failure: string }) => event.failure === "lock_contention")).toBe(true);
}, 10000);
