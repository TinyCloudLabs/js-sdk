import fs from 'node:fs';
import path from 'node:path';
import { messageView, oneLine, taskView } from './a2a.js';
import type { KV } from './inbox.js';
import { k, PREFIX } from './keys.js';
import { profileDir, readRegularFile, writeSecure, type StoredPeer } from './profile.js';
import { getJson, listAll } from './store.js';

const SAFE_ID = /^[0-9A-Za-z_-]{1,64}$/;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

/** Bodies of create-only thread entries (messages and meta) already read, by side, peer and key. */
export interface ThreadCache {
  get(id: string): unknown;
  set(id: string, body: unknown): void;
}

/**
 * `courier read`'s private cache of one thread (`<COURIER_HOME>/read-cache/<thread>.json`, owner-only): messages and meta
 * are create-only, so a repeated read fetches only entries it has not read yet. Tasks change and are always fetched.
 * A missing, foreign or corrupt file is an empty cache.
 */
export function diskThreadCache(threadId: string): ThreadCache & { save(): void } {
  const dir = path.join(profileDir(), 'read-cache');
  const file = path.join(dir, `${threadId}.json`);
  let entries: Record<string, unknown> = {};
  if (SAFE_ID.test(threadId)) {
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
      if (!changed || !SAFE_ID.test(threadId) || JSON.stringify(entries).length > MAX_CACHE_BYTES) return;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(dir).isDirectory()) return;
      writeSecure(file, entries);
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
      const mirrored = await listAll(selfKv, `${PREFIX}/me/mirror/${peer.handle}/threads/${threadId}/`);
      if (mine.length || mirrored.length) known.push(peer);
    }
    if (known.length) peers = known;
  }

  /** `source`: whose space the keys are in. A cached body is used only for a key the current, authorized listing returned. */
  async function append(kv: KV, keys: string[], peer: string, side: 'me' | 'peer', source: string) {
    const root = side === 'me' ? k.threadRoot(peer, threadId) : undefined;
    for (const key of keys) {
      if (root && !key.startsWith(`${root}/`)) continue;
      const kind = key.endsWith('/meta.json') ? 'meta'
        : /\/msg\/[^/]+\.json$/.test(key) ? 'msg'
        : /\/task\/[^/]+\.json$/.test(key) ? 'task' : undefined;
      if (!kind) continue;
      const cacheId = kind === 'task' ? undefined : `${source}:${key}`;
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
    const mine = local.get(peer.handle) ?? await listAll(selfKv, `${k.threadRoot(peer.handle, threadId)}/`);
    await append(selfKv, mine, peer.handle, 'me', 'self');
    if (!peer.inbound || !peer.theirHandleForMe) continue;
    try {
      const kv = await input.kvFor(peer);
      const prefix = `${k.threadRoot(peer.theirHandleForMe, threadId)}/`;
      const keys = (await listAll(kv, prefix)).filter(key => key.startsWith(prefix));
      // Bound to the peer's identity and space, not its local handle: a handle re-paired to someone else starts empty.
      await append(kv, keys, peer.handle, 'peer', `peer:${peer.courierDid}:${peer.spaceId}`);
    } catch {
      errors.push(peerReadError(peer.handle));
    }
  }
  entries.sort((a, b) => a.id === b.id ? a.kind.localeCompare(b.kind) : a.id < b.id ? -1 : 1);
  return { entries, errors, partial: errors.length > 0 };
}
