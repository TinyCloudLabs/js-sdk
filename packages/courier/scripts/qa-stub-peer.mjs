#!/usr/bin/env node
// QA only. The CLI, not this script, owns Courier's protocol and receipts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { scrubEnvironment, installSafety } from './qa-stub-safety.mjs';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const GUARD = fileURLToPath(new URL('./qa-stub-safety.mjs', import.meta.url));
const ROOT = /^\/var\/tmp\/tc2001stub\.[A-Za-z0-9]{6}$/;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const PROCESS_NONCE = randomUUID();
const write = (file, value) => {
  const temporary = `${file}.new.${process.pid}.${PROCESS_NONCE}.${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
};

export function processStartTime(pid) {
  // comm may itself contain spaces or parentheses; fields after the final ')' start at field 3.
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

export function assertRunning(owner) {
  if (!Number.isInteger(owner.pid) || !owner.startTime) throw new Error('stub is stopped or has a stale process identity');
  try {
    process.kill(owner.pid, 0);
    if (processStartTime(owner.pid) !== owner.startTime) throw new Error('reused pid');
  } catch { throw new Error('stub has a stale process identity'); }
}

export function holderIsDead(holder) {
  if (!Number.isSafeInteger(holder?.pid) || holder.pid <= 0 || typeof holder.startTime !== 'string' || !/^\d+$/.test(holder.startTime) ||
      typeof holder.nonce !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(holder.nonce ?? '')) {
    throw new Error('state lifecycle lock recovery refused: garbled holder identity');
  }
  try {
    const actual = processStartTime(holder.pid);
    if (!/^\d+$/.test(actual ?? '')) throw new Error('unreadable process start time');
    return actual !== holder.startTime;
  } catch (error) {
    if (error.code === 'ENOENT') {
      try { process.kill(holder.pid, 0); }
      catch (probe) { if (probe.code === 'ESRCH') return true; }
    }
    throw new Error('state lifecycle lock recovery refused: cannot prove holder dead');
  }
}

function recoveryRecord(file) {
  try { return json(file); }
  catch { throw new Error('state lifecycle lock recovery refused: unreadable or garbled record'); }
}

function assertDeadMarker(stateDir, holder) {
  const dead = holderIsDead(holder);
  const owner = recoveryRecord(path.join(stateDir, 'qa-stub.json'));
  assertMarker(owner, stateDir);
  if (owner.pid !== holder.pid || owner.startTime !== holder.startTime || owner.nonce !== holder.nonce) {
    throw new Error('state lifecycle lock recovery refused: marker does not match holder');
  }
  if (!dead) throw new Error('state lifecycle lock recovery refused: holder is live');
}

function recoverDeadState(stateDir) {
  assertState(stateDir, process.env.COURIER_HOME);
  // Serialize recovery snapshots/renames: two purges must never move each other's new live claim.
  const gate = path.join(stateDir, 'purge-recovery.lock');
  const nonce = randomUUID();
  let gateFd;
  try { gateFd = fs.openSync(gate, 'wx', 0o600); }
  catch { throw new Error('state lifecycle lock recovery refused: another purge is active'); }
  fs.writeFileSync(gateFd, JSON.stringify({ nonce }));
  fs.closeSync(gateFd);
  const file = path.join(stateDir, 'lifecycle.lock');
  const archived = path.join(stateDir, `.stale-${nonce}`);
  let claim;
  try {
    const holder = recoveryRecord(file);
    assertDeadMarker(stateDir, holder);
    fs.renameSync(file, archived);
    const moved = recoveryRecord(archived);
    if (moved.pid !== holder.pid || moved.startTime !== holder.startTime || moved.nonce !== holder.nonce) {
      throw new Error('state lifecycle lock recovery refused: holder changed during takeover');
    }
    claim = claimLifecycle(stateDir);
    claim.assertHeld();
    assertState(stateDir, process.env.COURIER_HOME);
    assertDeadMarker(stateDir, holder); // re-verify marker and death under our fresh wx claim
    return Object.assign(claim, { recovered: true, deadHolder: holder });
  } catch (error) {
    claim?.release();
    // Restore without overwriting a competing claim if takeover failed after rename.
    if (fs.existsSync(archived)) {
      try { fs.linkSync(archived, file); }
      catch (restore) { if (restore.code !== 'EEXIST') throw restore; }
    }
    throw error;
  } finally {
    if (recoveryRecord(gate).nonce === nonce) fs.unlinkSync(gate);
  }
}

export function claimLifecycle(stateDir, allowRecovery = false) {
  const file = path.join(stateDir, 'lifecycle.lock');
  const identity = { pid: process.pid, startTime: processStartTime(process.pid), nonce: randomUUID() };
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') {
      if (allowRecovery) return recoverDeadState(stateDir);
      throw new Error(`state lifecycle lock is held; concurrent start/purge refused; after a crash run purge --state ${stateDir}`);
    }
    throw error;
  }
  fs.writeFileSync(fd, JSON.stringify(identity));
  fs.closeSync(fd);
  return { ...identity, assertHeld() {
    if (json(file).nonce !== identity.nonce) throw new Error('state lifecycle lock ownership changed');
  }, release() {
    try {
      if (json(file).nonce === identity.nonce) fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } };
}

export function assertInitializable(allocated, markerPresent) {
  if (!allocated && !markerPresent) throw new Error('explicit --state requires a stopped stub ownership marker');
}

export const messageKey = item => JSON.stringify([item.peer, item.threadId, item.messageId]);
export function safeText(value, max = 500) {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x1f\x7f]|[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(value) || /Bearer |-----BEGIN|(?:api[_-]?key|token|secret)\s*[:=]/i.test(value)) throw new Error('text refused: length, hidden characters, or credential pattern');
  return value;
}

export function assertState(state, courierHome) {
  if (!ROOT.test(state) || fs.realpathSync(state) !== state || fs.statSync(state).uid !== process.getuid() || (fs.statSync(state).mode & 0o077)) {
    throw new Error('state must be an owner-only real mktemp /var/tmp/tc2001stub.XXXXXX directory');
  }
  if (courierHome && path.resolve(courierHome) !== path.join(state, 'courier')) throw new Error('COURIER_HOME escapes state');
  const inspect = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('state contains a symlink');
      const file = path.join(dir, entry.name);
      let stat;
      try { stat = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('state has non-private files');
      if (entry.isDirectory()) inspect(file);
    }
  };
  inspect(state);
}

export function assertMarker(owner, stateDir, stopped = false) {
  if (owner.type !== 'qa-courier-stub-v1' || owner.state !== stateDir) throw new Error('invalid stub ownership marker');
  if (stopped && owner.pid !== null) throw new Error('state is already running; stop --keep-state first');
}

export function parseCue(args) {
  const [action, thread] = args;
  if (!['block', 'unblock', 'pause', 'resume', 'revoke', 'send-thread', 'ask', 'wait-answer'].includes(action)) throw new Error('unknown cue');
  if (['pause', 'resume', 'wait-answer'].includes(action) && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(thread ?? '')) throw new Error('cue requires a ULID');
  if (args.length !== (['pause', 'resume', 'wait-answer'].includes(action) ? 2 : 1)) throw new Error('unexpected cue argument');
  return { action, thread };
}

export function parseAnswer(text) {
  let answer;
  try { answer = JSON.parse(text); } catch {
    const match = /^(approve|deny) ([0-9A-HJKMNP-TV-Z]{26})(?:\s|$)/.exec(text);
    if (match) answer = { type: 'qa-stub-answer', answer: match[1], askId: match[2] };
  }
  if (answer?.type === 'qa-stub-answer' && ['approve', 'deny'].includes(answer.answer) && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(answer.askId)) return answer;
}

export function initialState() {
  return { paired: false, threads: [], repliesSent: 0, blocked: false, pausedThreads: [], seen: [], pending: [], asks: {},
    threadsStarted: 0, repliesReceived: 0, asksSent: 0, answersReceived: 0, resumedActions: 0, unparseable: 0 };
}

export async function cycle(state, courier, replyText, decision) {
  if (state.blocked || !state.paired) return;
  const inbox = await courier(['inbox', '--json']);
  if (inbox.errors?.length) throw new Error('Courier inbox reported a peer error; stub stopped');
  for (const item of inbox.items) {
    if (!state.pending.some(x => messageKey(x) === messageKey(item))) state.pending.push(item);
  }
  for (const item of [...state.pending]) {
    const key = messageKey(item);
    if (state.pausedThreads.includes(item.threadId)) continue;
    if (state.seen.includes(key)) { state.pending = state.pending.filter(x => messageKey(x) !== key); continue; }
    if (!state.threads.includes(item.threadId)) state.threads.push(item.threadId);
    const openAsk = Object.values(state.asks).find(a => a.threadId === item.threadId);
    if (openAsk) {
      const answer = parseAnswer(item.text);
      const history = await courier(['read', item.threadId, '--peer', item.peer, '--json']);
      const entry = history.entries.find(e => e.side === 'peer' && e.id === item.messageId);
      const correlated = entry?.body?.metadata?.['https://tinycloud.xyz/ext/courier/v0']?.inReplyTo === openAsk.messageId;
      if (item.peer !== openAsk.peer || !answer || answer.askId !== openAsk.askId || openAsk.answer || !correlated) state.unparseable++;
      else {
        openAsk.answer = answer.answer;
        state.answersReceived++;
        if (answer.answer === 'approve') state.resumedActions++;
        await courier(['send', item.peer, '--thread', item.threadId, '--intent', 'inform', '--reply-to', item.messageId,
          '--text', answer.answer === 'approve' ? 'QA stub: resumed action (fixed follow-up only).' : 'QA stub: denied.']);
        state.repliesSent++;
      }
    } else {
      state.repliesReceived++;
      const structured = item.asks?.length ? `\n${JSON.stringify({ type: 'qa-stub-answer', answer: decision, messageId: item.messageId })}` : '';
      await courier(['send', item.peer, '--thread', item.threadId, '--intent', 'answer', '--reply-to', item.messageId,
        '--text', `${replyText} ${item.messageId}${structured}`]);
      state.repliesSent++;
    }
    state.seen.push(key);
    state.pending = state.pending.filter(x => messageKey(x) !== key);
  }
}

async function main() {
  const { values: v, positionals: pos } = parseArgs({ allowPositionals: true, options: Object.fromEntries(
    [...['state', 'host', 'name', 'peer', 'reply-text', 'decision', 'file', 'text', 'subject', 'verb', 'target', 'summary', 'timeout'].map(k => [k, { type: 'string' }]), ['keep-state', { type: 'boolean' }]]) });
  const [command, ...args] = pos;
  if (!['start', 'accept', 'cue', 'status', 'stop', 'purge'].includes(command)) throw new Error('usage: qa-stub-peer.mjs start|accept|cue|status|stop');
  if (command === 'start' && !v.host) throw new Error('start requires --host (no default node)');
  if (command === 'start' && !['approve', 'deny'].includes(v.decision ?? 'approve')) throw new Error('--decision must be approve or deny');
  const cue = command === 'cue' ? parseCue(args) : undefined;
  let stateDir = v.state;
  const allocated = v.state === undefined && command === 'start';
  if (allocated) {
    // Lead ruling: in-process allocation keeps the child allow-list Courier-only.
    stateDir = fs.mkdtempSync('/var/tmp/tc2001stub.');
    fs.chmodSync(stateDir, 0o700);
    fs.writeFileSync(path.join(stateDir, 'created-paths'), stateDir + '\n', { mode: 0o600 });
  }
  if (!stateDir) throw new Error('--state is required for an existing stub');
  assertState(stateDir, process.env.COURIER_HOME);
  scrubEnvironment(stateDir); // before any SDK import or runtime write
  assertState(stateDir, process.env.COURIER_HOME);
  const claim = command === 'start' || command === 'purge' ? claimLifecycle(stateDir, command === 'purge') : undefined;
  try {
  const marker = path.join(stateDir, 'qa-stub.json');
  if (command !== 'start') {
    const owner = json(marker);
    assertMarker(owner, stateDir);
    if (command === 'purge') {
      if (claim.recovered) assertDeadMarker(stateDir, claim.deadHolder);
      else assertMarker(owner, stateDir, true);
      claim.assertHeld();
      fs.rmSync(stateDir, { recursive: true });
      console.log(JSON.stringify({ purged: true, path: stateDir, recovered: claim.recovered === true })); return;
    }
    assertRunning(owner);
    if (command === 'status') {
      const { seen, pending, asks, threads, ...summary } = json(path.join(stateDir, 'status.json'));
      console.log(JSON.stringify(summary)); return;
    }
    if (cue?.action === 'wait-answer') {
      const seconds = Number(v.timeout ?? 60);
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) throw new Error('--timeout must be 1..600 seconds');
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        const ask = json(path.join(stateDir, 'status.json')).asks[cue.thread];
        if (!ask) throw new Error('unknown ask id');
        if (ask.answer) { console.log(JSON.stringify({ answer: ask.answer })); return; }
        await sleep(50);
      }
      throw new Error('timeout waiting for answer');
    }
    let input;
    if (command === 'accept') input = JSON.parse(fs.readFileSync(v.file ?? 0, 'utf8'));
    const id = randomUUID();
    const request = path.join(stateDir, 'control', `${id}.json`);
    const response = path.join(stateDir, 'responses', `${id}.json`);
    write(request + '.pending', { command, cue, input, options: v });
    fs.renameSync(request + '.pending', request);
    const deadline = Date.now() + 65_000;
    while (!fs.existsSync(response)) {
      if (Date.now() > deadline) throw new Error('timeout waiting for stub control; check running process');
      assertRunning(owner);
      await sleep(25);
    }
    const result = json(response);
    fs.unlinkSync(response);
    if (result.error) throw new Error(result.error);
    console.log(JSON.stringify(result));
    if (command === 'stop' && v['keep-state']) {
      while ((json(marker).pid !== null || fs.existsSync(path.join(stateDir, 'lifecycle.lock'))) && Date.now() < deadline) await sleep(25);
      if (json(marker).pid !== null || fs.existsSync(path.join(stateDir, 'lifecycle.lock'))) throw new Error('timeout waiting for kept state');
    }
    if (command === 'stop' && !v['keep-state']) {
      while (fs.existsSync(stateDir) && Date.now() < deadline) await sleep(25);
      if (fs.existsSync(stateDir)) throw new Error('timeout waiting for state cleanup');
    }
    return;
  }
  let kept = false;
  assertInitializable(allocated, fs.existsSync(marker));
  if (fs.existsSync(marker)) {
    const prior = json(marker);
    assertMarker(prior, stateDir, true);
    kept = true;
  }
  const host = new URL(v.host).origin;
  if (kept && json(path.join(stateDir, 'courier', 'profile.json')).host !== host) throw new Error('kept state requires the same node host');
  fs.mkdirSync(path.join(stateDir, 'home'), { mode: 0o700, recursive: true });
  fs.mkdirSync(path.join(stateDir, 'control'), { mode: 0o700, recursive: true });
  fs.mkdirSync(path.join(stateDir, 'responses'), { mode: 0o700, recursive: true });
  write(path.join(stateDir, 'created-paths'), [stateDir]);
  installSafety(host, stateDir, CLI);
  console.error(`Target: ${host}\nQA stub: no model, no human, no wake`);
  const { execFile } = await import('node:child_process');
  const courier = (argv, input, raw = false) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--import', GUARD, CLI, ...argv], {
      env: { ...process.env }, timeout: 45_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(new Error(`courier ${argv[0]} failed${error.killed ? ' (45s timeout)' : ''}; stub stopped`));
      try { resolve(raw ? stdout : JSON.parse(stdout)); } catch { reject(new Error('courier returned invalid JSON')); }
    });
    child.stdin.end(input);
  });
  const state = kept ? json(path.join(stateDir, 'status.json')) : initialState();
  let stopping = false;
  let keepState = false;
  const save = () => { state.threadCount = state.threads.length; write(path.join(stateDir, 'status.json'), state); };
  const cleanup = () => { claim.assertHeld(); assertState(stateDir, process.env.COURIER_HOME); if (json(marker).nonce !== claim.nonce) throw new Error('cleanup ownership mismatch'); fs.rmSync(stateDir, { recursive: true }); };
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  write(marker, { type: 'qa-courier-stub-v1', pid: claim.pid, startTime: claim.startTime, nonce: claim.nonce, state: stateDir });
  save();
  try {
    if (!kept) {
      const request = await courier(['init', '--request', '--handle', v.name ?? 'qa-stub', '--host', host]);
      const { createOwner, grantFromRequest, HOST } = await import('./fake-openkey.mjs');
      if (HOST !== host) throw new Error('fake-openkey.mjs needs COURIER_FAKE_OPENKEY_HOST override');
      // SDK setup is bounded too; errors never print grant or owner credentials.
      const setup = (async () => {
        const owner = await createOwner();
        const grant = await grantFromRequest(owner, request);
        const file = path.join(stateDir, 'grant.json');
        write(file, grant);
        await courier(['init', '--grant-file', file]);
        fs.unlinkSync(file);
      })();
      let timer;
      try { await Promise.race([setup, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('identity setup timeout (45s)')), 45_000); })]); }
      catch { throw new Error('throwaway identity setup failed or timed out (45s)'); }
      finally { clearTimeout(timer); }
    }
    const artifact = kept ? null : await courier(['pair', 'start', v.peer ?? 'qa-peer']);
    console.log(JSON.stringify({ ready: true, state: stateDir, artifact }));
    while (!stopping) {
      for (const name of fs.readdirSync(path.join(stateDir, 'control')).filter(n => n.endsWith('.json')).sort()) {
        const file = path.join(stateDir, 'control', name);
        const control = json(file);
        let result = { ok: true };
        if (control.command === 'stop') { stopping = true; keepState = control.options['keep-state'] === true; }
        else if (control.command === 'accept') {
          result = await courier(['pair', 'accept', '--stdin'], JSON.stringify(control.input));
          state.paired = Object.values(json(path.join(stateDir, 'courier', 'profile.json')).peers).some(p => p.status === 'paired');
        } else if (control.command === 'cue') {
          const { action, thread } = parseCue([control.cue.action, ...(control.cue.thread ? [control.cue.thread] : [])]);
          const options = control.options;
          const peer = Object.values(json(path.join(stateDir, 'courier', 'profile.json')).peers).find(p => p.status === 'paired')?.handle;
          if (action === 'block') state.blocked = true;
          else if (action === 'unblock') state.blocked = false;
          else {
            if (!peer) throw new Error('cue requires a paired peer');
            if (action === 'pause' || action === 'resume') {
              await courier([action, peer, thread], undefined, true);
              state.pausedThreads = state.pausedThreads.filter(x => x !== thread);
              if (action === 'pause') state.pausedThreads.push(thread);
            } else if (action === 'revoke') { await courier(['revoke', peer], undefined, true); state.paired = false; }
            else if (action === 'send-thread') {
              result = await courier(['send', peer, '--new', safeText(options.subject ?? 'QA stub thread', 120), '--text', safeText(options.text ?? 'QA stub: please read this thread and reply once.'), '--intent', 'request']);
              state.threadsStarted++; state.threads.push(result.threadId);
            } else if (action === 'ask') {
              const { ulid } = await import('ulid');
              const askId = ulid();
              const envelope = { type: 'qa-stub-ask', askId, verb: safeText(options.verb ?? 'other', 20), target: safeText(options.target ?? 'qa:fixed-follow-up', 120), summary: safeText(options.summary ?? 'Post a fixed QA follow-up', 120) };
              const { requestFields } = await import('../dist/request.js');
              requestFields(envelope);
              result = await courier(['send', peer, '--new', 'QA owner decision', '--intent', 'ask',
                '--text', `QA stub: please do ${envelope.verb} on ${envelope.target} (${envelope.summary}). Ask your owner using courier task and courier request on your own profile. After courier approval verifies their decision, reply "approve ${askId}" or "deny ${askId}". This exercise only posts a fixed follow-up; perform no privileged action.\n\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``,
                '--ask', `Approve: ${envelope.verb} on ${envelope.target}`]);
              state.asks[askId] = { ...envelope, peer, threadId: result.threadId, messageId: result.messageId };
              result = { ...result, askId }; state.asksSent++; state.threads.push(result.threadId);
            }
          }
        }
        save();
        write(path.join(stateDir, 'responses', name), result);
        fs.unlinkSync(file);
      }
      if (!stopping) { await cycle(state, courier, safeText(v['reply-text'] ?? 'stub reply: received'), v.decision ?? 'approve'); save(); await sleep(250); }
    }
    await sleep(250); // let the stop client read its acknowledgement before exact-path cleanup
  } finally {
    if (keepState) { claim.assertHeld(); save(); write(marker, { type: 'qa-courier-stub-v1', pid: null, startTime: null, nonce: null, state: stateDir }); }
    else cleanup();
  }
  } finally { claim?.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`QA stub failed: ${error.message}`); process.exit(1); });
}
