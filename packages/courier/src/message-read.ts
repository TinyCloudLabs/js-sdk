import { isRecord, messageView, oneLine } from './a2a.js';
import { CourierError, type ResultLike } from './errors.js';
import type { KV } from './inbox.js';
import { k } from './keys.js';
import type { StoredPeer } from './profile.js';
import { peerReadError, type PeerReadError, type ThreadEntry } from './thread.js';

export const MESSAGE_READ_LIMIT = 20;
export const MESSAGE_READ_BYTES = 64 * 1024;
export const MESSAGE_READ_MS = 10_000;
const SAFE_ID = /^[0-9A-Za-z_-]{1,64}$/;

export function validateMessageSelection(threadId: string, peer: string | undefined, ids: string[]): void {
  if (!peer || peer === 'true') throw new CourierError('usage', '--message needs --peer <peer>.');
  if (!ids.length || ids.length > MESSAGE_READ_LIMIT) throw new CourierError('usage', 'Up to 20 message IDs at a time.');
  if (!SAFE_ID.test(threadId) || ids.some(id => id === 'true' || !SAFE_ID.test(id))) {
    throw new CourierError('usage', 'Thread and message IDs must be 1–64 letters, digits, underscores or hyphens.');
  }
}

type ReadStatus = 'found' | 'missing' | 'unreadable' | 'too-large' | 'timed-out' | 'invalid';
export interface MessageReadOutcome {
  messageId: string;
  side: 'me' | 'peer';
  status: ReadStatus;
}

export function renderMessageOutcomes(peer: string, outcomes: readonly MessageReadOutcome[]): string {
  const labels: Record<ReadStatus, string> = {
    found: 'found', missing: 'not found', unreadable: "couldn't read", 'too-large': 'too large (over 64 KiB)',
    'timed-out': 'timed out', invalid: 'not a valid message',
  };
  return outcomes.map(outcome => `${oneLine(outcome.messageId, 64)} (${outcome.side === 'me' ? 'yours' : `${oneLine(peer, 80)}'s`}): ${labels[outcome.status]}\n`).join('');
}

/** Exact message reads only: no archive listings, metadata, tasks, receipt or watcher writes. */
export async function collectMessages(input: {
  threadId: string;
  peer: StoredPeer;
  messageIds: string[];
  selfKv: KV;
  kvFor(peer: StoredPeer): Promise<KV>;
  signal?: AbortSignal;
}): Promise<{ entries: ThreadEntry[]; errors: PeerReadError[]; partial: boolean; outcomes: MessageReadOutcome[] }> {
  const { peer, threadId } = input;
  validateMessageSelection(threadId, peer.handle, input.messageIds);
  if (peer.sessionId && peer.sessionId !== threadId) {
    throw new CourierError('usage', 'This peer is paired for a different thread.');
  }
  const entries: ThreadEntry[] = [];
  const outcomes: MessageReadOutcome[] = [];
  const ids = [...new Set(input.messageIds)];
  // Covers the data reads on both sides. Credential restoration/activation retains its existing SDK policy.
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(MESSAGE_READ_MS)]) : AbortSignal.timeout(MESSAGE_READ_MS);

  async function read(kv: KV, mailbox: string, side: 'me' | 'peer', id: string): Promise<void> {
    let status: ReadStatus = 'unreadable';
    try {
      if (signal.aborted) { outcomes.push({ messageId: id, side, status: 'timed-out' }); return; }
      const result = await kv.get(k.msg(mailbox, threadId, id), {
        prefix: '', source: 'network', raw: true, maxResponseBytes: MESSAGE_READ_BYTES, timeout: MESSAGE_READ_MS, signal,
      }) as ResultLike<{ data: unknown }>;
      if (!result.ok) {
        const code = result.error?.code;
        status = signal.aborted ? 'timed-out' : code === 'KV_NOT_FOUND' ? 'missing'
          : code === 'KV_RESPONSE_TOO_LARGE' ? 'too-large' : 'unreadable';
      } else {
        let body = result.data?.data;
        const raw = typeof body === 'string' ? body : JSON.stringify(body);
        if (typeof raw !== 'string') status = 'invalid';
        else if (Buffer.byteLength(raw, 'utf8') > MESSAGE_READ_BYTES) status = 'too-large';
        else {
          try {
            if (typeof body === 'string') body = JSON.parse(body);
            // Check inside this message's failure boundary, before final output combines healthy messages.
            JSON.stringify(body);
          } catch {
            outcomes.push({ messageId: id, side, status: 'invalid' });
            return;
          }
          if (!isRecord(body) || body.contextId !== threadId || body.messageId !== id) status = 'invalid';
          else {
            const invalid = messageView(body).invalid;
            entries.push({ peer: peer.handle, kind: 'msg', id, side, authority: side === 'me' ? 'self' : 'counterparty',
              body, ...(invalid.length ? { invalid } : {}) });
            status = 'found';
          }
        }
      }
    } catch {
      status = signal.aborted ? 'timed-out' : 'unreadable';
    }
    outcomes.push({ messageId: id, side, status });
  }

  for (const id of ids) await read(input.selfKv, peer.handle, 'me', id);
  try {
    if (!peer.inbound || !peer.theirHandleForMe) throw new Error('Peer is not paired.');
    if (signal.aborted) {
      for (const id of ids) outcomes.push({ messageId: id, side: 'peer', status: 'timed-out' });
    } else {
      const kv = await input.kvFor(peer);
      for (const id of ids) await read(kv, peer.theirHandleForMe, 'peer', id);
    }
  } catch {
    for (const id of ids) outcomes.push({ messageId: id, side: 'peer', status: 'unreadable' });
  }
  const partial = outcomes.some(outcome => outcome.status !== 'found' && outcome.status !== 'missing');
  return { entries, outcomes, errors: partial ? [peerReadError(peer.handle)] : [], partial };
}
