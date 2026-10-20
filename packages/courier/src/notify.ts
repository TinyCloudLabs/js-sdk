import { oneLine } from './a2a.js';
import { cmd } from './program.js';
import { sendToThreadAgent, type Runner, type WakeConfig } from './wake.js';

/** Something a human must hear about that is not a task for an agent. */
export interface Notice {
  /** `paused`: this side's watcher stopped waking the thread. `peer-paused`: the peer's watcher did. */
  kind: 'paused' | 'peer-paused';
  peer: string;
  threadId: string;
  /** One fixed line on why (this watcher's own wording), never text a peer wrote. */
  detail: string;
}

export type Notifier = (notice: Notice) => Promise<void>;

export interface NotifyConfig {
  adapter: 'none' | 'paseo' | 'osascript' | 'exec';
  owner: string;
  exec?: string;
  wake: Pick<WakeConfig, 'cwd' | 'home' | 'paseo' | 'timeoutMs'>;
}

const label = (value: string, max = 120) => oneLine(value, max);

export function noticeText(notice: Notice, owner: string): { title: string; body: string } {
  const peer = label(notice.peer, 40);
  const detail = label(notice.detail, 200);
  return notice.kind === 'paused'
    ? {
      title: `Courier: thread with ${peer} paused`,
      body: `Thread ${notice.threadId} with ${peer} is paused: ${detail}. ${owner}'s agent will not be woken for it until you run \`${cmd(`resume ${notice.peer} ${notice.threadId}`)}\`.`,
    }
    : {
      title: `Courier: ${peer} paused a thread`,
      body: `${peer}'s side paused thread ${notice.threadId}: ${detail}. Their agent will not reply until their human resumes it.`,
    };
}

/**
 * Paseo has no CLI call that only flags attention, so the notice is a short message to the thread's agent: its run
 * ends in the normal "finished" attention state with one line for the human. The prompt forbids touching the peer
 * or Courier, so a notice can never restart the loop it reports.
 */
export function paseoNoticePrompt(notice: Notice, owner: string): string {
  const { body } = noticeText(notice, owner);
  return `Courier status notice, not a task: ${body}\n\n` +
    `Do not send anything to ${label(notice.peer, 40)}, do not run any ${cmd('…')} command, and do not start work on the thread. ` +
    `Reply with one line for ${label(owner, 40)} saying what happened.`;
}

export function createNotifier(config: NotifyConfig, deps: { run: Runner; env?: NodeJS.ProcessEnv }): Notifier {
  const { run } = deps;
  const env = deps.env ?? process.env;
  return async (notice) => {
    const { title, body } = noticeText(notice, config.owner);
    switch (config.adapter) {
      case 'none':
        return;
      case 'paseo':
        await sendToThreadAgent(run, config.wake, {
          threadId: notice.threadId, peer: notice.peer, title: `⏸ ${label(notice.peer, 40)} · thread ${notice.threadId.slice(0, 8)}`,
          prompt: paseoNoticePrompt(notice, config.owner),
        });
        return;
      case 'osascript': {
        // The text reaches AppleScript as argv items, never as script source.
        const result = await run('osascript', [
          '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', body, title,
        ], { timeoutMs: 15_000 });
        if (result.code !== 0) throw new Error(`osascript exited ${result.code}: ${result.stderr.trim().slice(-300)}`);
        return;
      }
      case 'exec': {
        const result = await run('/bin/sh', ['-c', config.exec!], {
          cwd: config.wake.cwd,
          timeoutMs: config.wake.timeoutMs,
          env: {
            ...env,
            COURIER_HOME: config.wake.home,
            COURIER_NOTICE: notice.kind,
            COURIER_PEER: notice.peer,
            COURIER_THREAD: notice.threadId,
            COURIER_NOTICE_TITLE: title,
            COURIER_NOTICE_TEXT: body,
          },
        });
        if (result.code !== 0) throw new Error(`notify command exited ${result.code}: ${result.stderr.trim().slice(-300)}`);
      }
    }
  };
}
