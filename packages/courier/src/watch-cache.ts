import path from 'node:path';
import { isRecord } from './a2a.js';
import { agentId, PREFIX } from './keys.js';
import { privateDir, stillPrivate } from './private-dir.js';
import { readRegularFile, writeSecure, type StoredPeer } from './profile.js';
import type { LocalWatchCache } from './watch.js';

const DIR = 'watch-cache';

/** One peer's facts, kept only while the peer is still the same agent, space and session. */
interface PeerFacts {
  did: string;
  space: string;
  session: string | null;
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
const samePeer = (facts: PeerFacts, peer: StoredPeer) =>
  facts.did === peer.courierDid && facts.space === peer.spaceId && facts.session === (peer.sessionId ?? null);
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
 * `<COURIER_HOME>/watch-cache/<did:key id>.json`, owner-only: what this agent's watcher already learned from the node
 * (receipted message ids, mirrored meta keys, marker read times, the claim pruning time), so a restart or a `--once`
 * run need not fetch it again. It is bound to this agent's DID and space, and each peer's part to that peer's DID,
 * space and session: a mismatch, a removed peer, a bad file or an unsafe directory is the same as no file. Deleted
 * with the read cache (revoke, refusal, owner revocation, key rotation).
 */
export function fileWatchCache(agent: string, space: string, peers: () => StoredPeer[]) {
  const name = `${agentId(agent)}.json`;
  return {
    load(): LocalWatchCache | undefined {
      try {
        const dir = privateDir([DIR], false);
        if (!dir || !stillPrivate(dir)) return undefined;
        const file = parse(readRegularFile(path.join(dir.path, name)));
        if (!file || file.self.did !== agent || file.self.space !== space) return undefined;
        const cache: LocalWatchCache = { v: 1, claimsPrunedAt: file.claimsPrunedAt, markerReadAt: {}, metaMirrored: [], receipted: {} };
        for (const peer of peers()) {
          const facts = Object.hasOwn(file.peers, peer.handle) ? file.peers[peer.handle] : undefined;
          if (!facts || !samePeer(facts, peer)) continue;
          if (facts.markerReadAt !== undefined) cache.markerReadAt[peer.handle] = facts.markerReadAt;
          cache.receipted[peer.handle] = facts.receipted;
          const prefix = metaPrefix(peer);
          if (prefix) cache.metaMirrored.push(...facts.metaMirrored.filter(key => key.startsWith(prefix)));
        }
        return cache;
      } catch { return undefined; }
    },
    save(cache: LocalWatchCache): void {
      const dir = privateDir([DIR], true);
      if (!dir || !stillPrivate(dir)) return;
      const file: WatchCacheFile = { v: 2, self: { did: agent, space }, peers: {}, ...(cache.claimsPrunedAt !== undefined ? { claimsPrunedAt: cache.claimsPrunedAt } : {}) };
      for (const peer of peers()) {
        const prefix = metaPrefix(peer);
        file.peers[peer.handle] = {
          did: peer.courierDid, space: peer.spaceId, session: peer.sessionId ?? null,
          ...(cache.markerReadAt[peer.handle] !== undefined ? { markerReadAt: cache.markerReadAt[peer.handle] } : {}),
          receipted: cache.receipted[peer.handle] ?? [],
          metaMirrored: prefix ? cache.metaMirrored.filter(key => key.startsWith(prefix)) : [],
        };
      }
      writeSecure(path.join(dir.path, name), file);
    },
  };
}
