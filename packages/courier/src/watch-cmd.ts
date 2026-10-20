import { cmd } from './program.js';
import { CourierError } from './errors.js';
import { loadProfile } from './profile.js';
import { courierNode, peerHooks, peerKv } from './node.js';
import type { ParsedArgs } from './args.js';
import { WATCH_DEFAULTS, Watcher, type WatchOptions } from './watch.js';
import { jsonLineLog, noWaker } from './wake.js';

function seconds(args: ParsedArgs, name: string, fallbackMs: number, min: number, max: number): number {
  if (!args.has(name)) return fallbackMs;
  const raw = args.get(name)!;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new CourierError('usage', `--${name} must be ${min} to ${max} seconds (got "${raw}").`);
  }
  return value * 1000;
}

export function watchOptions(args: ParsedArgs): WatchOptions {
  return {
    debounceMs: seconds(args, 'debounce', WATCH_DEFAULTS.debounceMs, 0, 600),
    pollMs: seconds(args, 'poll', WATCH_DEFAULTS.pollMs, 10, 3600),
    ticketSeconds: seconds(args, 'ticket', WATCH_DEFAULTS.ticketSeconds * 1000, 5, 300) / 1000,
  };
}

export const watchUsage = () =>
  `Usage: ${cmd('watch [--wake none] [--debounce 30] [--poll 60] [--ticket 25] [--once]')}`;

export async function cmdWatch(args: ParsedArgs): Promise<void> {
  const opts = watchOptions(args);
  const adapter = args.get('wake') ?? 'none';
  const log = jsonLineLog();
  if (adapter !== 'none') throw new CourierError('usage', `Unknown --wake adapter "${adapter}". ${watchUsage()}`);

  const profile = loadProfile();
  const node = await courierNode(profile);
  const watcher = new Watcher({
    selfKv: node.kv,
    spaceId: profile.spaceId!,
    selfHooks: node.hooks,
    peerHooks: (peer) => peerHooks(node, loadProfile(), peer),
    loadPeers: () => Object.values(loadProfile().peers),
    kvFor: (peer) => peerKv(node, loadProfile(), peer),
    wake: noWaker,
    log,
  }, opts);

  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  await watcher.run(stop.signal, { once: args.has('once') });
}
