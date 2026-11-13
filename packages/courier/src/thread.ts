import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { messageView, oneLine, taskView } from './a2a.js';
import type { KV } from './inbox.js';
import { agentId, k, PREFIX } from './keys.js';
import { mkdirOwnerOnly, profileDir, readRegularFile, writeSecure, type StoredPeer } from './profile.js';
import { getJson, listAll } from './store.js';
import { ULID } from './request.js';

const SAFE_ID = /^[0-9A-Za-z_-]{1,64}$/;
/** All of one agent's cached threads together, in bytes as written. */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 7 * 24 * 3600_000;
/** How long `courier read` uses its local record of this agent's own writes to a thread before listing them again. */
const OWN_INDEX_TRUST_MS = 3600_000;

/** Bodies of create-only thread entries (messages and meta) already read, by source identity and key. */
export interface ThreadCache {
  get(id: string): unknown;
  set(id: string, body: unknown): void;
}

const cacheRoot = () => path.join(profileDir(), 'read-cache');

let preparedRoot: string | undefined;

/**
 * Once per process: the cache directories are owner-only (0700) even if an earlier run left them looser, and thread
 * files from before the cache was per agent (`read-cache/<thread ULID>.json`) are deleted; nothing else at the root is.
 * Modes are set through a descriptor opened without following a symlink, so a directory swapped for a link between the
 * check and the change is never changed. Other users' entries are left alone.
 */
function prepareCacheRoot(): void {
  const root = cacheRoot();
  if (preparedRoot === root) return;
  preparedRoot = root;
  if (!ownerOnlyDir(root)) return;
  for (const name of fs.readdirSync(root)) {
    const entry = path.join(root, name);
    const child = fs.lstatSync(entry);
    if (child.uid !== process.getuid?.()) continue;
    if (child.isFile() && name.endsWith('.json') && ULID.test(name.slice(0, -5))) fs.rmSync(entry, { force: true });
    else if (child.isDirectory()) ownerOnlyDir(entry);
  }
}

/** Sets a directory of this user to 0700 through a no-follow descriptor; false for a symlink, a non-directory or another user's. */
function ownerOnlyDir(dir: string): boolean {
  let fd: number;
  try { fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); } catch { return false; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) return false;
    if ((stat.mode & 0o777) !== 0o700) fs.fchmodSync(fd, 0o700);
    return true;
  } finally { fs.closeSync(fd); }
}

/**
 * `read-cache/<parts…>` as a chain of real directories of this user, created 0700 where missing (`create`). A component
 * that is a symlink, not a directory or another user's gives undefined: nothing is read or written through it.
 */
function cacheDir(parts: readonly string[], create: boolean): string | undefined {
  if (create) mkdirOwnerOnly(profileDir());
  let dir = cacheRoot();
  for (const part of ['', ...parts]) {
    if (part) dir = path.join(dir, part);
    if (create) {
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined; }
    }
    let stat: fs.Stats;
    try { stat = fs.lstatSync(dir); } catch { return undefined; }
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) return undefined;
  }
  return dir;
}

/** The bounds of one agent's read cache; tests pass smaller ones. */
export interface CacheLimits { now: number; maxBytes: number; maxAgeMs: number }

/** A cached thread file is used only while it is a regular file of this user written within the age bound. */
function fresh(file: string, limits: CacheLimits): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.uid === process.getuid?.() && limits.now - stat.mtimeMs < limits.maxAgeMs;
  } catch { return false; }
}

/** Keeps the agent's newest thread files within the byte bound and drops any older than the age bound. */
function prune(dir: string, limits: CacheLimits): void {
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    return { file, mtime: stat.mtimeMs, bytes: stat.size, keep: stat.isFile() && limits.now - stat.mtimeMs < limits.maxAgeMs };
  }).sort((a, b) => b.mtime - a.mtime);
  let total = 0;
  for (const entry of files) {
    total += entry.bytes;
    if (!entry.keep || total > limits.maxBytes) fs.rmSync(entry.file, { force: true });
  }
}

/**
 * `courier read`'s private cache of one thread, per agent (`<COURIER_HOME>/read-cache/<did:key id>/<thread>.json`,
 * owner-only): messages and meta are create-only, so a repeated read fetches only entries it has not read yet. Tasks
 * change and are always fetched. A missing, foreign, expired (7 days) or corrupt file is an empty cache; the agent's
 * files stay within 64 MiB together, oldest dropped first. `full` starts empty: everything is fetched again and kept.
 */
export function diskThreadCache(agent: string, threadId: string,
  limits: CacheLimits = { now: Date.now(), maxBytes: CACHE_MAX_BYTES, maxAgeMs: CACHE_MAX_AGE_MS }, full = false): ThreadCache & { save(): void } {
  prepareCacheRoot();
  const dir = path.join(cacheRoot(), agentId(agent));
  const file = path.join(dir, `${threadId}.json`);
  let entries: Record<string, unknown> = {};
  if (!full && SAFE_ID.test(threadId) && fresh(file, limits)) {
    try {
      const parsed: unknown = JSON.parse(readRegularFile(file) ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = parsed as Record<string, unknown>;
    } catch { /* an unreadable cache is rebuilt */ }
  }
  let changed = false;
  return {
    get: (id) => Object.hasOwn(entries, id) ? entries[id] : undefined,
    set: (id, body) => { entries[id] = body; changed = true; },
    save() {
      if (!changed || !SAFE_ID.test(threadId)) return;
      if (cacheDir([agentId(agent)], true) !== dir) return;
      // writeSecure writes pretty JSON and a newline.
      if (Buffer.byteLength(JSON.stringify(entries, null, 2)) + 1 > limits.maxBytes) fs.rmSync(file, { force: true });
      else writeSecure(file, entries);
      prune(dir, limits);
    },
  };
}

/** Revocation, refusal, peer removal or a new agent key: every cached counterparty body on this machine goes. */
export function clearReadCache(): void {
  fs.rmSync(cacheRoot(), { recursive: true, force: true });
  preparedRoot = undefined;
}

const ownParts = (agent: string, threadId: string) => [agentId(agent), 'own', threadId];
const ownDir = (agent: string, threadId: string) => path.join(cacheRoot(), ...ownParts(agent, threadId));
const ownName = (prefix: string, spaceId: string, key: string) => `${prefix}-${createHash('sha256').update(`${spaceId}\n${key}`).digest('hex')}.json`;

/**
 * Records one key this agent created under its own thread root, after the write succeeded (`send`, the outbox, a pause
 * inform, a task, a session's meta). One file per entry, so concurrent writers never lose each other's records. It never
 * fails the write: if the record can't be written, the thread's listing marks are dropped so the next read lists again.
 */
export function recordOwnWrite(agent: string, spaceId: string | undefined, threadId: string, key: string): void {
  if (!SAFE_ID.test(threadId) || !spaceId) return;
  let dir: string;
  try { dir = ownDir(agent, threadId); } catch { return; } // no did:key: this agent has no read cache at all
  try {
    prepareCacheRoot();
    if (cacheDir(ownParts(agent, threadId), true) !== dir) throw new Error('unsafe cache directory');
    writeSecure(path.join(dir, ownName('e', spaceId, key)), { space: spaceId, key });
  } catch {
    try {
      if (cacheDir(ownParts(agent, threadId), false) !== dir) return; // no safe directory: no listing marks to trust
      for (const name of fs.readdirSync(dir)) if (name.startsWith('listed-')) fs.rmSync(path.join(dir, name), { force: true });
    } catch { /* no listing marks: the next read lists anyway */ }
  }
}

/** This agent's own entries of one thread, per thread root: from its local record while a listing is under an hour old. */
export interface OwnIndex {
  /** The keys under `root`, or undefined when the root must be listed. */
  keys(root: string): string[] | undefined;
  /** A listing of `root` just returned `keys`: they are recorded, then the listing is marked as current. */
  listed(root: string, keys: readonly string[]): void;
}

export function diskOwnIndex(agent: string, spaceId: string, threadId: string, full = false, now = Date.now()): OwnIndex {
  const dir = ownDir(agent, threadId);
  const uid = process.getuid?.();
  const regular = (file: string) => {
    try { const stat = fs.lstatSync(file); return stat.isFile() && stat.uid === uid ? stat : undefined; } catch { return undefined; }
  };
  return {
    keys(root) {
      if (full || !SAFE_ID.test(threadId) || cacheDir(ownParts(agent, threadId), false) !== dir) return undefined;
      let listedAt: number;
      try {
        const file = path.join(dir, ownName('listed', spaceId, root));
        if (!regular(file)) return undefined;
        const mark: unknown = JSON.parse(readRegularFile(file) ?? 'null');
        if (!mark || typeof mark !== 'object') return undefined;
        const { space, root: markRoot, listedAt: at } = mark as { space?: unknown; root?: unknown; listedAt?: unknown };
        if (space !== spaceId || markRoot !== root || typeof at !== 'string') return undefined;
        listedAt = Date.parse(at);
      } catch { return undefined; }
      if (!(now - listedAt >= 0 && now - listedAt < OWN_INDEX_TRUST_MS)) return undefined;
      const keys: string[] = [];
      try {
        for (const name of fs.readdirSync(dir)) {
          if (!name.startsWith('e-')) continue;
          const file = path.join(dir, name);
          const stat = regular(file);
          if (!stat) continue;
          // Every listing re-records what it saw, so an entry this old is from before the current listing mark.
          if (now - stat.mtimeMs >= CACHE_MAX_AGE_MS) { fs.rmSync(file, { force: true }); continue; }
          const entry: unknown = JSON.parse(readRegularFile(file) ?? 'null');
          if (!entry || typeof entry !== 'object') return undefined;
          const { space, key } = entry as { space?: unknown; key?: unknown };
          if (typeof key !== 'string' || typeof space !== 'string') return undefined;
          if (space === spaceId && key.startsWith(`${root}/`)) keys.push(key);
        }
      } catch { return undefined; }
      return keys.sort();
    },
    listed(root, keys) {
      if (!SAFE_ID.test(threadId)) return;
      try {
        prepareCacheRoot();
        if (cacheDir(ownParts(agent, threadId), true) !== dir) return;
        for (const key of keys) if (key.startsWith(`${root}/`)) writeSecure(path.join(dir, ownName('e', spaceId, key)), { space: spaceId, key });
        writeSecure(path.join(dir, ownName('listed', spaceId, root)), { space: spaceId, root, listedAt: new Date(now).toISOString() });
      } catch { /* without a mark, the next read lists again */ }
    },
  };
}

export interface ThreadEntry {
  peer?: string;
  kind: 'meta' | 'msg' | 'task';
  id: string;
  side: 'me' | 'peer';
  authority: 'self' | 'counterparty';
  body: unknown;
  invalid?: string[];
}

export interface PeerReadError {
  peer: string;
  code?: unknown;
  message: string;
}

export function peerReadError(peer: string): PeerReadError {
  return { peer, code: 'peer-read-failed', message: `Couldn't read messages from ${oneLine(peer, 80)}.` };
}

export function partialReadText(source: 'Thread' | 'Inbox', errors: readonly PeerReadError[]): string {
  if (!errors.length) return '';
  const peers = [...new Set(errors.map(error => oneLine(error.peer, 80)))].join(', ');
  return `${source} may be incomplete: couldn't read messages from ${peers}. Try again later.\n`;
}

/** Resolves from our own records first; peer-controlled data never establishes a thread's peer. No writes. */
export async function collectThread(input: {
  threadId: string;
  selfKv: KV;
  peers: StoredPeer[];
  exactPeer?: boolean;
  kvFor(peer: StoredPeer): Promise<KV>;
  cache?: ThreadCache;
  /** This agent's record of its own entries: while current, our own thread root isn't listed. */
  own?: OwnIndex;
  /** This agent's courier DID and space: cached own entries belong to them, so a re-init or a new key starts empty. */
  self?: { courierDid: string; spaceId: string };
}): Promise<{ entries: ThreadEntry[]; errors: PeerReadError[]; partial: boolean }> {
  const { threadId, selfKv } = input;
  const entries: ThreadEntry[] = [];
  const errors: PeerReadError[] = [];
  const eligible = input.peers.filter(peer =>
    (peer.status === 'paired' || peer.status === 'awaiting-C') && (!peer.sessionId || peer.sessionId === threadId));
  const sessions = eligible.filter(peer => peer.sessionId === threadId);
  let peers = input.exactPeer || !sessions.length ? eligible : sessions;
  const local = new Map<string, string[]>();
  if (!input.exactPeer && !sessions.length) {
    const known: StoredPeer[] = [];
    for (const peer of peers) {
      // Failure of our own listing cannot safely be interpreted as an absent mapping.
      const mine = await listAll(selfKv, `${k.threadRoot(peer.handle, threadId)}/`);
      local.set(peer.handle, mine);
      input.own?.listed(k.threadRoot(peer.handle, threadId), mine);
      const mirrored = await listAll(selfKv, `${PREFIX}/me/mirror/${peer.handle}/threads/${threadId}/`);
      if (mine.length || mirrored.length) known.push(peer);
    }
    if (known.length) peers = known;
  }

  /**
   * `source`: whose space the keys are in (none: not cached). A cached body is used only for a key the current,
   * authorized listing returned, or, for our own entries, that our own record holds.
   */
  async function append(kv: KV, keys: string[], peer: string, side: 'me' | 'peer', source: string | undefined) {
    const root = side === 'me' ? k.threadRoot(peer, threadId) : undefined;
    for (const key of keys) {
      if (root && !key.startsWith(`${root}/`)) continue;
      const kind = key.endsWith('/meta.json') ? 'meta'
        : /\/msg\/[^/]+\.json$/.test(key) ? 'msg'
        : /\/task\/[^/]+\.json$/.test(key) ? 'task' : undefined;
      if (!kind) continue;
      const cacheId = kind === 'task' || !source ? undefined : `${source}:${key}`;
      const cached = cacheId === undefined ? undefined : input.cache?.get(cacheId);
      const got = cached !== undefined ? { value: cached } : await getJson(kv, key);
      if (!got) continue;
      if (cacheId !== undefined && cached === undefined) input.cache?.set(cacheId, got.value);
      const id = kind === 'meta' ? threadId : key.slice(key.lastIndexOf('/') + 1, -5);
      const invalid = kind === 'msg' ? messageView(got.value).invalid : kind === 'task' ? taskView(got.value).invalid : [];
      entries.push({ peer, kind, id, side, authority: side === 'me' ? 'self' : 'counterparty', body: got.value,
        ...(invalid.length ? { invalid } : {}) });
    }
  }

  for (const peer of peers) {
    const root = k.threadRoot(peer.handle, threadId);
    let mine = local.get(peer.handle) ?? input.own?.keys(root);
    if (mine === undefined) {
      mine = await listAll(selfKv, `${root}/`);
      input.own?.listed(root, mine);
    }
    await append(selfKv, mine, peer.handle, 'me', input.self && `self:${input.self.courierDid}:${input.self.spaceId}`);
    if (!peer.inbound || !peer.theirHandleForMe) continue;
    try {
      const kv = await input.kvFor(peer);
      const prefix = `${k.threadRoot(peer.theirHandleForMe, threadId)}/`;
      const keys = (await listAll(kv, prefix)).filter(key => key.startsWith(prefix));
      // Bound to the peer's identity, space and session, not its local handle: a handle re-paired to someone else, or a
      // new session, starts empty.
      await append(kv, keys, peer.handle, 'peer', `peer:${peer.courierDid}:${peer.spaceId}:${peer.sessionId ?? ''}`);
    } catch {
      errors.push(peerReadError(peer.handle));
    }
  }
  entries.sort((a, b) => a.id === b.id ? a.kind.localeCompare(b.kind) : a.id < b.id ? -1 : 1);
  return { entries, errors, partial: errors.length > 0 };
}
