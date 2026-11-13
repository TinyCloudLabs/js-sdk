import { isRecord } from './a2a.js';
import { agentId, PREFIX } from './keys.js';
import { privateDir, readPrivateFile, writePrivateFile } from './private-dir.js';
import type { StoredPeer } from './profile.js';
import { peerIdentity, sameIdentity, type LocalWatchCache, type PeerIdentity } from './watch.js';

const DIR = 'watch-cache';

/** One peer's facts, with the identity they were learned under. */
interface PeerFacts extends PeerIdentity {
  markerReadAt?: number;
  receipted: string[];
  metaMirrored: string[];
}

interface WatchCacheFile {
  v: 2;
  self: { did: string; space: string };
  claimsPrunedAt?: number;
  peers: Record<string, PeerFacts>;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const metaPrefix = (peer: StoredPeer) => peer.theirHandleForMe ? `${PREFIX}/to/${peer.theirHandleForMe}/` : undefined;

function parse(text: string | undefined): WatchCacheFile | undefined {
  const value: unknown = JSON.parse(text ?? 'null');
  if (!isRecord(value) || value.v !== 2 || !isRecord(value.self) || typeof value.self.did !== 'string' || typeof value.self.space !== 'string'
    || !isRecord(value.peers) || (value.claimsPrunedAt !== undefined && typeof value.claimsPrunedAt !== 'number')) return undefined;
  for (const facts of Object.values(value.peers)) {
    if (!isRecord(facts) || typeof facts.did !== 'string' || typeof facts.space !== 'string'
      || !(facts.session === null || typeof facts.session === 'string') || !strings(facts.receipted) || !strings(facts.metaMirrored)
      || (facts.markerReadAt !== undefined && typeof facts.markerReadAt !== 'number')) return undefined;
  }
  return value as unknown as WatchCacheFile;
}

/**
 * `<COURIER_HOME>/watch-cache/<did:key id>.json`, owner-only, in a checked private directory: what this agent's watcher
 * already learned from the node (receipted message ids, mirrored meta keys, marker read times, the claim pruning
 * time), so a restart or a `--once` run need not fetch it again.
 * - Bound to this agent's DID and space.
 * - Each peer's facts carry the identity (DID, space, session) they were learned under. They are loaded and saved
 *   only while the peer's current identity is the same; otherwise they are dropped, never re-stamped.
 * - Only `peers()` (the eligible peers) are kept. A bad file, an old format or an unsafe directory is the same as no
 *   file. Deleted with the read cache (revoke, refusal, owner revocation, key rotation).
 */
export function fileWatchCache(agent: string, space: string, peers: () => StoredPeer[]) {
  const name = `${agentId(agent)}.json`;
  return {
    load(): LocalWatchCache | undefined {
      try {
        const dir = privateDir([DIR], false);
        if (!dir) return undefined;
        const file = parse(readPrivateFile(dir, name));
        if (!file || file.self.did !== agent || file.self.space !== space) return undefined;
        const cache: LocalWatchCache = { v: 1, claimsPrunedAt: file.claimsPrunedAt, markerReadAt: {}, metaMirrored: {}, receipted: {}, identities: {} };
        for (const peer of peers()) {
          const facts = Object.hasOwn(file.peers, peer.handle) ? file.peers[peer.handle] : undefined;
          const identity = peerIdentity(peer);
          if (!facts || !sameIdentity({ did: facts.did, space: facts.space, session: facts.session }, identity)) continue;
          cache.identities[peer.handle] = identity;
          if (facts.markerReadAt !== undefined) cache.markerReadAt[peer.handle] = facts.markerReadAt;
          cache.receipted[peer.handle] = facts.receipted;
          const prefix = metaPrefix(peer);
          if (prefix) cache.metaMirrored[peer.handle] = facts.metaMirrored.filter(key => key.startsWith(prefix));
        }
        return cache;
      } catch { return undefined; }
    },
    save(cache: LocalWatchCache): void {
      const dir = privateDir([DIR], true);
      if (!dir) return;
      const file: WatchCacheFile = { v: 2, self: { did: agent, space }, peers: {}, ...(cache.claimsPrunedAt !== undefined ? { claimsPrunedAt: cache.claimsPrunedAt } : {}) };
      for (const peer of peers()) {
        const identity = peerIdentity(peer);
        // Facts learned under another identity of this handle are dropped, never stamped with the current one.
        if (!sameIdentity(Object.hasOwn(cache.identities, peer.handle) ? cache.identities[peer.handle] : undefined, identity)) continue;
        const prefix = metaPrefix(peer);
        file.peers[peer.handle] = {
          ...identity,
          ...(cache.markerReadAt[peer.handle] !== undefined ? { markerReadAt: cache.markerReadAt[peer.handle] } : {}),
          receipted: cache.receipted[peer.handle] ?? [],
          metaMirrored: prefix ? (cache.metaMirrored[peer.handle] ?? []).filter(key => key.startsWith(prefix)) : [],
        };
      }
      writePrivateFile(dir, name, file);
    },
  };
}
