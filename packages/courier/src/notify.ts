import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ULID, HANDLE } from './request.js';
import { courierPhrase } from './did-key.js';
import { startsAgentCli } from './guard/policy.js';
import { courierOnlyEnv } from './guard/install.js';
import { deadlineRunner, type Runner, type WakeConfig } from './wake.js';

/** Invite facts for the owner. `label` is the peer's claimed label, shown verbatim; nothing else from the hello is included. `tier` is the requested tier, never a grant. */
export interface InviteNotice {
  id: string;
  handle: string;
  label: string;
  owner: string;
  courierDid: string;
  reason: string;
  tier: string;
  /** Latest time a read grant from an earlier abandoned attempt can still be valid. Fixed wording only. */
  possibleGrantUntil?: string;
}
/** Fixed status for the human. No notification path starts or messages an agent. */
export interface Notice {
  kind: 'paused' | 'peer-paused' | 'new-message' | 'new-approval' | 'invite-held' | 'invite-completed' | 'invite-failed';
  /** Machine event id, used only for deduplication, never notification prose. */
  eventId?: string;
  /** Fixed-width local count of coalesced pause transitions. */
  repeats?: string;
  /** Fixed-width count of message deliveries or owner decisions in a paired-peer slot. */
  count?: string;
  peer: string;
  threadId: string;
  /** Internal fixed wording; never forwarded as notification prose. */
  detail: string;
  /** Set for invite-held and invite-completed only. */
  invite?: InviteNotice;
}
export type Notifier = (notice: Notice) => Promise<void>;
export interface NotifyConfig {
  adapter: 'none' | 'osascript' | 'exec';
  owner: string;
  exec?: string;
  wake: Pick<WakeConfig, 'cwd' | 'home' | 'timeoutMs'>;
}
export const MAX_NOTICE_LOG_BYTES = 256 * 1024;
export const noticeLogFile = (home: string) => path.join(home, 'notifications.jsonl');

function identity(notice: Notice): { peer: string; thread: string } {
  if (!HANDLE.test(notice.peer)) throw new Error('invalid notice peer handle');
  const thread = ULID.test(notice.threadId) || /^sha256:[a-f0-9]{12}$/.test(notice.threadId) ? notice.threadId : `sha256:${createHash('sha256').update(notice.threadId).digest('hex').slice(0, 12)}`;
  return { peer: notice.peer, thread };
}
export function noticeText(notice: Notice, _owner: string): { title: string; body: string } {
  const { peer, thread } = identity(notice);
  const pending = /^[0-9]{6}$/.test(notice.count ?? '') ? Number(notice.count) : 1;
  const total = `${pending}${pending === 999999 ? '+' : ''}`;
  if (notice.kind === 'new-message') return { title: 'Courier: needs you', body: `${total} new message(s) from ${peer}; latest thread ${thread}. Start a session, run courier inbox, then courier read and courier orders for this peer.` };
  if (notice.kind === 'new-approval') return { title: 'Courier: decision ready', body: `${total} owner decision(s) with ${peer}; latest thread ${thread}. Start a session and run courier approval with --peek; an approved PR merge uses courier run-approved. No agent was woken.` };
  if (notice.kind === 'invite-held' || notice.kind === 'invite-completed') {
    const invite = notice.invite;
    if (!invite) throw new Error('invite notice without invite facts');
    return notice.kind === 'invite-held'
      ? { title: 'Courier: invite needs you', body: `Invite ${invite.id} for ${invite.handle} is held (${invite.reason}). Claimed label "${invite.label}", owner ${invite.owner}, ${courierPhrase(invite.courierDid)}, requested tier ${invite.tier}. Run courier invite approve ${invite.id} --owner ${invite.owner} (only if that owner is the one you mean to pair) or courier invite deny ${invite.id}.${invite.possibleGrantUntil ? ` A read grant from an earlier attempt may exist until ${invite.possibleGrantUntil}.` : ''} No agent was woken.` }
      : { title: 'Courier: invite paired', body: `Invite ${invite.id} paired with ${invite.handle}: owner ${invite.owner}, ${courierPhrase(invite.courierDid)}, requested tier ${invite.tier}. The peer starts as strict until you confirm trusted status. Claimed label "${invite.label}". No agent was woken.` };
  }
  if (notice.kind === 'invite-failed') return { title: 'Courier: invite failed', body: `An invite for ${peer} could not be recovered (${notice.detail}). No pairing happened, and the invite closes at its expiry. No approve or deny applies. No agent was woken.` };
  const count = /^[0-9]{6}$/.test(notice.repeats ?? '') ? Number(notice.repeats) : 0;
  const repeated = count ? ` Additional pauses on this thread: ${count}${count === 999999 ? '+' : ''}.` : '';
  return notice.kind === 'paused'
    ? { title: 'Courier: thread paused', body: `Thread ${thread} with ${peer} is paused on this side. Your agent will not wake for it until you resume it. Run courier inbox or courier read in a session you start.${repeated}` }
    : { title: 'Courier: peer paused', body: `The paired peer ${peer} reported thread ${thread} paused. Their agent waits for their human. Run courier inbox or courier read in a session you start.${repeated}` };
}

/** Append-only current log with one rotated predecessor, at most roughly 512 KiB total. */
export function appendNotice(home: string, notice: Notice): void {
  const { peer, thread } = identity(notice);
  const { title, body } = noticeText(notice, '');
  const file = noticeLogFile(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.statSync(file).size >= MAX_NOTICE_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), kind: notice.kind, peer, thread, ...(notice.count ? { count: notice.count } : {}), title, body })}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Recent local fixed-text status, including deliveries whose receipts the watcher already committed. */
export function recentNotices(home: string): { kind: Notice['kind']; peer: string; thread: string; title: string; body: string }[] {
  const records = [];
  for (const file of [`${noticeLogFile(home)}.1`, noticeLogFile(home)]) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8').slice(-MAX_NOTICE_LOG_BYTES - 2048); } catch { continue; }
    for (const line of text.split('\n')) {
      try {
        const record = JSON.parse(line);
        if (!['paused', 'peer-paused', 'new-message', 'new-approval'].includes(record.kind) || typeof record.peer !== 'string' || !HANDLE.test(record.peer) || typeof record.thread !== 'string' || !(ULID.test(record.thread) || /^sha256:[a-f0-9]{12}$/.test(record.thread))) continue;
        records.push({ kind: record.kind, peer: record.peer, thread: record.thread, ...noticeText({ kind: record.kind, peer: record.peer, threadId: record.thread, count: typeof record.count === 'string' ? record.count : undefined, detail: '' }, '') });
      } catch { /* partial rotation or malformed line: no status to display */ }
    }
  }
  return records.slice(-100);
}

/** All model-free channels share the watcher's dedup, rate cap, bounded outbox and retries. */
export function createNotifier(config: NotifyConfig, deps: { run: Runner; env?: NodeJS.ProcessEnv }): Notifier {
  const env = deps.env ?? process.env;
  return async (notice) => {
    const { title, body } = noticeText(notice, config.owner);
    const { peer, thread } = identity(notice);
    const run = deadlineRunner(deps.run, config.wake.timeoutMs);
    switch (config.adapter) {
      case 'none': return;
      case 'osascript': {
        const result = await run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', body, title], { timeoutMs: Math.min(15_000, config.wake.timeoutMs) });
        if (result.code !== 0) throw new Error(`osascript exited ${result.code}`);
        return;
      }
      case 'exec': {
        if (config.exec && startsAgentCli(config.exec)) throw new Error('notifications cannot start an agent CLI');
        const result = await run('/bin/sh', ['-c', config.exec!], {
          cwd: config.wake.cwd, timeoutMs: config.wake.timeoutMs,
          env: { ...courierOnlyEnv(env, config.wake.home), COURIER_HOME: config.wake.home, COURIER_NOTICE: notice.kind, COURIER_NOTICE_COUNT: String(/^[0-9]{6}$/.test(notice.count ?? '') ? Number(notice.count) : 1), COURIER_PEER: peer, COURIER_THREAD: thread, COURIER_NOTICE_TITLE: title, COURIER_NOTICE_TEXT: body },
        });
        if (result.code !== 0) throw new Error(`notify command exited ${result.code}`);
      }
    }
  };
}
