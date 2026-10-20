import path from 'node:path';
import { decodeTime } from 'ulid';
import type { ParsedArgs } from '../args.js';
import type { KV } from '../inbox.js';
import { isRecord } from '../a2a.js';
import { CourierError, errInfo } from '../errors.js';
import { k } from '../keys.js';
import { courierNode } from '../node.js';
import { loadProfile, profileDir, type Profile, type StoredPeer } from '../profile.js';
import { getJson, listAll } from '../store.js';
import { textVerdict, type TextVerdict } from '../text.js';
import { jsonLineLog, type WatchLog } from '../wake.js';
import { FLAG_TABLE, type Flag } from './flags.js';
import { policyOf, loadPeers, type Peers } from './peers.js';
import { acquireLock, ensureRealDir, readState, writeNew, writeState, type IntakeState } from './queue.js';

const STATE_FILE = 'intake-state.json';
const LOCK_FILE = 'intake.lock';
/** A message ULID more than this far ahead of local time is not trusted; intake stops at the first such id. */
const MAX_SKEW_MS = 10 * 60_000;
const RATE_WINDOW_MS = 60 * 60_000;
/** Queued text is capped at 16 KiB of UTF-8 (cut at a code-point boundary) and flagged `size` when cut. */
const MAX_QUEUE_BYTES = 16 * 1024;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SAFE_ID = /^[0-9A-Za-z_-]{1,64}$/;
const MSG_KEY = /\/threads\/([^/]+)\/msg\/([^/]+)\.json$/;

const LINK = /(?:https?|ftp):\/\/|\bwww\.[a-z0-9-]+\./i;
const ENCODED = /[A-Za-z0-9+\/=]{64,}/;
const REQUEST = /(?:^|[.!?\n]\s*|\bplease\s+)(?:run|merge|send|open|forward|delete|reveal|deploy)\b/i;
const SECRET_REQUEST = /\b(?:share|send|give|paste|reveal|tell|show|post)\b[^.!?\n]{0,40}\b(?:keys?|tokens?|passwords?|credentials?|secrets?|seed phrase)\b/i;
const INSTRUCTION_PHRASES = [
  'ignore previous',
  'ignore all previous',
  'disregard previous',
  'forget your instructions',
  'you are now',
  'new instructions',
  'system prompt',
  'override your',
];

export interface IntakeRecord {
  v: 1;
  msgId: string;
  threadId: string;
  sender: { id: string; displayName: string };
  receivedAt: string;
  text: string;
  cheapChecks: {
    textVerdict: TextVerdict;
    tier: string;
    peerRatePerHourRemaining: number;
    flags: Flag[];
  };
}

export interface CycleInput {
  kv: KV;
  profile: Profile;
  peers: Peers;
  queueRoot: string;
  stateDir: string;
  state: IntakeState;
  now: () => number;
  log: WatchLog;
}

/** Cuts `text` to at most `maxBytes` of UTF-8 at a code-point boundary. */
export function capUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return { text: out, truncated: true };
}

/** Maps the verdict and the cheap text detectors to flag codes from FLAG_TABLE, in table order. */
export function flagsFor(input: { text: string; verdict: TextVerdict; overRate: boolean; truncated: boolean }): Flag[] {
  const found = new Set<Flag>();
  if (!input.verdict.allowed) found.add(input.verdict.reason === 'too-long' ? 'too-long' : 'unicode');
  const lower = input.text.toLowerCase();
  if (LINK.test(input.text)) found.add('link');
  if (INSTRUCTION_PHRASES.some((phrase) => lower.includes(phrase))) found.add('instruction');
  if (REQUEST.test(input.text)) found.add('request');
  if (SECRET_REQUEST.test(input.text)) found.add('secret-request');
  if (ENCODED.test(input.text)) found.add('encoded');
  if (input.overRate) found.add('rate');
  if (input.truncated) found.add('size');
  return (Object.keys(FLAG_TABLE) as Flag[]).filter((flag) => found.has(flag));
}

/** Records one arrival in the peer's receipt window. Returns whether the peer was already at its cap and how many more fit. */
function noteReceipt(ps: { receipts: number[] }, at: number, cap: number): { overRate: boolean; remaining: number } {
  const recent = ps.receipts.filter((t) => t > at - RATE_WINDOW_MS && t <= at);
  const overRate = recent.length >= cap;
  ps.receipts = [...recent, at].slice(-cap);
  return { overRate, remaining: Math.max(0, cap - recent.length - 1) };
}

function persist(input: CycleInput): void {
  writeState(input.stateDir, path.join(input.stateDir, STATE_FILE), input.state);
}

async function intakePeer(input: CycleInput, peer: StoredPeer): Promise<number> {
  const policy = policyOf(input.peers, peer.handle);
  const ps = input.state.peers[peer.handle] ?? { highWater: null, receipts: [] };
  input.state.peers[peer.handle] = ps;

  const keys = await listAll(input.kv, `${k.mirrorPrefix}${peer.handle}/threads/`);
  const candidates: { key: string; threadId: string; msgId: string }[] = [];
  for (const key of keys) {
    const match = MSG_KEY.exec(key);
    if (!match) continue; // thread meta.json and other non-message rows are not messages
    const [, threadId, msgId] = match;
    if (!ULID_RE.test(threadId) || !ULID_RE.test(msgId)) {
      input.log('intake-skip', { peer: peer.handle, code: 'bad-id' });
      continue;
    }
    if (ps.highWater !== null && msgId <= ps.highWater) continue;
    candidates.push({ key, threadId, msgId });
  }
  candidates.sort((a, b) => (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0));

  let queued = 0;
  for (const c of candidates) {
    const at = input.now();
    let sentAt: number;
    try {
      sentAt = decodeTime(c.msgId);
    } catch {
      input.log('intake-skip', { peer: peer.handle, code: 'bad-id' });
      ps.highWater = c.msgId;
      persist(input);
      continue;
    }
    if (sentAt > at + MAX_SKEW_MS) {
      input.log('intake-skip', { peer: peer.handle, code: 'future-id' });
      break;
    }

    const got = await getJson<unknown>(input.kv, c.key);
    if (!got || !isRecord(got.value) || got.value.messageId !== c.msgId || got.value.contextId !== c.threadId) {
      input.log('intake-skip', { peer: peer.handle, code: 'mismatch' });
      ps.highWater = c.msgId;
      persist(input);
      continue;
    }

    const { overRate, remaining } = noteReceipt(ps, at, policy.ratePerHour);
    const parts = Array.isArray(got.value.parts) ? got.value.parts : [];
    const texts: string[] = [];
    for (const part of parts) if (isRecord(part) && typeof part.text === 'string') texts.push(part.text);
    const text = texts.join('\n');
    const verdict = textVerdict(text, 'multiline');
    const capped = capUtf8(text, MAX_QUEUE_BYTES);
    const flags = flagsFor({ text, verdict, overRate, truncated: capped.truncated });
    const label = peer.label;
    const displayName = typeof label === 'string' && textVerdict(label, 'summary').allowed ? label : peer.handle;

    const record: IntakeRecord = {
      v: 1,
      msgId: c.msgId,
      threadId: c.threadId,
      sender: { id: peer.handle, displayName },
      receivedAt: new Date(at).toISOString(),
      text: capped.text,
      cheapChecks: { textVerdict: verdict, tier: policy.tier, peerRatePerHourRemaining: remaining, flags },
    };
    const dir = path.join(input.queueRoot, peer.handle);
    ensureRealDir(dir, 0o750);
    const created = writeNew(dir, `${c.msgId}.json`, `${JSON.stringify(record)}\n`, 0o640);
    if (created) queued++;
    ps.highWater = c.msgId;
    persist(input);
    input.log('intake-queued', { peer: peer.handle, msgId: c.msgId, tier: policy.tier, flags, duplicate: !created });
  }
  return queued;
}

/** One pass over every paired peer's mirror. Returns how many new queue files were written. */
export async function intakeCycle(input: CycleInput): Promise<number> {
  for (const id of Object.keys(input.state.peers)) {
    if (!Object.hasOwn(input.profile.peers, id)) delete input.state.peers[id];
  }
  let queued = 0;
  for (const peer of Object.values(input.profile.peers)) {
    if (peer.status !== 'paired') continue;
    if (!SAFE_ID.test(peer.handle)) {
      input.log('intake-skip', { code: 'bad-handle' });
      continue;
    }
    try {
      queued += await intakePeer(input, peer);
    } catch (error) {
      input.log('intake-error', { peer: peer.handle, code: errInfo(error).code ?? 'error' });
    }
  }
  return queued;
}

function intervalSeconds(raw: string | undefined): number {
  if (raw === undefined) return 60;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 5 && n <= 3600)) throw new CourierError('usage', '--interval must be an integer from 5 to 3600');
  return n;
}

export async function cmdIntake(args: ParsedArgs): Promise<void> {
  const base = path.join(profileDir(), 'intake');
  const queueRoot = args.get('queue-dir') ?? path.join(base, 'queue');
  const stateDir = args.get('state-dir') ?? path.join(base, 'state');
  const peersFile = args.get('peers-file') ?? path.join(base, 'peers.json');
  const once = args.has('once');
  const intervalMs = intervalSeconds(args.get('interval')) * 1000;
  const log = jsonLineLog();

  ensureRealDir(stateDir, 0o700);
  ensureRealDir(queueRoot, 0o750);
  const release = acquireLock(path.join(stateDir, LOCK_FILE));
  try {
    const state = readState(path.join(stateDir, STATE_FILE));
    loadPeers(peersFile, log);
    log('intake-start', { once, intervalSeconds: intervalMs / 1000 });
    for (;;) {
      try {
        const profile = loadProfile();
        const node = await courierNode(profile);
        const peers = loadPeers(peersFile, log);
        const queued = await intakeCycle({
          kv: node.kv,
          profile,
          peers,
          queueRoot,
          stateDir,
          state,
          now: Date.now,
          log,
        });
        log('intake-cycle', { queued });
      } catch (error) {
        log('intake-error', { code: errInfo(error).code ?? 'error' });
        if (once) throw error;
      }
      if (once) return;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, intervalMs);
      });
    }
  } finally {
    release();
  }
}
