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
import { requestHash } from './canonical.js';
import { CourierError, errInfo } from './errors.js';
import { cmd } from './program.js';
import { courierNode } from './node.js';
import { getPeer, loadProfile, profileDir } from './profile.js';
import type { Profile } from './profile.js';
import { loadPeers, policyOf } from './intake/peers.js';
import { acquireLock, ensureRealDir, writeNew, writeReplace } from './intake/queue.js';
import { textVerdict } from './text.js';
import { jsonLineLog } from './wake.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PEER_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REQUEST_BYTES = 256;
const MAX_ITEM_BYTES = 32 * 1024;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const PIPE_TIMEOUT_MS = 5000;
const DEFAULT_SOCKET_GROUP = 'courier-sender';
const DENIED_SOCKET_GROUPS = ['tinycloud', 'tinycloud-dev', 'sudo', 'docker'];
const SERVE_LOCK = 'serve.lock';
const ITEM_KEYS = ['v', 'itemId', 'to', 'thread', 'subject', 'text', 'approvedSha256'];

/** The only refusal codes the sender can reply with. Replies never carry item ids, paths, text, or error messages. */
export const REFUSAL_CODES = [
  'bad-request', 'not-found', 'ambiguous-item', 'unsafe-item', 'bad-item', 'hash-mismatch',
  'unpaired-peer', 'invalid-text', 'rate-limited', 'already-used', 'send-failed', 'dry-run',
  'root-unsafe', 'internal',
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
const SERVE_USAGE = `Usage: ${cmd('outbox serve --pipe <socket> [--outbox-dir d] [--socket-group g] [--peers-file f] [--sent-dir d] [--once] [--dry-run]')}`;
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

/** Hash over the item without its own approvedSha256 field. Shared by `outbox add` and the sender. */
function itemHash(item: object): string {
  return requestHash(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'approvedSha256')));
}

function textOk(text: string, subject: string | undefined): boolean {
  if (!textVerdict(text, 'multiline').allowed) return false;
  return subject === undefined || textVerdict(subject, 'summary').allowed;
}

/** Parses the sender request. Runs before any filesystem access. */
function parseRequest(line: string): string {
  if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) throw new Refusal('bad-request');
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    throw new Refusal('bad-request');
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new Refusal('bad-request');
  const fields = request as Record<string, unknown>;
  const keys = Object.keys(fields).sort().join(',');
  if (keys !== 'itemId,v' || fields.v !== 1 || typeof fields.itemId !== 'string' || !ULID_RE.test(fields.itemId)) {
    throw new Refusal('bad-request');
  }
  return fields.itemId;
}

/** Finds the one item file across peer directories. Symlinked peer directories are skipped. */
function findItem(root: string, itemId: string): { peer: string; file: string } {
  const hits: { peer: string; file: string }[] = [];
  for (const entry of fs.readdirSync(root)) {
    const dir = path.join(root, entry);
    if (lstatOrUndefined(dir)?.isDirectory() !== true) continue;
    const file = path.join(dir, `${itemId}.json`);
    if (lstatOrUndefined(file) !== undefined) hits.push({ peer: entry, file });
  }
  if (hits.length === 0) throw new Refusal('not-found');
  if (hits.length > 1) throw new Refusal('ambiguous-item');
  return hits[0] as { peer: string; file: string };
}

/** Reads a regular, owner-only-writable item file without following symlinks. */
function readItemFile(file: string): string {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new Refusal('unsafe-item');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== ownerUid() || (st.mode & 0o022) !== 0) throw new Refusal('unsafe-item');
    const buf = Buffer.alloc(MAX_ITEM_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_ITEM_BYTES) throw new Refusal('bad-item');
    return buf.subarray(0, n).toString('utf8');
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

function parseItem(raw: string, itemId: string, peer: string): OutboxItem {
  let value: unknown;
  try {
    value = JSON.parse(raw);
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

/** Counts single-use markers for this peer in the rolling hour. An unreadable marker fails closed. */
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
function recordResult(sentDir: string, itemId: string, state: 'sent' | 'failed', messageId: string | undefined, now: number, log: OutboxLog): void {
  const body = JSON.stringify({ v: 1, state, at: new Date(now).toISOString(), messageId });
  try {
    writeReplace(sentDir, `${itemId}.result.json`, `${body}\n`, 0o600);
  } catch (error) {
    log('outbox.result-write-failed', { code: errInfo(error).code ?? null });
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
 * Starts the sender pipe. One request line per connection; one reply line (`ok` or `refused:<code>`); requests are
 * handled one at a time. A connection that sends nothing for PIPE_TIMEOUT_MS is dropped without a reply.
 */
export async function startOutbox(opts: OutboxOptions): Promise<OutboxHandle> {
  const log: OutboxLog = opts.log ?? jsonLineLog();
  const now = opts.now ?? Date.now;
  const loadNow = opts.loadProfile ?? loadProfile;
  const send = opts.send ?? nodeSender();
  const gidOf = opts.groups ?? groupGid;
  const dryRun = opts.dryRun ?? false;
  const once = opts.once ?? false;

  ensureRealDir(opts.sentDir, 0o700);
  const releaseLock = acquireLock(path.join(opts.sentDir, SERVE_LOCK));
  const server = net.createServer(accept);
  try {
    const gid = checkSocketDir(path.dirname(opts.pipe), opts.socketGroup, gidOf);
    const stale = lstatOrUndefined(opts.pipe);
    if (stale !== undefined) {
      if (!stale.isSocket()) throw new CourierError('unsafe-pipe', 'pipe path exists and is not a socket');
      fs.unlinkSync(opts.pipe);
    }
    await listen(server, opts.pipe);
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
  log('outbox.listening', { once, dryRun });

  let chain: Promise<void> = Promise.resolve();
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

  async function processRequest(line: string): Promise<void> {
    const itemId = parseRequest(line);
    if (lstatOrUndefined(opts.outboxRoot)?.isDirectory() !== true) throw new Refusal('root-unsafe');
    const found = findItem(opts.outboxRoot, itemId);
    const item = parseItem(readItemFile(found.file), itemId, found.peer);
    if (itemHash(item) !== item.approvedSha256) throw new Refusal('hash-mismatch');

    const profile = loadNow();
    const peers = loadPeers(opts.peersFile, log);
    const peer = Object.hasOwn(profile.peers, item.to) ? profile.peers[item.to] : undefined;
    if (peer?.status !== 'paired') throw new Refusal('unpaired-peer');
    if (!textOk(item.text, item.subject)) throw new Refusal('invalid-text');
    checkRate(opts.sentDir, item.to, policyOf(peers, item.to).outPerHour, now());
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
      recordResult(opts.sentDir, item.itemId, 'failed', undefined, now(), log);
      log('outbox.send-failed', { code: errInfo(error).code ?? null });
      throw new Refusal('send-failed');
    }
    recordResult(opts.sentDir, item.itemId, 'sent', sent.messageId, now(), log);
  }

  async function serveRequest(line: string): Promise<string> {
    try {
      await processRequest(line);
      return 'ok';
    } catch (error) {
      if (error instanceof Refusal) {
        log('outbox.refused', { code: error.code });
        return `refused:${error.code}`;
      }
      log('outbox.internal', { code: errInfo(error).code ?? null });
      return 'refused:internal';
    }
  }

  function accept(socket: net.Socket): void {
    socket.setTimeout(PIPE_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', (error) => log('outbox.socket-error', { code: errInfo(error).code ?? null }));
    socket.on('close', () => {
      if (once) void close();
    });
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline === -1 && received.length <= MAX_REQUEST_BYTES) return;
      socket.removeListener('data', onData);
      // Bytes after the first newline are ignored; the request is the first line only.
      const line = newline === -1 || newline > MAX_REQUEST_BYTES ? undefined : received.subarray(0, newline).toString('utf8');
      chain = chain.then(async () => {
        const reply = line === undefined ? 'refused:bad-request' : await serveRequest(line);
        if (!socket.destroyed) socket.end(`${reply}\n`);
      });
    };
    socket.on('data', onData);
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
  } else if (!existing.isDirectory()) {
    throw new CourierError('root-unsafe', 'peer outbox path is not a real directory');
  }
  return peerDir;
}

/** Mode of a published item: owner and group read, nothing for others. */
const ITEM_MODE = 0o640;

/**
 * Publishes `dir/<itemId>.json` with its full body: written to a same-directory `.tmp-` file, fsynced, then hard-linked
 * into place. A reader only ever sees the final name with a complete file. Returns false if that name already exists.
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
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function cmdOutboxAdd(args: ParsedArgs): void {
  const peerId = args.positional[0];
  if (peerId === undefined || !PEER_RE.test(peerId)) throw new CourierError('usage', ADD_USAGE);
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
  const item = { ...body, approvedSha256: itemHash(body) };

  const peerDir = ensurePeerDir(root, peerId);
  if (!publishItem(peerDir, itemId, `${JSON.stringify(item, null, 2)}\n`)) {
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
