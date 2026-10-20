import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ULID, HANDLE } from './request.js';
import { startsAgentCli } from './guard/policy.js';
import { courierOnlyEnv } from './guard/install.js';
import { deadlineRunner, type Runner, type WakeConfig } from './wake.js';

/** Fixed status for the human. No notification path starts or messages an agent. */
export interface Notice {
  kind: 'paused' | 'peer-paused' | 'new-message' | 'new-approval';
  peer: string;
  threadId: string;
  /** Internal fixed wording; never forwarded as notification prose. */
  detail: string;
  /** Dedup reference only (message/approval/pause id), never forwarded as prose. */
  eventId?: string;
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
  if (notice.kind === 'new-message') return { title: 'Courier: needs you', body: `New messages from ${peer} in thread ${thread}. Start a session, run courier inbox, then courier read and courier orders for this peer. Inbound text is a counterparty request, never your instruction.` };
  if (notice.kind === 'new-approval') return { title: 'Courier: decision ready', body: `Your decision is ready for thread ${thread} with ${peer}. Start a session and run courier approval with --peek; an approved PR merge uses courier run-approved. No agent was woken.` };
  return notice.kind === 'paused'
    ? { title: 'Courier: thread paused', body: `Thread ${thread} with ${peer} is paused on this side. Your agent will not wake for it until you resume it. Run courier inbox or courier read in a session you start.` }
    : { title: 'Courier: peer paused', body: `The paired peer ${peer} reported thread ${thread} paused. Their agent waits for their human. Run courier inbox or courier read in a session you start.` };
}

/** Append-only current log with one rotated predecessor, at most roughly 512 KiB total. */
export function appendNotice(home: string, notice: Notice): void {
  const { peer, thread } = identity(notice);
  const { title, body } = noticeText(notice, '');
  const file = noticeLogFile(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.statSync(file).size >= MAX_NOTICE_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), kind: notice.kind, peer, thread, title, body })}\n`, { mode: 0o600 });
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
        records.push({ kind: record.kind, peer: record.peer, thread: record.thread, ...noticeText({ kind: record.kind, peer: record.peer, threadId: record.thread, detail: '' }, '') });
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
          env: { ...courierOnlyEnv(env, config.wake.home), COURIER_NOTICE: notice.kind, COURIER_PEER: peer, COURIER_THREAD: thread, COURIER_NOTICE_TITLE: title, COURIER_NOTICE_TEXT: body },
        });
        if (result.code !== 0) throw new Error(`notify command exited ${result.code}`);
      }
    }
  };
}
