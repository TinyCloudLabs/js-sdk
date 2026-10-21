import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { TinyCloudNode } from '@tinycloud/node-sdk';
import type { ParsedArgs } from './args.js';
import { oneOf, requireFlag } from './args.js';
import { readTextArg, sendMessage } from './commands.js';
import type { SendInput } from './commands.js';
import { canonicalJson, requestHash } from './canonical.js';
import { CourierError, errInfo } from './errors.js';
import { cmd } from './program.js';
import { courierNode } from './node.js';
import { getPeer, loadProfile, profileDir } from './profile.js';
import type { Profile } from './profile.js';
import { loadPeers, policyOf, resolvePeersOwner } from './intake/peers.js';
import type { Peers } from './intake/peers.js';
import { acquireLock, ensureRealDir, fsyncDir, writeNew, writeReplace } from './intake/queue.js';
import { textVerdict } from './text.js';
import { jsonLineLog } from './wake.js';

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const PEER_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The whole request, matched on raw bytes before any JSON parsing: exact key order, no whitespace, `v` is the integer 1. */
const REQUEST_RE = /^\{"v":1,"itemId":"([0-7][0-9A-HJKMNP-TV-Z]{25})"\}$/;
const MAX_REQUEST_BYTES = 64;
const MAX_ITEM_BYTES = 32 * 1024;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const PIPE_TIMEOUT_MS = 5000;
/** Connections held open at once. Over this, a socket is closed without a reply. Independent of the send quota. */
const MAX_CONNECTIONS = 64;
/** Requests waiting behind the one being served. Over this, the reply is `refused:busy`. Independent of the send quota. */
const MAX_PENDING = 32;
/** Refusal and diagnostic events per fixed window. The rest are counted and reported once when the window rolls over. */
const LOG_WINDOW_MS = 60 * 1000;
const LOG_BUDGET = 10;
/** Requests that reach the outbox lookup per fixed window. Over this, the reply is `refused:busy`, independent of the send quota. */
const REQUEST_BUDGET = 60;
const REQUEST_WINDOW_MS = 60 * 1000;
const DEFAULT_SOCKET_GROUP = 'courier-sender';
const DENIED_SOCKET_GROUPS = ['tinycloud', 'tinycloud-dev', 'sudo', 'docker'];
const SERVE_LOCK = 'serve.lock';
/** Approval ledger directory under the outbox root: one create-once owner-only file per approved item. */
const APPROVED_DIR = 'approved';
/** Owner-only mode for outbox items and ledger entries. */
const ITEM_MODE = 0o600;
const ITEM_KEYS = ['v', 'itemId', 'to', 'thread', 'subject', 'text', 'approvedSha256'];

/** The only refusal codes the sender can reply with. Replies never carry item ids, paths, text, or error messages. */
export const REFUSAL_CODES = [
  'bad-request', 'not-found', 'ambiguous-item', 'unsafe-item', 'bad-item', 'not-approved', 'hash-mismatch',
  'unpaired-peer', 'invalid-text', 'rate-limited', 'already-used', 'send-failed', 'dry-run',
  'root-unsafe', 'busy', 'internal', 'uncertain',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type OutboxLog = (event: string, fields?: Record<string, unknown>) => void;

export interface OutboxItem {
  v: 1;
  itemId: string;
  to: string;
  thread: string | null;
  subject?: string;
  text: string;
  approvedSha256: string;
}

export interface OutboxOptions {
  outboxRoot: string;
  sentDir: string;
  pipe: string;
  socketGroup: string;
  peersFile: string;
  /** Account that must own peers.json. Undefined means the running user. */
  peersOwnerUid?: number;
  once?: boolean;
  dryRun?: boolean;
  groups?: (name: string) => number;
  loadProfile?: () => Profile;
  send?: (profile: Profile, peerHandle: string, input: SendInput) => Promise<{ messageId: string }>;
  now?: () => number;
  log?: OutboxLog;
}

export interface OutboxHandle {
  close: () => Promise<void>;
  done: Promise<void>;
}

class Refusal extends Error {
  constructor(readonly code: RefusalCode) {
    super(code);
  }
}

const ADD_USAGE = `Usage: ${cmd('outbox add <peer> (--thread <id> | --new <subject>) [--text t | --file f | stdin] [--outbox-dir d]')}`;
const SERVE_USAGE = `Usage: ${cmd('outbox serve --pipe <socket> [--outbox-dir d] [--socket-group g] [--peers-file f] [--peers-owner u] [--sent-dir d] [--once] [--dry-run]')}`;
const OUTBOX_USAGE = `Usage: ${cmd('outbox add <peer> ... | outbox serve ...')}`;

function lstatOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function ownerUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new CourierError('unsupported', 'the outbox needs POSIX file ownership');
  return uid;
}

/** Error codes that may be logged: OS errno values and this package's own CourierError codes. Anything else logs as `unknown`. */
const LOGGABLE_CODES = new Set([
  'EACCES', 'EEXIST', 'EIO', 'EISDIR', 'EMFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EPIPE', 'EROFS', 'ECONNRESET',
  'bad-marker', 'bad-peers', 'socket-group-denied', 'unknown-group', 'unsafe-dir', 'unsafe-pipe', 'unsafe-socket-dir',
  'unsafe-socket-group', 'unsupported',
]);

/** An error code safe to log: from the fixed vocabulary above, else `unknown`. Messages and paths are never logged. */
function safeCode(error: unknown): string {
  const code = errInfo(error).code;
  return typeof code === 'string' && LOGGABLE_CODES.has(code) ? code : 'unknown';
}

/** Hash over the item without its own approvedSha256 field. Shared by `outbox add` and the sender. */
function itemHash(item: object): string {
  return requestHash(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'approvedSha256')));
}

function textOk(text: string, subject: string | undefined): boolean {
  if (!textVerdict(text, 'multiline').allowed) return false;
  return subject === undefined || textVerdict(subject, 'summary').allowed;
}

/** Parses the exact request frame (the bytes before its newline). Runs before any filesystem access. */
function parseRequest(frame: Buffer): string {
  if (frame.length > MAX_REQUEST_BYTES) throw new Refusal('bad-request');
  const match = REQUEST_RE.exec(frame.toString('utf8'));
  if (match === null) throw new Refusal('bad-request');
  return match[1] as string;
}

/** Finds the one item file across peer directories. Symlinked peer directories are skipped. */
function findItem(root: string, itemId: string): { peer: string; file: string } {
  const hits: { peer: string; file: string }[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (entry === APPROVED_DIR) continue;
    const dir = path.join(root, entry);
    if (lstatOrUndefined(dir)?.isDirectory() !== true) continue;
    const file = path.join(dir, `${itemId}.json`);
    if (lstatOrUndefined(file) !== undefined) hits.push({ peer: entry, file });
  }
  if (hits.length === 0) throw new Refusal('not-found');
  if (hits.length > 1) throw new Refusal('ambiguous-item');
  return hits[0] as { peer: string; file: string };
}

/** Reads an owner-only regular item file once, through the descriptor that was checked. */
function readItemFile(file: string): Buffer {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new Refusal('unsafe-item');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== ownerUid() || (st.mode & 0o077) !== 0) throw new Refusal('unsafe-item');
    const buf = Buffer.alloc(MAX_ITEM_BYTES + 1);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
      if (total > MAX_ITEM_BYTES) throw new Refusal('bad-item');
    }
    return buf.subarray(0, total);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads the approval ledger entry for an item: the approved hash, or undefined when there is no entry. The entry must be
 * an owner-only regular file; anything else is unsafe.
 */
function readLedger(root: string, itemId: string): string | undefined {
  const file = path.join(root, APPROVED_DIR, itemId);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Refusal('unsafe-item');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== ownerUid() || (st.mode & 0o077) !== 0 || st.size > 256) throw new Refusal('unsafe-item');
    return fs.readFileSync(fd, 'utf8').replace(/\n$/, '');
  } finally {
    fs.closeSync(fd);
  }
}

function isOutboxItem(value: unknown, itemId: string, peer: string): value is OutboxItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (!Object.keys(o).every((key) => ITEM_KEYS.includes(key))) return false;
  const threadOk = (typeof o.thread === 'string' && ULID_RE.test(o.thread) && o.subject === undefined)
    || (o.thread === null && typeof o.subject === 'string');
  return o.v === 1 && o.itemId === itemId && o.to === peer && PEER_RE.test(peer)
    && typeof o.text === 'string' && typeof o.approvedSha256 === 'string' && threadOk;
}

/**
 * Parses the item bytes. The only accepted representation is the canonical one: `canonicalJson(item)` plus one newline.
 * Whitespace, key order, duplicate keys, a missing final newline, invalid UTF-8, and a leading byte-order mark are all refused as bad-item.
 */
function parseItem(raw: Buffer, itemId: string, peer: string): OutboxItem {
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    value = JSON.parse(text);
    if (text !== `${canonicalJson(value)}\n`) throw new Refusal('bad-item');
  } catch {
    throw new Refusal('bad-item');
  }
  if (!isOutboxItem(value, itemId, peer)) throw new Refusal('bad-item');
  return value;
}

function readMarker(file: string): { peer: string; at: number } {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new CourierError('bad-marker', 'unreadable sent marker');
  }
  const m = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const at = typeof m.at === 'string' ? Date.parse(m.at) : Number.NaN;
  if (typeof m.peer !== 'string' || Number.isNaN(at)) throw new CourierError('bad-marker', 'malformed sent marker');
  return { peer: m.peer, at };
}

/**
 * Counts single-use markers for this peer in the rolling hour. Markers are persistent, so the window survives a restart.
 * A receipt dated after `now` (a clock stepped back) still counts. An unreadable marker fails closed.
 */
function checkRate(sentDir: string, peer: string, cap: number, now: number): void {
  let recent = 0;
  for (const name of fs.readdirSync(sentDir)) {
    if (!ULID_RE.test(name)) continue;
    const marker = readMarker(path.join(sentDir, name));
    if (marker.peer === peer && now - marker.at < RATE_WINDOW_MS) recent++;
  }
  if (recent >= cap) throw new Refusal('rate-limited');
}

/** Records the outcome beside the marker. Failure to write it is logged; the send outcome is unchanged. */
function recordResult(sentDir: string, itemId: string, state: 'sent' | 'failed' | 'uncertain', messageId: string | undefined, now: number, log: OutboxLog): void {
  const body = JSON.stringify({ v: 1, state, at: new Date(now).toISOString(), messageId });
  try {
    writeReplace(sentDir, `${itemId}.result.json`, `${body}\n`, 0o600);
  } catch (error) {
    log('outbox.result-write-failed', { code: safeCode(error) });
  }
}

/**
 * Reservations (markers) with no recorded result. A send may have happened, so they are never resent. Each gets a
 * durable `uncertain` result beside its marker; the count is all that is logged.
 */
function reconcileUncertain(sentDir: string, now: number, log: OutboxLog): number {
  const pending = fs.readdirSync(sentDir).filter((name) => ULID_RE.test(name)
    && lstatOrUndefined(path.join(sentDir, `${name}.result.json`)) === undefined);
  for (const itemId of pending) recordResult(sentDir, itemId, 'uncertain', undefined, now, log);
  return pending.length;
}

/**
 * The recorded outcome of an item, or undefined when none is recorded. An unreadable result counts as `uncertain`, so the
 * item is never resent.
 */
function recordedState(sentDir: string, itemId: string): string | undefined {
  const file = path.join(sentDir, `${itemId}.result.json`);
  if (lstatOrUndefined(file) === undefined) return undefined;
  try {
    const state = (JSON.parse(fs.readFileSync(file, 'utf8')) as { state?: unknown }).state;
    return typeof state === 'string' ? state : 'uncertain';
  } catch {
    return 'uncertain';
  }
}

/** Group id from /etc/group. Injectable in tests through `OutboxOptions.groups`. */
export function groupGid(name: string, file = '/etc/group'): number {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const [group, , gid] = line.split(':');
    if (group === name && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
  }
  throw new CourierError('unknown-group', `socket group ${name} does not exist`);
}

/** The socket directory must be a real, owner-only directory whose group is the configured group. */
function checkSocketDir(dir: string, group: string, gidOf: (name: string) => number): number {
  const st = lstatOrUndefined(dir);
  if (!st?.isDirectory()) throw new CourierError('unsafe-socket-dir', 'socket directory must be a real directory');
  if (st.uid !== ownerUid()) throw new CourierError('unsafe-socket-dir', 'socket directory must be owned by this user');
  if ((st.mode & 0o777 & ~0o750) !== 0) throw new CourierError('unsafe-socket-dir', 'socket directory mode must not exceed 0750');
  if (DENIED_SOCKET_GROUPS.includes(group)) throw new CourierError('unsafe-socket-group', `group ${group} may not own the sender socket`);
  const gid = gidOf(group);
  if (st.gid !== gid) throw new CourierError('unsafe-socket-dir', 'socket directory group must equal the configured group');
  return gid;
}

function listen(server: net.Server, pipe: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function nodeSender(): (profile: Profile, peerHandle: string, input: SendInput) => Promise<{ messageId: string }> {
  let node: Promise<TinyCloudNode> | undefined;
  return async (profile, peerHandle, input) => {
    node ??= courierNode(profile);
    return sendMessage(await node, profile, peerHandle, getPeer(profile, peerHandle), input);
  };
}

/**
 * Wraps the sender log in a fixed-window budget of LOG_BUDGET events per LOG_WINDOW_MS. Events over it are counted, and the
 * count is logged once when the window rolls over. Every sender diagnostic goes through this wrapper.
 */
function budgetedLog(log: OutboxLog, now: () => number): OutboxLog {
  const budget = { start: 0, used: 0, suppressed: 0 };
  return (event, fields = {}) => {
    const t = now();
    if (t < budget.start || t - budget.start >= LOG_WINDOW_MS) {
      if (budget.suppressed > 0) log('outbox.log-suppressed', { count: budget.suppressed });
      budget.start = t;
      budget.used = 0;
      budget.suppressed = 0;
    }
    if (budget.used < LOG_BUDGET) {
      budget.used++;
      log(event, fields);
    } else {
      budget.suppressed++;
    }
  };
}

/**
 * Starts the sender pipe. One request per connection: `{"v":1,"itemId":"<ulid>"}` then a newline, or the frame then end of
 * stream. The reply is one line, `ok` or `refused:<code>`. Bytes after the frame's newline that arrive before the request is
 * served refuse it as `bad-request`, and nothing is sent. A connection that has sent bytes but no complete frame within
 * PIPE_TIMEOUT_MS gets `refused:bad-request`. One that sent nothing is dropped without a reply. Requests are served one at a time.
 */
export async function startOutbox(opts: OutboxOptions): Promise<OutboxHandle> {
  const log: OutboxLog = opts.log ?? jsonLineLog();
  const now = opts.now ?? Date.now;
  const limited = budgetedLog(log, now);
  const loadNow = opts.loadProfile ?? loadProfile;
  const send = opts.send ?? nodeSender();
  const gidOf = opts.groups ?? groupGid;
  const dryRun = opts.dryRun ?? false;
  const once = opts.once ?? false;

  if (ensureRealDir(opts.sentDir, 0o700)) fsyncDir(path.dirname(opts.sentDir));
  const releaseLock = acquireLock(path.join(opts.sentDir, SERVE_LOCK));
  const uncertain = reconcileUncertain(opts.sentDir, Date.now(), limited);
  if (uncertain > 0) limited('outbox.uncertain', { count: uncertain });
  const server = net.createServer({ allowHalfOpen: true }, accept);
  try {
    const gid = checkSocketDir(path.dirname(opts.pipe), opts.socketGroup, gidOf);
    const stale = lstatOrUndefined(opts.pipe);
    if (stale !== undefined) {
      if (!stale.isSocket()) throw new CourierError('unsafe-pipe', 'pipe path exists and is not a socket');
      fs.unlinkSync(opts.pipe);
    }
    await listen(server, opts.pipe);
    // Same tick as listen: no connection is accepted until the group and mode are set.
    try {
      fs.chownSync(opts.pipe, -1, gid);
      fs.chmodSync(opts.pipe, 0o660);
    } catch {
      throw new CourierError('socket-group-denied', 'could not assign the sender socket to the configured group');
    }
  } catch (error) {
    if (server.listening) {
      server.close();
      if (lstatOrUndefined(opts.pipe)?.isSocket()) fs.unlinkSync(opts.pipe);
    }
    releaseLock();
    throw error;
  }
  limited('outbox.listening', { once, dryRun });

  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  let open = 0;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await chain;
      if (lstatOrUndefined(opts.pipe)?.isSocket()) fs.unlinkSync(opts.pipe);
      releaseLock();
      finish();
    })();
    return closing;
  };

  const requests = { start: 0, count: 0 };
  /** Fixed-window budget on requests that reach the outbox lookup. Over REQUEST_BUDGET per window, the reply is refused. */
  function admitRequest(): boolean {
    const t = now();
    if (t < requests.start || t - requests.start >= REQUEST_WINDOW_MS) {
      requests.start = t;
      requests.count = 0;
    }
    if (requests.count >= REQUEST_BUDGET) return false;
    requests.count++;
    return true;
  }

  /**
   * Outbound cap while no peers.json has loaded in this process. The validator only accepts caps of at least 1, so a
   * restart with an invalid file can never raise an established cap.
   */
  const UNLOADED_OUT_PER_HOUR = 1;
  /** Policy from the last peers.json that loaded in this process. Undefined until one has. */
  let peersNow: Peers | undefined;
  /** Loads peers.json for this send. An invalid file keeps the last good policy; the peer id is never logged. */
  function currentPeers(): Peers | undefined {
    try {
      peersNow = loadPeers(opts.peersFile, opts.peersOwnerUid);
    } catch (error) {
      limited('outbox.peers-invalid', { code: safeCode(error) });
    }
    return peersNow;
  }

  async function processRequest(frame: Buffer): Promise<void> {
    const itemId = parseRequest(frame);
    if (!admitRequest()) throw new Refusal('busy');
    if (lstatOrUndefined(opts.outboxRoot)?.isDirectory() !== true) throw new Refusal('root-unsafe');
    const found = findItem(opts.outboxRoot, itemId);
    // One read: the bytes checked, hashed, and sent are the same buffer.
    const raw = readItemFile(found.file);
    const item = parseItem(raw, itemId, found.peer);
    const digest = itemHash(item);
    if (digest !== item.approvedSha256) throw new Refusal('hash-mismatch');
    const approved = readLedger(opts.outboxRoot, itemId);
    if (approved === undefined) throw new Refusal('not-approved');
    if (approved !== digest) throw new Refusal('hash-mismatch');

    const profile = loadNow();
    const peers = currentPeers();
    const peer = Object.hasOwn(profile.peers, item.to) ? profile.peers[item.to] : undefined;
    if (peer?.status !== 'paired') throw new Refusal('unpaired-peer');
    if (!textOk(item.text, item.subject)) throw new Refusal('invalid-text');
    if (recordedState(opts.sentDir, item.itemId) === 'uncertain') throw new Refusal('uncertain');
    const outPerHour = peers === undefined ? UNLOADED_OUT_PER_HOUR : policyOf(peers, item.to).outPerHour;
    checkRate(opts.sentDir, item.to, outPerHour, now());
    if (dryRun) throw new Refusal('dry-run');

    const marker = `${JSON.stringify({ v: 1, peer: item.to, at: new Date(now()).toISOString() })}\n`;
    if (!writeNew(opts.sentDir, item.itemId, marker, 0o600)) throw new Refusal('already-used');

    const input: SendInput = {
      which: item.thread === null ? 'new' : 'thread',
      threadId: item.thread ?? ulid(),
      subject: item.subject,
      text: item.text,
      intent: 'request',
      asks: [],
      constraints: [],
      inReplyTo: null,
      referenceTaskIds: [],
    };
    let sent: { messageId: string };
    try {
      sent = await send(profile, item.to, input);
    } catch (error) {
      recordResult(opts.sentDir, item.itemId, 'failed', undefined, now(), limited);
      limited('outbox.send-failed', { code: safeCode(error) });
      throw new Refusal('send-failed');
    }
    recordResult(opts.sentDir, item.itemId, 'sent', sent.messageId, now(), limited);
  }

  function refusal(code: RefusalCode): string {
    limited('outbox.refused', { code });
    return `refused:${code}`;
  }

  async function serveRequest(frame: Buffer): Promise<string> {
    try {
      await processRequest(frame);
      return 'ok';
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.code);
      limited('outbox.internal', { code: safeCode(error) });
      return 'refused:internal';
    }
  }

  function respond(socket: net.Socket, reply: string): void {
    if (socket.destroyed) return;
    socket.end(`${reply}\n`);
    // The client closes after the reply. A connection that stays open is dropped after the idle timeout.
    socket.setTimeout(PIPE_TIMEOUT_MS, () => socket.destroy());
  }

  /**
   * Queues a request behind the one in progress. A malformed frame is refused at once and never queued. A queued request is
   * refused, not served, if any byte arrived on its connection after the frame.
   */
  function enqueue(socket: net.Socket, frame: Buffer | undefined, sawExtraBytes: () => boolean): void {
    if (frame === undefined) {
      respond(socket, refusal('bad-request'));
      return;
    }
    if (pending >= MAX_PENDING) {
      respond(socket, refusal('busy'));
      return;
    }
    pending++;
    chain = chain.then(async () => {
      pending--;
      respond(socket, sawExtraBytes() ? refusal('bad-request') : await serveRequest(frame));
    });
  }

  function accept(socket: net.Socket): void {
    if (open >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    open++;
    socket.on('error', (error) => limited('outbox.socket-error', { code: safeCode(error) }));
    socket.on('close', () => {
      open--;
      if (once) void close();
    });
    let received = Buffer.alloc(0);
    let decided = false;
    let extraBytes = false;
    const decide = (frame: Buffer | undefined): void => {
      decided = true;
      enqueue(socket, frame, () => extraBytes);
    };
    socket.setTimeout(PIPE_TIMEOUT_MS, () => {
      if (!decided && received.length > 0) decide(undefined);
      else socket.destroy();
    });
    // The frame is decided at its first newline or at end of stream. Bytes after the decision never change the frame; they
    // mark the connection, and a request still queued when they arrive is refused without a send.
    const onData = (chunk: Buffer): void => {
      if (decided) {
        extraBytes = true;
        return;
      }
      if (received.length + chunk.length > MAX_REQUEST_BYTES + 1) {
        decide(undefined);
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline === -1) return;
      decide(newline === received.length - 1 ? received.subarray(0, newline) : undefined);
    };
    const onEnd = (): void => {
      if (decided) return;
      if (received.length === 0) socket.destroy();
      else decide(received);
    };
    socket.on('data', onData);
    socket.on('end', onEnd);
  }

  return { close, done };
}

function configValue(args: ParsedArgs, flag: string, env: string, usage: string, fallback?: string): string {
  const value = args.get(flag) ?? process.env[env] ?? fallback;
  if (value === undefined || value === 'true' || value === '') {
    throw new CourierError('usage', `--${flag} (or ${env}) must be set.\n${usage}`);
  }
  return value;
}

async function cmdOutboxServe(args: ParsedArgs): Promise<void> {
  const base = profileDir();
  const handle = await startOutbox({
    outboxRoot: configValue(args, 'outbox-dir', 'COURIER_OUTBOX_DIR', SERVE_USAGE),
    pipe: configValue(args, 'pipe', 'COURIER_OUTBOX_PIPE', SERVE_USAGE),
    socketGroup: configValue(args, 'socket-group', 'COURIER_OUTBOX_SOCKET_GROUP', SERVE_USAGE, DEFAULT_SOCKET_GROUP),
    peersFile: args.get('peers-file') ?? path.join(base, 'intake', 'peers.json'),
    peersOwnerUid: resolvePeersOwner(args.get('peers-owner'), process.env.COURIER_PEERS_OWNER),
    sentDir: args.get('sent-dir') ?? path.join(base, 'outbox-sent'),
    once: args.has('once'),
    dryRun: args.has('dry-run'),
  });
  const stop = (): void => {
    void handle.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await handle.done;
}

/** Peer outbox directory: setgid and group-readable (2750). Created once; an existing real directory is accepted. */
export function ensurePeerDir(root: string, peerId: string): string {
  const peerDir = path.join(root, peerId);
  const existing = lstatOrUndefined(peerDir);
  if (existing === undefined) {
    try {
      fs.accessSync(root, fs.constants.W_OK);
    } catch {
      throw new CourierError('outbox-not-writable', 'outbox root is not writable by this user');
    }
    fs.mkdirSync(peerDir, 0o2750);
    fs.chmodSync(peerDir, 0o2750);
    fsyncDir(root);
  } else if (!existing.isDirectory()) {
    throw new CourierError('root-unsafe', 'peer outbox path is not a real directory');
  }
  return peerDir;
}

/**
 * Publishes `dir/<itemId>.json` with its full body: written to a same-directory `.tmp-` file, fsynced, hard-linked into
 * place, and the directory fsynced. A reader only ever sees the final name with a complete file. Returns false if that
 * name already exists.
 */
export function publishItem(dir: string, itemId: string, body: string): boolean {
  const temp = path.join(dir, `.tmp-${randomBytes(9).toString('hex')}`);
  const fd = fs.openSync(temp, 'wx', ITEM_MODE);
  try {
    fs.writeFileSync(fd, body);
    fs.fchmodSync(fd, ITEM_MODE);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.linkSync(temp, path.join(dir, `${itemId}.json`));
    fsyncDir(dir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Approval ledger directory under the outbox root (0700). */
function ensureLedgerDir(root: string): string {
  const dir = path.join(root, APPROVED_DIR);
  if (ensureRealDir(dir, 0o700)) fsyncDir(root);
  return dir;
}

function cmdOutboxAdd(args: ParsedArgs): void {
  const peerId = args.positional[0];
  if (peerId === undefined || !PEER_RE.test(peerId) || peerId === APPROVED_DIR) throw new CourierError('usage', ADD_USAGE);
  const which = oneOf(args, ['thread', 'new']);
  const thread = which === 'thread' ? requireFlag(args, 'thread', ADD_USAGE) : null;
  if (thread !== null && !ULID_RE.test(thread)) throw new CourierError('usage', ADD_USAGE);
  const subject = which === 'new' ? requireFlag(args, 'new', ADD_USAGE) : undefined;
  const text = readTextArg(args, ADD_USAGE);
  if (!textOk(text, subject)) {
    throw new CourierError('invalid-text', 'text must be 1..2000 characters; subject at most 200 characters');
  }

  const peer = getPeer(loadProfile(), peerId);
  if (peer.status !== 'paired') throw new CourierError('unpaired-peer', `peer ${peerId} is not paired`);

  const root = configValue(args, 'outbox-dir', 'COURIER_OUTBOX_DIR', ADD_USAGE);
  if (lstatOrUndefined(root)?.isDirectory() !== true) {
    throw new CourierError('root-unsafe', 'outbox root must be an existing real directory');
  }
  const itemId = ulid();
  const body = { v: 1, itemId, to: peerId, thread, ...(subject === undefined ? {} : { subject }), text };
  const approvedSha256 = itemHash(body);
  const item = { ...body, approvedSha256 };

  const peerDir = ensurePeerDir(root, peerId);
  // The ledger entry is created first: an item without one is never sent, so a crash between the two writes is harmless.
  if (!writeNew(ensureLedgerDir(root), itemId, `${approvedSha256}\n`, ITEM_MODE)) {
    throw new CourierError('exists', 'item id collision; retry');
  }
  if (!publishItem(peerDir, itemId, `${canonicalJson(item)}\n`)) {
    throw new CourierError('exists', 'item id collision; retry');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, itemId, peer: peerId }, null, 2)}\n`);
}

export async function cmdOutbox(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  const rest: ParsedArgs = { ...args, positional: args.positional.slice(1) };
  if (action === 'add') return cmdOutboxAdd(rest);
  if (action === 'serve') return cmdOutboxServe(rest);
  throw new CourierError('usage', OUTBOX_USAGE);
}
