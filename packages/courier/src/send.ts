import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { buildMessage, messageRole, oneLine, type CourierMessage, type Intent, type ThreadMeta } from './a2a.js';
import { canonicalJson } from './canonical.js';
import { CourierError } from './errors.js';
import { k } from './keys.js';
import type { StoredPeer } from './profile.js';
import { getJson, putCreate } from './store.js';

type KV = TinyCloudNode['kv'];
export type SendInput = {
  which: 'new' | 'thread';
  threadId: string;
  subject?: string;
  text: string;
  intent: Intent;
  asks: { id: string; title: string }[];
  constraints: string[];
  inReplyTo: string | null;
  referenceTaskIds: string[];
};

/** Shared CLI/outbox and headless publication. Only the caller decides what may be sent. */
export async function publishMessage(
  kv: KV,
  from: { owner: string; agent: string; label?: string },
  peer: StoredPeer,
  input: SendInput,
  options: { peerKv?: () => Promise<KV>; onWrite?: (key: string) => void; messageId?: string } = {},
): Promise<CourierMessage> {
  const { which, threadId, subject, text, intent, asks, constraints, inReplyTo, referenceTaskIds } = input;
  const handle = peer.handle;
  if (peer.interim?.latchedAt || peer.interim?.inboundRefusedAt) {
    throw new CourierError('peer-revoked', `Sharing with ${oneLine(handle)} was revoked. A new pairing is required.`);
  }
  if (peer.sessionId && (which === 'new' || threadId !== peer.sessionId)) {
    throw new CourierError('session-mismatch', 'This pairing permits only its invited session. Start or select another session explicitly.');
  }
  const startedByMe = which === 'new' || Boolean(await getJson(kv, k.threadMeta(handle, threadId)));
  let refsOwnTask = false;
  let refsAnyTask = false;
  let reader: KV | undefined;
  for (const taskId of referenceTaskIds) {
    if (await getJson(kv, k.task(handle, threadId, taskId))) {
      refsOwnTask = true;
      refsAnyTask = true;
      continue;
    }
    if (options.peerKv && peer.inbound && peer.theirHandleForMe) {
      reader ??= await options.peerKv();
      if (await getJson(reader, k.task(peer.theirHandleForMe, threadId, taskId))) refsAnyTask = true;
    }
  }
  const message = buildMessage({
    messageId: options.messageId, threadId, text, from, intent, asks, constraints, inReplyTo, referenceTaskIds,
    role: messageRole({ startedByMe, refsOwnTask, refsAnyTask }),
  });
  if (which === 'new') {
    const meta: ThreadMeta = {
      threadId, subject: subject ?? '(no subject)',
      startedBy: { owner: from.owner, courier: from.agent, label: from.label },
      createdAt: new Date().toISOString(),
    };
    const key = k.threadMeta(handle, threadId);
    await putCreate(kv, key, meta);
    options.onWrite?.(key);
  }
  const key = k.msg(handle, threadId, message.messageId);
  try {
    await putCreate(kv, key, message);
  } catch (error) {
    if (!options.messageId || !(error instanceof CourierError) || error.code !== 'conflict') throw error;
    const current = await getJson<CourierMessage>(kv, key);
    if (!current || canonicalJson(current.value) !== canonicalJson(message)) throw error;
  }
  options.onWrite?.(key);
  return message;
}
