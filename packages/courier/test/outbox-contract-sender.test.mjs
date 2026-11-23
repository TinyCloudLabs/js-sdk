import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { startOutbox } from '../dist/outbox.js';
import { canonicalJson, requestHash } from '../dist/canonical.js';

const GROUP = 'courier-test';
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

for(const kind of ['overflow-ulid']) {
 test('raw request rejects '+kind,async()=>{
  const env=makeEnv();const {itemId}=writeItem(env);const line=requestFor('Z'+itemId.slice(1));
  await withSender(env,async()=>assert.equal(await request(env.pipe,line),'refused:bad-request\n'));
  assert.equal(env.calls.length,0);
 });
}
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
