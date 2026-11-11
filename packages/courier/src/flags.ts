import type { ParsedArgs } from './args.js';
import { CourierError } from './errors.js';

const INIT = ['request', 'wait', 'timeout', 'grant-file', 'paste', 'resume', 'rotate-key', 'host', 'openkey-host', 'openkey-api-host', 'label', 'handle', 'expiry', 'key', 'key-file', 'force'];
const TEXT = ['text', 'file', 'stdin'];
const JOIN = ['consent', 'wait'];

/**
 * The flags each command reads (flags a command refuses with its own message are listed too, so that message is kept).
 * `help` is accepted everywhere. A flag outside the list is a usage error before the command reads anything.
 */
export const COMMAND_FLAGS: Record<string, readonly string[]> = {
  init: INIT,
  start: ['new', 'session', 'peer', 'link', ...JOIN],
  invite: ['session', 'mode', 'recipient', 'peer', ...JOIN],
  join: ['link', 'peer', ...JOIN],
  manifest: [],
  pair: ['file', 'stdin', 'call-me', 'as', 'force', 'renew-artifact'],
  revoke: [],
  send: ['new', 'thread', 'intent', 'ask', 'constraint', 'reply-to', 'task-ref', ...TEXT],
  inbox: ['json', 'peek'],
  read: ['peer', 'json'],
  task: ['peer', 'thread', 'state', 'note', 'artifact', 'ask', 'request-message'],
  request: ['task', 'why', 'peer', 'verb', 'target', 'summary', 'head-sha', 'base', 'risk', 'action'],
  orders: ['json'],
  watch: ['wake', 'exec', 'unguarded', 'env-pass', 'cwd', 'debounce', 'poll', 'ticket', 'wake-budget', 'wake-timeout', 'notify', 'notify-exec',
    'once', 'paseo-bin', 'paseo-mode', 'paseo-provider', 'claude-allow', 'claude-bin', 'claude-settings', 'install-launchd', 'install-systemd', 'dry-run', 'name'],
  intake: ['queue-dir', 'done-dir', 'overflow-dir', 'state-dir', 'peers-file', 'peers-owner', 'interval', 'once', 'init-from-now', 'force'],
  outbox: ['thread', 'new', 'outbox-dir', 'pipe', 'socket-group', 'peers-file', 'peers-owner', 'sent-dir', 'once', 'dry-run', ...TEXT],
  approval: ['verb', 'target', 'head-sha', 'base', 'peek', 'action'],
  pause: ['reason'],
  resume: [],
  credential: ['email', 'code', 'code-stdin'],
  guard: ['out', 'claude-settings'],
  'run-approved': ['test-owner-root'],
  broker: ['gh-bin', 'test-token', 'test-owner-root'],
};

/** Refuse a flag `command` does not read. Runs before the command touches stdin, files or the profile. */
export function assertKnownFlags(command: string, args: ParsedArgs): void {
  const known = COMMAND_FLAGS[command];
  if (!known) return;
  for (const name of args.flags.keys()) {
    if (name === 'help' || known.includes(name)) continue;
    throw new CourierError('usage', `Unknown flag --${name} for ${command}.${known.length ? ` Accepted: ${known.map((f) => `--${f}`).join(' ')}.` : ' It takes no flags.'}`);
  }
}
