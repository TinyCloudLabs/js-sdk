import fs from 'node:fs';
import path from 'node:path';
import { decodeTime, encodeTime } from 'ulid';
import type { ParsedArgs } from '../args.js';
import type { KV } from '../inbox.js';
import { isRecord } from '../a2a.js';
import { CourierError, errInfo } from '../errors.js';
import { k } from '../keys.js';
import { courierNode } from '../node.js';
import { loadProfile, profileDir, type Profile, type StoredPeer } from '../profile.js';
import { getJson, listAll } from '../store.js';
import { hiddenTextProblem, textVerdict, type TextVerdict } from '../text.js';
import { jsonLineLog, type WatchLog } from '../wake.js';
import { FLAG_TABLE, type Flag } from './flags.js';
import { policyOf, loadPeers, resolvePeersOwner, type Peers } from './peers.js';
import { acquireLock, ensureRealDir, readState, writeNew, writeState, type IntakeState, type PeerState, type Receipt } from './queue.js';

const STATE_FILE = 'intake-state.json';
const LOCK_FILE = 'intake.lock';
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** A message ULID more than this far ahead of local time is not trusted; it is retried on a later cycle. */
const MAX_SKEW_MS = 10 * 60_000;
/** Mirror ids whose ULID time is older than this are dropped at selection: no fetch, no marker. */
const STALE_MS = 7 * DAY_MS;
/** Queue records older than STALE_MS move to done/; done/ entries older than this are pruned. */
const DONE_TTL_MS = 14 * DAY_MS;
/** Overflow is retired once older than the stale horizon: a message that old would be stale on admission anyway. */
const OVERFLOW_TTL_MS = STALE_MS;
/** Overflow is capped by count and by bytes; the oldest sent messages are dropped first. */
const OVERFLOW_MAX_FILES = 200;
const OVERFLOW_MAX_BYTES = 1024 * 1024;
/** Mirror ids taken per peer per cycle. The cursor walks the mirror cyclically, so every id is reached within a lap. */
const MIRROR_BATCH = 200;
/** Queue moves, done prunes, overflow retirements and cap retirements per directory per pass: bounds cleanup IO per cycle. */
const JANITOR_BATCH = 500;
/** Inbound admissions are counted per peer over this window. */
const RATE_WINDOW_MS = HOUR_MS;
/** Queued text is capped at this many UTF-16 units; longer text is flagged `too-long`. */
export const MAX_QUEUE_CHARS = 8000;
/** Queued text is also capped at 16 KiB of UTF-8 (cut at a code-point boundary) and flagged `size` when cut. */
const MAX_QUEUE_BYTES = 16 * 1024;
const RATE_TEXT = 'This peer went over its inbound rate limit; further messages this hour are held outside the queue.';
/** A ULID's first character is 0-7: its 48-bit timestamp cannot exceed 2^48-1. Larger ids overflow decodeTime. */
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
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
  peerId: string;
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

type DoneOutcome = 'init' | 'mismatch' | 'bad-id' | 'overflow';

export interface CycleInput {
  kv: KV;
  profile: Profile;
  peers: Peers;
  queueRoot: string;
  doneRoot: string;
  overflowRoot: string;
  stateDir: string;
  state: IntakeState;
  now: () => number;
  log: WatchLog;
  /** Mirror ids taken per peer per cycle. Defaults to MIRROR_BATCH. */
  batch?: number;
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
  if (!input.verdict.allowed && input.verdict.reason === 'too-long') found.add('too-long');
  if (hiddenTextProblem(input.text, true) || (!input.verdict.allowed && input.verdict.reason !== 'too-long')) found.add('unicode');
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

/**
 * Admits one arrival against the peer's receipt window. Only admitted arrivals are recorded, so an over-cap peer cannot
 * extend its own window. Receipts are kept while they are inside the window relative to the current reading, including
 * receipts later than it, so a clock that steps back does not reopen the cap.
 */
function admit(receipts: Receipt[], id: string, at: number, cap: number): { admitted: boolean; remaining: number; receipts: Receipt[] } {
  const recent = receipts.filter((r) => r.at > at - RATE_WINDOW_MS);
  if (recent.length >= cap) return { admitted: false, remaining: 0, receipts: recent.slice(-cap) };
  return { admitted: true, remaining: cap - recent.length - 1, receipts: [...recent, { id, at }].slice(-cap) };
}

/** Peers whose receipts were reconciled against disk for one loaded state. A persist failure clears its peer. */
const reconciledPeers = new WeakMap<IntakeState, Set<string>>();

function reconciledSet(state: IntakeState): Set<string> {
  let set = reconciledPeers.get(state);
  if (!set) {
    set = new Set();
    reconciledPeers.set(state, set);
  }
  return set;
}

/**
 * Stored receipts merged with this peer's ULID records in queue/ and done/ inside the window, keyed by msgId. An admission
 * counts once even when both its stored receipt and its record exist. A queued record whose state write was lost still
 * counts against the cap, and so does a record the owner has archived to done/. Files whose mtime is older than the window
 * cannot hold a receipt inside it, so they are skipped before being read.
 */
function reconcileReceipts(input: CycleInput, peer: string, receipts: Receipt[], cap: number): Receipt[] {
  const now = input.now();
  const byId = new Map<string, Receipt>();
  for (const r of receipts) if (!byId.has(r.id)) byId.set(r.id, r);
  for (const root of [input.queueRoot, input.doneRoot]) {
    const dir = path.join(root, peer);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!ULID_RE.test(id) || byId.has(id)) continue;
      const file = path.join(dir, name);
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.mtimeMs < now - RATE_WINDOW_MS - 60_000) continue;
      let record: unknown;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (!isRecord(record) || typeof record.receivedAt !== 'string') continue;
      const at = Date.parse(record.receivedAt);
      if (Number.isFinite(at)) byId.set(id, { id, at });
    }
  }
  return [...byId.values()].filter((r) => r.at > now - RATE_WINDOW_MS).sort((a, b) => a.at - b.at).slice(-cap);
}

function persist(input: CycleInput, peer: string): void {
  try {
    writeState(input.stateDir, path.join(input.stateDir, STATE_FILE), input.state);
  } catch (error) {
    reconciledSet(input.state).delete(peer);
    throw error;
  }
}

/** True when `name` already exists for the peer in the queue, done, or overflow store. Symlinks count as present. */
function presentIn(input: CycleInput, peer: string, name: string): boolean {
  for (const root of [input.queueRoot, input.doneRoot, input.overflowRoot]) {
    try {
      fs.lstatSync(path.join(root, peer, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}

/** True when something exists at `file`, a symlink included. Only a missing name reads as absent. */
function pathExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Writes a done marker for one message id. Returns false when a marker already exists. */
function markDone(input: Pick<CycleInput, 'doneRoot' | 'now'>, peer: string, msgId: string, outcome: DoneOutcome): boolean {
  const dir = path.join(input.doneRoot, peer);
  ensureRealDir(dir, 0o700);
  const marker = { v: 1, msgId, peerId: peer, outcome, markedAt: new Date(input.now()).toISOString() };
  return writeNew(dir, `${msgId}.json`, `${JSON.stringify(marker)}\n`, 0o600);
}

/** Message rows in a peer's mirror listing. Rows whose ids are not ULIDs are logged as `bad-id` and skipped. */
function mirrorMessages(handle: string, keys: string[], log: WatchLog): { key: string; threadId: string; msgId: string }[] {
  const messages: { key: string; threadId: string; msgId: string }[] = [];
  for (const key of keys) {
    const match = MSG_KEY.exec(key);
    if (!match) continue; // thread meta.json and other non-message rows are not messages
    const [, threadId, msgId] = match;
    if (!ULID_RE.test(threadId) || !ULID_RE.test(msgId)) {
      log('intake-skip', { peer: handle, code: 'bad-id' });
      continue;
    }
    messages.push({ key, threadId, msgId });
  }
  return messages;
}

/**
 * Writes the rate record for this peer's current hour, once per hour. The record name is `rate-<unixHour>`, created
 * exclusively, so a second overflow in the same hour writes nothing. Returns whether it was created.
 */
function writeRateRecord(input: CycleInput, peer: string, senderName: string, tier: string, at: number): boolean {
  const msgId = `rate-${Math.floor(at / RATE_WINDOW_MS)}`;
  const dir = path.join(input.queueRoot, peer);
  ensureRealDir(dir, 0o2750);
  const record: IntakeRecord = {
    v: 1,
    msgId,
    peerId: peer,
    threadId: 'rate',
    sender: { id: peer, displayName: senderName },
    receivedAt: new Date(at).toISOString(),
    text: RATE_TEXT,
    cheapChecks: {
      textVerdict: textVerdict(RATE_TEXT, 'multiline', MAX_QUEUE_CHARS),
      tier,
      peerRatePerHourRemaining: 0,
      flags: ['rate'],
    },
  };
  if (presentIn(input, peer, `${msgId}.json`)) return false;
  const created = writeNew(dir, `${msgId}.json`, `${JSON.stringify(record)}\n`, 0o640);
  if (created) input.log('peer-over-rate', { peer, msgId });
  return created;
}

/**
 * The next `cap` ids after `cursor` in ascending order, wrapping to the smallest ids once the end is passed.
 * Ids below `floor` are dropped before selection, so they never use up the cap. Keeps two bounded sorted lists,
 * so memory is O(cap) however large the mirror is.
 */
function pickBatch<T extends { msgId: string }>(items: readonly T[], cursor: string, cap: number, floor: string): T[] {
  if (cap < 1) return [];
  const after: T[] = [];
  const wrapped: T[] = [];
  const insertSorted = (list: T[], item: T): void => {
    if (list.length === cap && item.msgId >= list[cap - 1]!.msgId) return;
    let i = list.length;
    while (i > 0 && list[i - 1]!.msgId > item.msgId) i--;
    list.splice(i, 0, item);
    if (list.length > cap) list.pop();
  };
  for (const item of items) {
    if (item.msgId < floor) continue;
    if (item.msgId > cursor) insertSorted(after, item);
    else insertSorted(wrapped, item);
  }
  return [...after, ...wrapped].slice(0, cap);
}

async function intakePeer(input: CycleInput, peer: StoredPeer): Promise<number> {
  const policy = policyOf(input.peers, peer.handle);
  const ps = Object.hasOwn(input.state.peers, peer.handle) ? input.state.peers[peer.handle]! : { receipts: [] };
  input.state.peers[peer.handle] = ps;
  const reconciled = reconciledSet(input.state);
  if (!reconciled.has(peer.handle)) {
    ps.receipts = reconcileReceipts(input, peer.handle, ps.receipts, policy.ratePerHour);
    reconciled.add(peer.handle);
  }
  const senderName = typeof peer.label === 'string' && textVerdict(peer.label, 'summary').allowed ? peer.label : peer.handle;

  const keys = await listAll(input.kv, `${k.mirrorPrefix}${peer.handle}/threads/`);
  const all = mirrorMessages(peer.handle, keys, input.log);
  const cap = input.batch ?? MIRROR_BATCH;
  const floor = encodeTime(input.now() - STALE_MS, 10) + '0'.repeat(16);
  const picked = pickBatch(all, ps.cursor ?? '', cap, floor);

  let written = 0;
  let future = 0;
  let overflowed = false;
  try {
    for (const c of picked) {
      try {
        if (presentIn(input, peer.handle, `${c.msgId}.json`)) continue;
        const at = input.now();
        let sentAt: number;
        try {
          sentAt = decodeTime(c.msgId);
        } catch {
          input.log('intake-skip', { peer: peer.handle, code: 'bad-id' });
          markDone(input, peer.handle, c.msgId, 'bad-id');
          continue;
        }
        if (sentAt > at + MAX_SKEW_MS) {
          future++; // no marker: the id may be inside the skew on a later cycle
          continue;
        }

        const got = await getJson<unknown>(input.kv, c.key);
        if (!got || !isRecord(got.value) || got.value.messageId !== c.msgId || got.value.contextId !== c.threadId) {
          input.log('intake-skip', { peer: peer.handle, code: 'mismatch' });
          markDone(input, peer.handle, c.msgId, 'mismatch');
          continue;
        }

        const { admitted, remaining, receipts } = admit(ps.receipts, c.msgId, at, policy.ratePerHour);
        const parts = Array.isArray(got.value.parts) ? got.value.parts : [];
        const texts: string[] = [];
        for (const part of parts) if (isRecord(part) && typeof part.text === 'string') texts.push(part.text);
        const text = texts.join('\n');
        const verdict = textVerdict(text, 'multiline', MAX_QUEUE_CHARS);
        const capped = capUtf8(text, MAX_QUEUE_BYTES);
        const flags = flagsFor({ text, verdict, overRate: !admitted, truncated: capped.truncated });
        const record: IntakeRecord = {
          v: 1,
          msgId: c.msgId,
          peerId: peer.handle,
          threadId: c.threadId,
          sender: { id: peer.handle, displayName: senderName },
          receivedAt: new Date(at).toISOString(),
          text: capped.text,
          cheapChecks: { textVerdict: verdict, tier: policy.tier, peerRatePerHourRemaining: remaining, flags },
        };
        const body = `${JSON.stringify(record)}\n`;

        if (admitted) {
          const dir = path.join(input.queueRoot, peer.handle);
          ensureRealDir(dir, 0o2750);
          const name = `${c.msgId}.json`;
          let published: boolean;
          try {
            published = writeNew(dir, name, body, 0o640);
          } catch (error) {
            // The link can succeed before the directory fsync fails. A record that is visible is admitted, so it counts.
            if (pathExists(path.join(dir, name))) ps.receipts = receipts;
            throw error;
          }
          if (published) {
            ps.receipts = receipts;
            persist(input, peer.handle);
            written++;
            input.log('intake-queued', { peer: peer.handle, msgId: c.msgId, tier: policy.tier, flags });
          }
        } else {
          const dir = path.join(input.overflowRoot, peer.handle);
          ensureRealDir(dir, 0o700);
          writeNew(dir, `${c.msgId}.json`, body, 0o600);
          overflowed = true;
          ps.receipts = receipts;
          persist(input, peer.handle);
          if (writeRateRecord(input, peer.handle, senderName, policy.tier, at)) written++;
        }
      } catch (error) {
        input.log('intake-error', { peer: peer.handle, msgId: c.msgId, code: errInfo(error).code ?? 'error' });
      }
    }
  } finally {
    // Every picked id counts as traversed, failed or not, so one bad id cannot hold the cursor in place.
    if (picked.length > 0) ps.cursor = picked[picked.length - 1]!.msgId;
    if (overflowed) capOverflow(input, peer.handle);
    persist(input, peer.handle);
  }
  if (future > 0) input.log('intake-skip', { peer: peer.handle, code: 'stale', direction: 'future', count: future });
  return written;
}

/** Names of the JSON files in `dir`, ascending. ULID names sort by time. */
function jsonNames(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

/**
 * Time a queue, done or overflow entry belongs to: the ULID's time, or the start of the hour for a `rate-<unixHour>` record.
 * Undefined for any other name.
 */
function nameTime(name: string): number | undefined {
  const base = name.slice(0, -'.json'.length);
  if (ULID_RE.test(base)) return decodeTime(base);
  const rate = /^rate-(\d+)$/.exec(base);
  return rate ? Number(rate[1]) * RATE_WINDOW_MS : undefined;
}

/**
 * Retires one overflow file. The done marker is written before the unlink, so a retired id is not admitted again when the
 * cursor laps. Markers live until the id is DONE_TTL_MS old, far past the 7-day floor below which ids are never fetched.
 */
function retireOverflow(input: CycleInput, peer: string, name: string): void {
  const msgId = name.slice(0, -'.json'.length);
  if (ULID_RE.test(msgId)) markDone(input, peer, msgId, 'overflow');
  fs.unlinkSync(path.join(input.overflowRoot, peer, name));
}

/**
 * Retires the oldest overflow files of one peer until the count and byte caps hold, at most JANITOR_BATCH per call. The
 * byte cap is checked only once the count cap holds, so only the files that remain are sized.
 */
function capOverflow(input: CycleInput, peer: string): void {
  const dir = path.join(input.overflowRoot, peer);
  const names = jsonNames(dir);
  const excess = Math.min(Math.max(0, names.length - OVERFLOW_MAX_FILES), JANITOR_BATCH);
  for (const name of names.slice(0, excess)) retireOverflow(input, peer, name);
  const kept = names.slice(excess);
  if (kept.length > OVERFLOW_MAX_FILES) return;
  const sizes = kept.map((name) => fs.statSync(path.join(dir, name)).size);
  let bytes = sizes.reduce((sum, size) => sum + size, 0);
  for (let i = 0; i < kept.length && bytes > OVERFLOW_MAX_BYTES; i++) {
    retireOverflow(input, peer, kept[i]!);
    bytes -= sizes[i]!;
  }
}

/** Names of the peer directories directly under `root`. Entries whose names fail SAFE_ID are not peers. */
function peerDirs(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
    .map((entry) => entry.name);
}

/**
 * One bounded pass per directory per cycle. Age comes from the file name, so unexpired entries are not read. Queue records
 * older than 7 days move to done/. done/ entries older than 14 days are pruned. Overflow entries older than 7 days are
 * retired with a marker, then the overflow caps apply. Names that are neither ULIDs nor rate records are left in place.
 */
function runJanitor(input: CycleInput): void {
  const now = input.now();
  for (const peer of peerDirs(input.queueRoot)) {
    const dir = path.join(input.queueRoot, peer);
    let budget = JANITOR_BATCH;
    for (const name of jsonNames(dir)) {
      const at = nameTime(name);
      if (at === undefined || !(at < now - STALE_MS)) continue;
      if (budget-- <= 0) break;
      const file = path.join(dir, name);
      const body = fs.readFileSync(file, 'utf8');
      try {
        if (!isRecord(JSON.parse(body))) continue;
      } catch {
        continue;
      }
      const doneDir = path.join(input.doneRoot, peer);
      ensureRealDir(doneDir, 0o700);
      writeNew(doneDir, name, body, 0o600);
      fs.unlinkSync(file);
    }
  }
  for (const peer of peerDirs(input.doneRoot)) {
    const dir = path.join(input.doneRoot, peer);
    let budget = JANITOR_BATCH;
    for (const name of jsonNames(dir)) {
      const at = nameTime(name);
      if (at === undefined || !(at < now - DONE_TTL_MS)) continue;
      if (budget-- <= 0) break;
      fs.unlinkSync(path.join(dir, name));
    }
  }
  for (const peer of peerDirs(input.overflowRoot)) {
    const dir = path.join(input.overflowRoot, peer);
    let budget = JANITOR_BATCH;
    for (const name of jsonNames(dir)) {
      const at = nameTime(name);
      if (at === undefined || !(at < now - OVERFLOW_TTL_MS)) continue;
      if (budget-- <= 0) break;
      retireOverflow(input, peer, name);
    }
    capOverflow(input, peer);
  }
}

/** One pass: janitor, then every paired peer's mirror. Returns how many new queue files were written (rate records included). */
export async function intakeCycle(input: CycleInput): Promise<number> {
  for (const id of Object.keys(input.state.peers)) {
    if (!Object.hasOwn(input.profile.peers, id)) delete input.state.peers[id];
  }
  runJanitor(input);
  let written = 0;
  for (const peer of Object.values(input.profile.peers)) {
    if (peer.status !== 'paired') continue;
    if (!SAFE_ID.test(peer.handle)) {
      input.log('intake-skip', { code: 'bad-handle' });
      continue;
    }
    try {
      written += await intakePeer(input, peer);
    } catch (error) {
      input.log('intake-error', { peer: peer.handle, code: errInfo(error).code ?? 'error' });
    }
  }
  return written;
}

/** Input for `--init-from-now`: writes done markers only, never queue records. */
export interface InitInput {
  kv: KV;
  profile: Profile;
  doneRoot: string;
  now: () => number;
  log: WatchLog;
}

/**
 * Marks every mirrored message of each paired peer as done (outcome `init`), so the first real intake skips existing
 * history. Refuses before writing anything when a paired peer already has a done/ entry, unless `force`. Existing markers
 * are not rewritten. Returns the number of markers written per peer.
 */
export async function initFromNow(input: InitInput, force: boolean): Promise<Map<string, number>> {
  const paired = Object.values(input.profile.peers).filter((peer) => peer.status === 'paired' && SAFE_ID.test(peer.handle));
  const hasDone = paired.some((peer) => {
    const dir = path.join(input.doneRoot, peer.handle);
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  });
  if (hasDone && !force) throw new CourierError('init-exists', 'done/ already has entries for a paired peer; pass --force to mark again');
  const marked = new Map<string, number>();
  for (const peer of paired) {
    const keys = await listAll(input.kv, `${k.mirrorPrefix}${peer.handle}/threads/`);
    let count = 0;
    for (const c of mirrorMessages(peer.handle, keys, input.log)) {
      if (markDone(input, peer.handle, c.msgId, 'init')) count++;
    }
    marked.set(peer.handle, count);
    input.log('intake-init', { peer: peer.handle, marked: count });
  }
  return marked;
}

function intervalSeconds(raw: string | undefined): number {
  if (raw === undefined) return 60;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 5 && n <= 3600)) throw new CourierError('usage', '--interval must be an integer from 5 to 3600');
  return n;
}

/** Periodic peers reload. A refused file keeps the last good map and logs `intake-error`. */
export function reloadPeers(peersFile: string, peersOwner: number | undefined, last: Peers, log: WatchLog): Peers {
  try {
    return loadPeers(peersFile, peersOwner);
  } catch (error) {
    log('intake-error', { code: errInfo(error).code ?? 'bad-peers' });
    return last;
  }
}

/** Collaborators of the intake loop. Tests replace them to run one iteration without a live node. */
export interface IntakeLoopDeps {
  loadProfile: typeof loadProfile;
  courierNode: typeof courierNode;
  reloadPeers: typeof reloadPeers;
}

const defaultLoopDeps: IntakeLoopDeps = { loadProfile, courierNode, reloadPeers };

export async function cmdIntake(args: ParsedArgs, deps: IntakeLoopDeps = defaultLoopDeps): Promise<void> {
  const base = path.join(profileDir(), 'intake');
  const queueRoot = args.get('queue-dir') ?? path.join(base, 'queue');
  const doneRoot = args.get('done-dir') ?? path.join(base, 'done');
  const overflowRoot = args.get('overflow-dir') ?? path.join(base, 'overflow');
  const stateDir = args.get('state-dir') ?? path.join(base, 'state');
  const peersFile = args.get('peers-file') ?? path.join(base, 'peers.json');
  const peersOwner = resolvePeersOwner(args.get('peers-owner'), process.env.COURIER_PEERS_OWNER);
  const once = args.has('once');
  const intervalMs = intervalSeconds(args.get('interval')) * 1000;
  const log = jsonLineLog();

  ensureRealDir(stateDir, 0o700);
  ensureRealDir(queueRoot, 0o750);
  ensureRealDir(doneRoot, 0o700);
  ensureRealDir(overflowRoot, 0o700);
  const release = acquireLock(path.join(stateDir, LOCK_FILE));
  try {
    if (args.has('init-from-now')) {
      const profile = loadProfile();
      const node = await courierNode(profile);
      await initFromNow({ kv: node.kv, profile, doneRoot, now: Date.now, log }, args.has('force'));
      return;
    }
    const state = readState(path.join(stateDir, STATE_FILE));
    let peers = loadPeers(peersFile, peersOwner);
    log('intake-start', { once, intervalSeconds: intervalMs / 1000 });
    for (;;) {
      try {
        const profile = deps.loadProfile();
        const node = await deps.courierNode(profile);
        peers = deps.reloadPeers(peersFile, peersOwner, peers, log);
        const queued = await intakeCycle({
          kv: node.kv,
          profile,
          peers,
          queueRoot,
          doneRoot,
          overflowRoot,
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
