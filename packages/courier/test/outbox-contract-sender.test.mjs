import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { REFUSAL_CODES, groupGid, startOutbox } from '../dist/outbox.js';
import { canonicalJson, requestHash } from '../dist/canonical.js';
import { CourierError } from '../dist/errors.js';
import * as outboxModule from '../dist/outbox.js';

const GROUP = 'courier-test';
const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-20T12:00:00Z');

function makeEnv({ peers = { alpha: { status: 'paired' } }, peersJson } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc712-outbox-'));
  const sockDir = path.join(base, 'sock');
  fs.mkdirSync(sockDir, { mode: 0o750 });
  fs.chmodSync(sockDir, 0o750);
  const outboxRoot = path.join(base, 'outbox');
  fs.mkdirSync(outboxRoot, { mode: 0o700 });
  const env = {
    base,
    pipe: path.join(sockDir, 'outbox.sock'),
    outboxRoot,
    sentDir: path.join(base, 'sent'),
    peersFile: path.join(base, 'peers.json'),
    profile: { peers },
    calls: [],
    logs: [],
    clock: { t: T0 },
  };
  if (peersJson !== undefined) fs.writeFileSync(env.peersFile, JSON.stringify(peersJson), { mode: 0o600 });
  return env;
}

function optionsFor(env, extra = {}) {
  return {
    outboxRoot: env.outboxRoot,
    sentDir: env.sentDir,
    pipe: env.pipe,
    socketGroup: GROUP,
    peersFile: env.peersFile,
    groups: () => fs.statSync(path.dirname(env.pipe)).gid,
    loadProfile: () => env.profile,
    send: async (_profile, peerHandle, input) => {
      env.calls.push({ peerHandle, input });
      return { messageId: `msg-${env.calls.length}` };
    },
    now: () => env.clock.t,
    log: (event, fields) => env.logs.push({ event, fields }),
    ...extra,
  };
}

async function withSender(env, fn, extra) {
  const handle = await startOutbox(optionsFor(env, extra));
  try {
    return await fn();
  } finally {
    await handle.close();
  }
}

function request(pipe, line) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    let reply = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      reply += chunk;
    });
    sock.on('error', reject);
    sock.on('close', () => resolve(reply));
    sock.end(`${line}\n`);
  });
}

function requestFor(itemId) {
  return JSON.stringify({ v: 1, itemId });
}

function writeItem(env, {
  itemId = ulid(), dir = 'alpha', to = 'alpha', thread = ulid(), subject, text = 'hello', approve = true, ledger = true, mode = 0o600,
} = {}) {
  const body = subject === undefined
    ? { v: 1, itemId, to, thread, text }
    : { v: 1, itemId, to, thread: null, subject, text };
  const item = { ...body, approvedSha256: approve ? requestHash(body) : '0'.repeat(64) };
  const peerDir = path.join(env.outboxRoot, dir);
  fs.mkdirSync(peerDir, { recursive: true });
  const file = path.join(peerDir, `${itemId}.json`);
  fs.writeFileSync(file, `${canonicalJson(item)}\n`);
  fs.chmodSync(file, mode);
  if(ledger){const approved=path.join(env.outboxRoot,'approved');fs.mkdirSync(approved,{recursive:true,mode:0o700});const entry=path.join(approved,itemId);if(!fs.existsSync(entry))fs.writeFileSync(entry,item.approvedSha256+'\n',{mode:0o600,flag:'wx'})}
  return { itemId, file, thread };
}

function seedMarker(env, peer, at) {
  fs.mkdirSync(env.sentDir, { recursive: true });
  fs.writeFileSync(path.join(env.sentDir, ulid()), JSON.stringify({ v: 1, peer, at: new Date(at).toISOString() }));
}

/** Single-use markers only; excludes serve.lock and result files, which contain a dot. */
function markers(env) {
  if (!fs.existsSync(env.sentDir)) return [];
  return fs.readdirSync(env.sentDir).filter((name) => !name.includes('.'));
}


for(const kind of ['reordered','duplicate-key','numeric-v','65-bytes','two-lines','overflow-ulid','newline-id']) {
 test('raw request rejects '+kind,async()=>{
  const env=makeEnv();const {itemId}=writeItem(env);let line;
  if(kind==='reordered')line=JSON.stringify({itemId,v:1});
  if(kind==='duplicate-key')line=`{"v":1,"itemId":"X","itemId":"${itemId}"}`;
  if(kind==='numeric-v')line=`{"v":1.0,"itemId":"${itemId}"}`;
  if(kind==='65-bytes')line=requestFor(itemId)+' '.repeat(65-requestFor(itemId).length);
  if(kind==='two-lines')line=requestFor(itemId)+'\n{}';
  if(kind==='overflow-ulid')line=requestFor('Z'+itemId.slice(1));
  if(kind==='newline-id')line=requestFor(itemId+'\n');
  await withSender(env,async()=>assert.equal(await request(env.pipe,line),'refused:bad-request\n'));
  assert.equal(env.calls.length,0);
 });
}
test('item without protected approval ledger never sends',async()=>{
 const env=makeEnv();const {itemId}=writeItem(env,{ledger:false});
 await withSender(env,async()=>assert.match(await request(env.pipe,requestFor(itemId)),/^refused:/));
 assert.equal(env.calls.length,0);
});
test('recomputed embedded digest cannot replace protected approval',async()=>{
 const env=makeEnv();const {itemId,file}=writeItem(env);
 fs.mkdirSync(path.join(env.outboxRoot,'approved'),{recursive:true,mode:0o700});
 const item=JSON.parse(fs.readFileSync(file,'utf8'));
 fs.writeFileSync(path.join(env.outboxRoot,'approved',itemId),item.approvedSha256,{mode:0o600});
 item.text='changed fixture';const {approvedSha256,...payload}=item;item.approvedSha256=requestHash(payload);
 fs.writeFileSync(file,canonicalJson(item)+'\n');
 await withSender(env,async()=>assert.equal(await request(env.pipe,requestFor(itemId)),'refused:hash-mismatch\n'));
 assert.equal(env.calls.length,0);
});
for(const kind of ['whitespace','duplicate-text']) {
 test('canonical item bytes required: '+kind,async()=>{
  const env=makeEnv();const {itemId,file}=writeItem(env);
  let raw=fs.readFileSync(file,'utf8');
  raw=kind==='whitespace'?' '+raw:raw.replace('"text":"hello"','"text":"discarded","text":"hello"');
  fs.writeFileSync(file,raw);
  await withSender(env,async()=>assert.equal(await request(env.pipe,requestFor(itemId)),'refused:bad-item\n'));
  assert.equal(env.calls.length,0);
 });
}
test('one opened snapshot is used after a path replacement',async()=>{
 const env=makeEnv();const {itemId,file}=writeItem(env,{text:'original fixture'});
 await withSender(env,async()=>{
  const originalRead=fs.readSync;let swapped=false;
  mock.method(fs,'readSync',(fd,...args)=>{
   const n=originalRead(fd,...args);
   if(!swapped){swapped=true;fs.renameSync(file,file+'.old');writeItem(env,{itemId,text:'replacement fixture'});}
   return n;
  });
  try{assert.equal(await request(env.pipe,requestFor(itemId)),'ok\n')}finally{mock.restoreAll()}
 });
 assert.equal(env.calls[0].input.text,'original fixture');
});
test('persistent reservation directory is fsynced before send',async()=>{
 const env=makeEnv();const {itemId}=writeItem(env);let dirSynced=false;
 const orig=fs.fsyncSync;
 mock.method(fs,'fsyncSync',(fd)=>{if(fs.fstatSync(fd).isDirectory())dirSynced=true;return orig(fd)});
 try{await withSender(env,async()=>assert.equal(await request(env.pipe,requestFor(itemId)),'ok\n'),{send:async()=>{assert.ok(dirSynced,'no directory fsync before dispatch');return {messageId:'fixture'}}});}finally{mock.restoreAll()}
});
test('persistent rate survives restart and backward clock',async()=>{
 const env=makeEnv({peersJson:{alpha:{outPerHour:1}}});const a=writeItem(env);const b=writeItem(env);
 await withSender(env,async()=>assert.equal(await request(env.pipe,requestFor(a.itemId)),'ok\n'));
 env.clock.t-=2*HOUR_MS;
 await withSender(env,async()=>assert.equal(await request(env.pipe,requestFor(b.itemId)),'refused:rate-limited\n'));
 assert.equal(env.calls.length,1);
});
test('slow concurrent requests serialize sends and reserve once',async()=>{
 const env=makeEnv();const a=writeItem(env);let active=0,max=0;
 await withSender(env,async()=>{
  const replies=await Promise.all(Array.from({length:10},()=>new Promise((resolve,reject)=>{
   const s=net.connect(env.pipe);let answer='';s.on('error',reject);s.on('data',b=>answer+=b);s.on('end',()=>{s.end();resolve(answer)});s.write(requestFor(a.itemId)+'\n');
  })));
  assert.equal(replies.filter(x=>x==='ok\n').length,1);assert.equal(replies.filter(x=>x==='refused:already-used\n').length,9);
 },{send:async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,20));active--;return {messageId:'fixture'}}});
 assert.equal(max,1);
});
test('socket chmod precedes first accept',async()=>{
 const env=makeEnv();const a=writeItem(env);const observations=[];
 const orig=net.Server.prototype.emit;
 mock.method(net.Server.prototype,'emit',function(event,...args){if(event==='connection')observations.push(fs.statSync(env.pipe).mode&0o777);return orig.call(this,event,...args)});
 try{await withSender(env,async()=>assert.equal(await request(env.pipe,requestFor(a.itemId)),'ok\n'))}finally{mock.restoreAll()}
 assert.deepEqual(observations,[0o660]);
});
test('killed sender never resends and surfaces uncertain result',async()=>{
 const {fork}=await import('node:child_process');const {once}=await import('node:events');
 const env=makeEnv();const {itemId}=writeItem(env);let sock;
 const child=fork(new URL('./outbox-crash-child.mjs',import.meta.url),[],{env:{...process.env,OUTBOX_CRASH_CFG:JSON.stringify({outboxRoot:env.outboxRoot,sentDir:env.sentDir,pipe:env.pipe,peersFile:env.peersFile})},stdio:['ignore','ignore','pipe','ipc']});
 const messages=[];let notify=()=>{};child.on('message',m=>{messages.push(m);notify()});
 const wait=async(m)=>{while(!messages.includes(m))await new Promise((r,j)=>{const timer=setTimeout(()=>j(new Error('IPC timeout')),5000);notify=()=>{clearTimeout(timer);r()}})};
 try {
  await wait('ready');sock=net.connect(env.pipe);sock.on('error',()=>{});sock.write(requestFor(itemId)+'\n');
  await wait('accepted');const exited=once(child,'exit');child.kill('SIGKILL');await exited;sock.destroy();
  assert.equal(fs.readFileSync(path.join(path.dirname(env.pipe),'accepted'),'utf8'),'1');
  let replay;await withSender(env,async()=>{replay=await request(env.pipe,requestFor(itemId))});
  assert.equal(env.calls.length,0);
  const resultFile=path.join(env.sentDir,itemId+'.result.json');
  assert.ok(fs.existsSync(resultFile),'crash reservation never becomes an uncertain result');
  assert.equal(JSON.parse(fs.readFileSync(resultFile,'utf8')).state,'uncertain');assert.equal(replay,'refused:uncertain\n');
 } finally {sock?.destroy();if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit')}}
});
test('sender logs contain no peer ids even with invalid policy',async()=>{
 const env=makeEnv({peersJson:{alpha:{outPerHour:101}}});const a=writeItem(env);
 await withSender(env,async()=>assert.equal(await request(env.pipe,requestFor(a.itemId)),'ok\n'));
 assert.ok(!JSON.stringify(env.logs).includes('alpha'));
});
test('item owned by another uid is refused',async()=>{
 const env=makeEnv();const a=writeItem(env);const ino=fs.statSync(a.file).ino;const original=fs.fstatSync;
 await withSender(env,async()=>{
  mock.method(fs,'fstatSync',(fd,...args)=>{const st=original(fd,...args);if(st.ino===ino)st.uid+=1;return st});
  try{assert.equal(await request(env.pipe,requestFor(a.itemId)),'refused:unsafe-item\n')}finally{mock.restoreAll()}
 });assert.equal(env.calls.length,0);
});

test('request without newline is an accepted complete frame at EOF',async()=>{
 const env=makeEnv();const a=writeItem(env);
 await withSender(env,async()=>{
  const reply=await new Promise((resolve,reject)=>{const s=net.connect(env.pipe);let b='';s.on('data',x=>b+=x);s.on('error',reject);s.on('close',()=>resolve(b));s.end(requestFor(a.itemId))});
  assert.equal(reply,'ok\n');
 });assert.equal(env.calls.length,1);
});
test('all configured denied socket group names are refused',async()=>{
 const env=makeEnv();for(const socketGroup of ['tinycloud','tinycloud-dev','sudo','docker'])await assert.rejects(startOutbox(optionsFor(env,{socketGroup})),{code:'unsafe-socket-group'});
});
test('invalid-request logging has a finite per-minute budget',async()=>{
 const env=makeEnv();await withSender(env,async()=>{for(let i=0;i<101;i++)assert.equal(await request(env.pipe,'{}'),'refused:bad-request\n')});
 assert.ok(env.logs.filter(x=>x.event==='outbox.refused').length<=60);
});
