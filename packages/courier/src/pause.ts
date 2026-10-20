import { CourierError } from './errors.js';
import { ulid } from 'ulid';
import { ULID } from './request.js';
import { k, PREFIX } from './keys.js';
import { buildMessage } from './a2a.js';
import { del, getJson, putCreate, putMatch } from './store.js';
import type { KV } from './inbox.js';
import type { ParsedArgs } from './args.js';
import { cmd } from './program.js';
import { courierNode, peerKv } from './node.js';
import { getPeer, loadProfile, type Profile } from './profile.js';

const SAFE = /^[0-9A-Za-z_-]{1,64}$/;

/** `me/state/paused/<peer>/<thread>.json`. The watcher is the only writer of watch.json; markers are how humans and the CLI talk to it. */
export interface PauseMarker {
  v: 1;
  peer: string;
  threadId: string;
  by: 'budget' | 'human';
  at: string;
  reason: string;
  informId?: string;
  informSent?: boolean;
}

/** Posts the machine-readable "thread paused" `inform` to the peer (it never wakes anyone; its watcher notifies its human). */
export async function postPausedInform(kv: KV, profile: Profile, peerHandle: string, threadId: string, text: string, messageId?: string): Promise<string> {
  const message = buildMessage({
    threadId, text, role: 'ROLE_AGENT', intent: 'inform', notice: 'thread-paused',
    from: { owner: profile.ownerDid!, agent: profile.courierDid, label: profile.label },
  });
  if (messageId) {
    if (!ULID.test(messageId)) throw new CourierError('usage', 'Invalid pause inform id.');
    message.messageId = messageId;
  }
  try { await putCreate(kv, k.msg(peerHandle, threadId, message.messageId), message); } catch (error) {
    if (!(error instanceof CourierError && error.code === 'conflict')) throw error;
  }
  return message.messageId;
}

/** Creates the marker; false if the thread was already paused. */
export async function writePauseMarker(kv: KV, marker: PauseMarker): Promise<boolean> {
  try {
    await putCreate(kv, k.paused(marker.peer, marker.threadId), marker);
    return true;
  } catch (error) {
    if (error instanceof CourierError && error.code === 'conflict') return false;
    throw error;
  }
}

function target(args: ParsedArgs, usage: string): { peer: string; threadId: string } {
  const [peer, threadId] = args.positional;
  if (!peer || !threadId) throw new CourierError('usage', usage);
  if (!SAFE.test(peer) || !SAFE.test(threadId)) throw new CourierError('usage', `Invalid peer or thread id. ${usage}`);
  return { peer, threadId };
}

const pauseUsage = () => `Usage: ${cmd('pause <peer> <threadId> [--reason "…"]')}`;
const resumeUsage = () => `Usage: ${cmd('resume <peer> <threadId>')}`;

/** Humans only: stop waking this side's agent for a thread and tell the peer with an `inform`. */
export async function cmdPause(args: ParsedArgs, deps: { profile?: typeof loadProfile; node?: typeof courierNode } = {}): Promise<void> {
  const { peer, threadId } = target(args, pauseUsage());
  const profile = (deps.profile ?? loadProfile)();
  const paired = getPeer(profile, peer);
  const node = await (deps.node ?? courierNode)(profile);
  let exists = await getJson(node.kv, k.threadMeta(peer, threadId)) ?? await getJson(node.kv, k.mirrorMeta(peer, threadId));
  if (!exists && paired.inbound && paired.theirHandleForMe) exists = await getJson(await peerKv(node, profile, paired), `${PREFIX}/to/${paired.theirHandleForMe}/threads/${threadId}/meta.json`);
  if (!exists) throw new CourierError('not-found', `Thread ${threadId} with ${peer} does not exist.`);
  const reason = args.has('reason') && args.get('reason') !== 'true' ? args.get('reason')! : 'paused by its owner';
  const marker: PauseMarker = { v: 1, peer, threadId, by: 'human', at: new Date().toISOString(), reason, informId: ulid(), informSent: false };
  const wrote = await writePauseMarker(node.kv, marker);
  const stored = await getJson<PauseMarker>(node.kv, k.paused(peer, threadId));
  if (!stored) throw new CourierError('not-found', 'The pause marker disappeared; try again.');
  if (!wrote && (stored.value.by !== 'human' || stored.value.informSent)) {
    console.log(`Thread ${threadId} with ${peer} is already paused.`);
    return;
  }
  const saved = stored.value;
  if (!saved.informId) {
    saved.informId = ulid();
    await putMatch(node.kv, k.paused(peer, threadId), saved, stored.etag!);
  }
  // A failed inform can be retried with the same message id, without duplicate messages or marker creation.
  await postPausedInform(node.kv, profile, peer, threadId,
    'Thread paused by its owner. Its agent waits until its owner resumes it.', saved.informId);
  const fresh = await getJson<PauseMarker>(node.kv, k.paused(peer, threadId));
  if (fresh) await putMatch(node.kv, k.paused(peer, threadId), { ...fresh.value, informSent: true }, fresh.etag!);
  console.log(`Paused thread ${threadId} with ${peer}; told ${peer}. Resume: ${cmd(`resume ${peer} ${threadId}`)}`);
}

/** Humans only: wake this side's agent for the thread again; the wake budget starts over. */
export async function cmdResume(args: ParsedArgs): Promise<void> {
  const { peer, threadId } = target(args, resumeUsage());
  const profile = loadProfile();
  getPeer(profile, peer);
  const node = await courierNode(profile);
  if (!(await getJson(node.kv, k.paused(peer, threadId)))) {
    console.log(`Thread ${threadId} with ${peer} is not paused.`);
    return;
  }
  await del(node.kv, k.paused(peer, threadId));
  console.log(`Resumed thread ${threadId} with ${peer}. A running watcher picks this up with the next message it sees.`);
}
