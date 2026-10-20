import { CourierError } from './errors.js';
import { k } from './keys.js';
import { buildMessage } from './a2a.js';
import { del, getJson, putCreate } from './store.js';
import type { KV } from './inbox.js';
import type { ParsedArgs } from './args.js';
import { cmd } from './program.js';
import { courierNode } from './node.js';
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
}

/** Posts the machine-readable "thread paused" `inform` to the peer (it never wakes anyone; its watcher notifies its human). */
export async function postPausedInform(kv: KV, profile: Profile, peerHandle: string, threadId: string, text: string): Promise<string> {
  const message = buildMessage({
    threadId, text, role: 'ROLE_AGENT', intent: 'inform', notice: 'thread-paused',
    from: { owner: profile.ownerDid!, agent: profile.courierDid, label: profile.label },
  });
  await putCreate(kv, k.msg(peerHandle, threadId, message.messageId), message);
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
export async function cmdPause(args: ParsedArgs): Promise<void> {
  const { peer, threadId } = target(args, pauseUsage());
  const profile = loadProfile();
  getPeer(profile, peer);
  const node = await courierNode(profile);
  const reason = args.has('reason') && args.get('reason') !== 'true' ? args.get('reason')! : 'paused by its owner';
  const wrote = await writePauseMarker(node.kv, { v: 1, peer, threadId, by: 'human', at: new Date().toISOString(), reason });
  if (!wrote) {
    console.log(`Thread ${threadId} with ${peer} is already paused.`);
    return;
  }
  await postPausedInform(node.kv, profile, peer, threadId,
    `Thread paused on ${profile.label} side: ${reason}. Its agent will not be woken for this thread until its owner resumes it.`);
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
