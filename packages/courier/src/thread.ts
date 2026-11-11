import { messageView, oneLine, taskView } from './a2a.js';
import type { KV } from './inbox.js';
import { k, PREFIX } from './keys.js';
import type { StoredPeer } from './profile.js';
import { getJson, listAll } from './store.js';

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
  return { peer, code: 'peer-read-failed', message: `Couldn't read messages from ${oneLine(peer)}.` };
}

export function partialReadText(source: 'Thread' | 'Inbox', errors: readonly PeerReadError[]): string {
  if (!errors.length) return '';
  const peers = [...new Set(errors.map(error => oneLine(error.peer)))].join(', ');
  return `${source} may be incomplete: couldn't read messages from ${peers}. Try again later.\n`;
}

/** Resolves from our own records first; peer-controlled data never establishes a thread's peer. No writes. */
export async function collectThread(input: {
  threadId: string;
  selfKv: KV;
  peers: StoredPeer[];
  exactPeer?: boolean;
  kvFor(peer: StoredPeer): Promise<KV>;
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

  async function append(kv: KV, keys: string[], peer: string, side: 'me' | 'peer') {
    const root = side === 'me' ? k.threadRoot(peer, threadId) : undefined;
    for (const key of keys) {
      if (root && !key.startsWith(`${root}/`)) continue;
      const kind = key.endsWith('/meta.json') ? 'meta'
        : /\/msg\/[^/]+\.json$/.test(key) ? 'msg'
        : /\/task\/[^/]+\.json$/.test(key) ? 'task' : undefined;
      if (!kind) continue;
      const got = await getJson(kv, key);
      if (!got) continue;
      const id = kind === 'meta' ? threadId : key.slice(key.lastIndexOf('/') + 1, -5);
      const invalid = kind === 'msg' ? messageView(got.value).invalid : kind === 'task' ? taskView(got.value).invalid : [];
      entries.push({ peer, kind, id, side, authority: side === 'me' ? 'self' : 'counterparty', body: got.value,
        ...(invalid.length ? { invalid } : {}) });
    }
  }

  for (const peer of peers) {
    const mine = local.get(peer.handle) ?? await listAll(selfKv, `${k.threadRoot(peer.handle, threadId)}/`);
    await append(selfKv, mine, peer.handle, 'me');
    if (!peer.inbound || !peer.theirHandleForMe) continue;
    try {
      const kv = await input.kvFor(peer);
      const prefix = `${k.threadRoot(peer.theirHandleForMe, threadId)}/`;
      const keys = (await listAll(kv, prefix)).filter(key => key.startsWith(prefix));
      await append(kv, keys, peer.handle, 'peer');
    } catch {
      errors.push(peerReadError(peer.handle));
    }
  }
  entries.sort((a, b) => a.id === b.id ? a.kind.localeCompare(b.kind) : a.id < b.id ? -1 : 1);
  return { entries, errors, partial: errors.length > 0 };
}
