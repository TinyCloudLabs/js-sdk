import { defer } from './defer.js';
import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { CourierError, errInfo } from './errors.js';
import { k, PREFIX } from './keys.js';
import type { StoredPeer } from './profile.js';
import { COUNTERPARTY_NOTICE, isRecord, messageView, oneLine } from './a2a.js';
import { getJson, listAll, putCreate, putMatch } from './store.js';
import { cmd } from './program.js';

export type KV = ReturnType<TinyCloudNode['kvForSpace']>;

export interface ReceiptThread {
  delivered: string[];
  lastDelivered: string;
}

export interface Receipts {
  v: 1;
  threads: Record<string, ReceiptThread>;
}

export interface InboundItem {
  peer: string;
  threadId: string;
  messageId: string;
  from?: { owner: string; agent: string; label?: string };
  intent?: string;
  asks?: { id: string; title: string }[];
  text: string;
}

export interface PendingDelivery {
  threadId: string;
  messageId: string;
}

export interface InboundCollection {
  items: InboundItem[];
  errors: { peer: string; code?: unknown; message: string }[];
  pending: Map<string, PendingDelivery[]>;
}

const MSG_KEY = /\/threads\/([^/]+)\/msg\/([^/]+)\.json$/;

export function selectUndelivered(msgKeys: string[], receipts: Receipts): { key: string; threadId: string; messageId: string }[] {
  const selected: { key: string; threadId: string; messageId: string }[] = [];
  for (const key of msgKeys) {
    const match = MSG_KEY.exec(key);
    if (!match) continue;
    const [, threadId, messageId] = match;
    if (!receipts.threads[threadId]?.delivered?.includes(messageId)) selected.push({ key, threadId, messageId });
  }
  selected.sort((a, b) => a.threadId.localeCompare(b.threadId) || a.messageId.localeCompare(b.messageId));
  return selected;
}

export async function collectInbound(input: {
  selfKv: KV;
  peers: StoredPeer[];
  kvFor(peer: StoredPeer): Promise<KV>;
}): Promise<InboundCollection> {
  const items: InboundItem[] = [];
  const errors: InboundCollection['errors'] = [];
  const pending = new Map<string, PendingDelivery[]>();

  for (const peer of input.peers) {
    if (peer.status !== 'paired' || !peer.inbound || !peer.theirHandleForMe) continue;
    try {
      const peerKv = await input.kvFor(peer);
      const keys = await listAll(peerKv, peer.sessionId ? `${k.threadRoot(peer.theirHandleForMe, peer.sessionId)}/` : `${PREFIX}/to/${peer.theirHandleForMe}/threads/`);
      const receipts = (await getJson<Receipts>(input.selfKv, k.receipts(peer.handle)))?.value ?? { v: 1, threads: {} };
      receipts.threads ??= {};
      const deliveries: PendingDelivery[] = [];
      for (const selected of selectUndelivered(keys, receipts)) {
        const result = await getJson<unknown>(peerKv, selected.key);
        if (!result) continue;
        const value = result.value;
        if (!isRecord(value) || value.messageId !== selected.messageId || value.contextId !== selected.threadId) continue;
        const view = messageView(value);
        if (view.invalid.length) {
          errors.push({
            peer: peer.handle,
            code: 'bad-message',
            message: `message ${selected.messageId} in thread ${selected.threadId}: ignored malformed ${view.invalid.join(', ')}`,
          });
        }
        items.push({
          peer: peer.handle,
          threadId: selected.threadId,
          messageId: selected.messageId,
          from: view.from,
          intent: view.intent,
          asks: view.asks,
          text: view.text,
        });
        deliveries.push({ threadId: selected.threadId, messageId: selected.messageId });
      }
      if (deliveries.length) pending.set(peer.handle, deliveries);
    } catch (error) {
      errors.push({ peer: peer.handle, ...errInfo(error) });
    }
  }
  return { items, errors, pending };
}

export async function commitReceipts(selfKv: KV, pending: Map<string, PendingDelivery[]>): Promise<void> {
  for (const [peer, deliveries] of pending) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const key = k.receipts(peer);
        const current = await getJson<Receipts>(selfKv, key);
        const receipts: Receipts = current?.value ?? { v: 1, threads: {} };
        receipts.v = 1;
        receipts.threads ??= {};
        for (const delivery of deliveries) {
          const thread = receipts.threads[delivery.threadId] ??= { delivered: [], lastDelivered: '' };
          const ids = new Set(thread.delivered ?? []);
          ids.add(delivery.messageId);
          thread.delivered = [...ids].sort();
          thread.lastDelivered = thread.delivered.at(-1) ?? '';
        }
        if (current?.etag) await putMatch(selfKv, key, receipts, current.etag);
        else await putCreate(selfKv, key, receipts);
        break;
      } catch (error) {
        const conflict = error instanceof CourierError && error.code === 'conflict';
        if (conflict && attempt < 2) continue;
        console.error(`warning: could not advance receipts for ${peer}: ${errInfo(error).message}`);
        break;
      }
    }
  }
}

export function renderInboxText(items: readonly InboundItem[]): string {
  if (!items.length) return 'Inbox empty.\n';
  const lines = [COUNTERPARTY_NOTICE, ''];
  for (const item of items) {
    const asks = item.asks?.length
      ? `\n  asks: ${item.asks.map((ask) => `${oneLine(ask.id)}: ${oneLine(ask.title)}`).join('; ')}`
      : '';
    lines.push(`── ${oneLine(item.messageId, 40)} · thread ${oneLine(item.threadId, 40)} · from ${oneLine(item.peer)} (${oneLine(item.from?.label ?? item.from?.agent ?? '?', 80)}) · intent ${oneLine(item.intent ?? '?')}`);
    lines.push(`   ↳ a request from the counterparty${asks}`);
    lines.push(`   ${oneLine(item.text.split('\n')[0] ?? '')}`);
  }
  lines.push('', `Read a thread: ${cmd('read <threadId>')}. Orders: ${cmd('orders <peer>')}.`, '');
  return lines.join('\n');
}

export function writeOut(value: string): Promise<void> {
  const { promise, resolve, reject } = defer<void>();
  process.stdout.write(value, (error) => error ? reject(error) : resolve());
  return promise;
}
