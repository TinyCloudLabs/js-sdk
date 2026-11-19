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



const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('canonical bytes reject an initial UTF-8 BOM',async()=>{
 const e=makeEnv(),a=writeItem(e);fs.writeFileSync(a.file,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),fs.readFileSync(a.file)]));
 await withSender(e,async()=>assert.equal(await request(e.pipe,requestFor(a.itemId)),'refused:bad-item\n'));assert.equal(e.calls.length,0);
});
test('key reordering and missing LF are rejected',async()=>{
 for(const kind of ['order','no-lf']){const e=makeEnv(),a=writeItem(e);const item=JSON.parse(fs.readFileSync(a.file,'utf8'));fs.writeFileSync(a.file,kind==='order'?JSON.stringify(Object.fromEntries(Object.entries(item).reverse()))+'\n':canonicalJson(item));await withSender(e,async()=>assert.equal(await request(e.pipe,requestFor(a.itemId)),'refused:bad-item\n'));assert.equal(e.calls.length,0)}
});
test('extra frame in another data chunk before dispatch is refused',async()=>{
 const e=makeEnv(),a=writeItem(e);let injected=false;const emit=net.Socket.prototype.emit;
 mock.method(net.Socket.prototype,'emit',function(event,...args){if(!injected&&event==='data'&&args[0].toString()===requestFor(a.itemId)+'\n'){injected=true;const first=emit.call(this,event,...args);emit.call(this,'data',Buffer.from('{}\n'));return first}return emit.call(this,event,...args)});
 try{await withSender(e,async()=>assert.equal(await request(e.pipe,requestFor(a.itemId)),'refused:bad-request\n'))}finally{mock.restoreAll()}assert.ok(injected);assert.equal(e.calls.length,0);
});
test('invalid grammar is refused before JSON.parse or outbox lookup',async()=>{
 const e=makeEnv();let parse=0,lookups=0;const jp=JSON.parse,rd=fs.readdirSync;
 await withSender(e,async()=>{mock.method(JSON,'parse',(...a)=>{parse++;return jp(...a)});mock.method(fs,'readdirSync',(p,...a)=>{if(p===e.outboxRoot)lookups++;return rd(p,...a)});try{assert.equal(await request(e.pipe,'{}'),'refused:bad-request\n')}finally{mock.restoreAll()}});assert.equal(parse,0);assert.equal(lookups,0);
});
test('raw short error codes and diagnostic floods never leak or bypass budget',async()=>{
 const e=makeEnv(),a=writeItem(e);await withSender(e,async()=>{for(let i=0;i<25;i++)assert.equal(await request(e.pipe,requestFor(a.itemId)),'refused:internal\n')},{loadProfile:()=>{throw Object.assign(new Error('private message'),{code:'PRIVATE_ITEM_TEXT_SENTINEL'})}});
 assert.ok(!JSON.stringify(e.logs).includes('PRIVATE_ITEM_TEXT_SENTINEL'),'raw error code leaked');assert.ok(e.logs.filter(x=>x.event==='outbox.internal').length<=10);
});
test('fixed-clock requests stop filesystem lookup after sixty requests',async()=>{
 const e=makeEnv();let lookups=0;const rd=fs.readdirSync;
 await withSender(e,async()=>{mock.method(fs,'readdirSync',(p,...a)=>{if(p===e.outboxRoot)lookups++;return rd(p,...a)});try{for(let i=0;i<101;i++){const reply=await request(e.pipe,requestFor(ulid()));assert.match(reply,/^refused:[a-z0-9-]{1,32}\n$/)}}finally{mock.restoreAll()}});assert.ok(lookups<=60,`performed ${lookups} expensive lookups in one request window`);
});
test('reject an oversized chunk before copying it into accumulated request',async()=>{
 const e=makeEnv();let max=0;const concat=Buffer.concat;
 await withSender(e,async()=>{mock.method(Buffer,'concat',(chunks,...a)=>{if(chunks.length===2&&chunks[0].length<=64&&chunks[1].length===4096)max=Math.max(max,chunks[0].length+chunks[1].length);return concat(chunks,...a)});try{assert.equal(await request(e.pipe,'x'.repeat(4095)),'refused:bad-request\n')}finally{mock.restoreAll()}});assert.ok(max<=64,`copied ${max} bytes before limit decision`);
});
test('five-second idle timeout returns a fixed refusal line',async()=>{
 const e=makeEnv();await withSender(e,async()=>{const reply=await new Promise((resolve,reject)=>{const s=net.connect(e.pipe);let b='';s.on('data',x=>b+=x);s.on('close',()=>resolve(b));s.on('error',reject);s.on('connect',()=>s.write('{'))});assert.match(reply,/^refused:[a-z0-9-]{1,32}\n$/)});
});
test('invalid policy on restart cannot raise an established one-per-hour cap',async()=>{
 const e=makeEnv({peersJson:{alpha:{outPerHour:1}}}),a=writeItem(e),b=writeItem(e);await withSender(e,async()=>assert.equal(await request(e.pipe,requestFor(a.itemId)),'ok\n'));fs.writeFileSync(e.peersFile,JSON.stringify({alpha:{outPerHour:101}}));let started;
 try{started=await startOutbox(optionsFor(e))}catch{return}try{assert.match(await request(e.pipe,requestFor(b.itemId)),/^refused:[a-z0-9-]{1,32}\n$/)}finally{await started.close()}assert.equal(e.calls.length,1);
});
test('a newly created sent directory entry is durable before send',async()=>{
 const e=makeEnv(),a=writeItem(e);const parent=path.dirname(e.sentDir);let parentFlushed=false,parentAtSend=false;const sync=fs.fsyncSync;
 mock.method(fs,'fsyncSync',fd=>{const st=fs.fstatSync(fd);if(st.isDirectory()&&st.ino===fs.statSync(parent).ino)parentFlushed=true;return sync(fd)});
 try{await withSender(e,async()=>assert.equal(await request(e.pipe,requestFor(a.itemId)),'ok\n'),{send:async()=>{parentAtSend=parentFlushed;return{messageId:'fixture'}}})}finally{mock.restoreAll()}assert.ok(parentAtSend,'new sent-directory entry parent was never fsynced')
});
test('marker link then its actual parent fsync precede dispatch',async()=>{
 const e=makeEnv(),a=writeItem(e);const link=fs.linkSync,sync=fs.fsyncSync;let marker=false,durable=false;
 mock.method(fs,'linkSync',(from,to)=>{const out=link(from,to);if(to===path.join(e.sentDir,a.itemId)){marker=true;durable=false}return out});mock.method(fs,'fsyncSync',fd=>{const st=fs.fstatSync(fd);if(marker&&st.isDirectory()&&st.ino===fs.statSync(e.sentDir).ino)durable=true;return sync(fd)});
 try{await withSender(e,async()=>assert.equal(await request(e.pipe,requestFor(a.itemId)),'ok\n'),{send:async()=>{assert.ok(marker&&durable);return{messageId:'fixture'}}})}finally{mock.restoreAll()}
});

test('at most 64 of 80 idle sockets are retained',async()=>{
 const e=makeEnv();let seen=0,dropped=0,resolveSeen;const allSeen=new Promise(r=>resolveSeen=r),emit=net.Server.prototype.emit;
 mock.method(net.Server.prototype,'emit',function(event,...args){const relevant=event==='connection'&&this.address()===e.pipe;const out=emit.call(this,event,...args);if(relevant){seen++;if(args[0].destroyed)dropped++;if(seen===80)resolveSeen()}return out});
 try{await withSender(e,async()=>{const sockets=Array.from({length:80},()=>{const s=net.connect(e.pipe);s.on('error',()=>{});return s});let timer;try{await Promise.race([allSeen,new Promise((_,j)=>timer=setTimeout(()=>j(new Error('connection fixture deadline')),2500))]);assert.equal(dropped,16)}finally{clearTimeout(timer);for(const s of sockets)s.destroy()}})}finally{mock.restoreAll()}
});
test('slow dispatch retains only 32 waiting requests',async()=>{
 const e=makeEnv();const ids=Array.from({length:40},()=>writeItem(e).itemId);let release,resolveSeen;const gate=new Promise(r=>release=r),allSeen=new Promise(r=>resolveSeen=r);const seen=new Set(),emit=net.Socket.prototype.emit;
 mock.method(net.Socket.prototype,'emit',function(event,...args){const out=emit.call(this,event,...args);if(event==='data'&&args[0].toString().startsWith('{"v":1,"itemId":"')){seen.add(args[0].toString());if(seen.size===40)resolveSeen()}return out});
 try{await withSender(e,async()=>{const requests=ids.map(id=>request(e.pipe,requestFor(id)));let timer;try{await Promise.race([allSeen,new Promise((_,j)=>timer=setTimeout(()=>j(new Error('pending fixture deadline')),2500))])}finally{clearTimeout(timer);release()}const replies=await Promise.all(requests);assert.equal(replies.filter(x=>x==='refused:busy\n').length,7);assert.equal(replies.filter(x=>x==='ok\n').length,33)},{send:async()=>{await gate;return{messageId:'fixture'}}})}finally{release();mock.restoreAll()}
});
test('an orphan marker receives an uncertain result at startup',async()=>{
 const e=makeEnv(),a=writeItem(e);fs.mkdirSync(e.sentDir,{mode:0o700});fs.writeFileSync(path.join(e.sentDir,a.itemId),JSON.stringify({v:1,peer:'alpha',at:new Date(T0).toISOString()}),{mode:0o600});
 await withSender(e,async()=>{assert.equal(JSON.parse(fs.readFileSync(path.join(e.sentDir,a.itemId+'.result.json'),'utf8')).state,'uncertain');assert.ok(e.logs.some(x=>x.event==='outbox.uncertain'&&x.fields.count===1))});assert.equal(e.calls.length,0);
});

test('unexpected diagnostics obey the ten-event window',async()=>{
 const e=makeEnv(),a=writeItem(e);await withSender(e,async()=>{for(let i=0;i<25;i++)assert.equal(await request(e.pipe,requestFor(a.itemId)),'refused:internal\n')},{loadProfile:()=>{throw Object.assign(new Error('fixture'),{code:'EIO'})}});assert.ok(e.logs.filter(x=>x.event==='outbox.internal').length<=10,`emitted ${e.logs.filter(x=>x.event==='outbox.internal').length} unbudgeted diagnostics`);
});

test('uncertain replay remains uncertain when its marker fills the cap',async()=>{
 const e=makeEnv({peersJson:{alpha:{outPerHour:1}}}),a=writeItem(e);fs.mkdirSync(e.sentDir,{mode:0o700});fs.writeFileSync(path.join(e.sentDir,a.itemId),JSON.stringify({v:1,peer:'alpha',at:new Date(T0).toISOString()}),{mode:0o600});await withSender(e,async()=>{assert.equal(JSON.parse(fs.readFileSync(path.join(e.sentDir,a.itemId+'.result.json'),'utf8')).state,'uncertain');assert.equal(await request(e.pipe,requestFor(a.itemId)),'refused:uncertain\n')});assert.equal(e.calls.length,0);
});
