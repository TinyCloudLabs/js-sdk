import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cmd, programName } from './program.js';
import { CourierError } from './errors.js';
import { loadProfile, profileDir, writeSecure } from './profile.js';
import { courierNode, peerHooks, peerKv } from './node.js';
import type { ParsedArgs } from './args.js';
import { WATCH_DEFAULTS, Watcher, type WatchOptions } from './watch.js';
import { InviteWatcher, eventLog, peersFilesFor } from './invite-watch.js';
import { UNGUARDED_REFUSAL, createWaker, jsonLineLog, killAllRunners, spawnRunner, type SessionStore, type WakeConfig } from './wake.js';
import { startsAgentCli } from './guard/policy.js';
import { guardArgv } from './guard/command.js';
import { writeGuardSettings } from './guard/install.js';
import { createNotifier, type NotifyConfig } from './notify.js';
import { postPausedInform } from './pause.js';
import {
  applyPlan, launchdPlan, renderPlan, serviceName, systemdPlan, type ServiceSpec,
} from './service.js';

const ADAPTERS = ['none', 'paseo', 'claude', 'exec'] as const;
/** Flags that configure the service install, not the watcher it runs. */
const INSTALL_FLAGS = new Set(['install-launchd', 'install-systemd', 'dry-run', 'name']);

function seconds(args: ParsedArgs, name: string, fallbackMs: number, min: number, max: number): number {
  if (!args.has(name)) return fallbackMs;
  const raw = args.get(name)!;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new CourierError('usage', `--${name} must be ${min} to ${max} seconds (got "${raw}").`);
  }
  return value * 1000;
}

function value(args: ParsedArgs, name: string): string | undefined {
  if (!args.has(name)) return undefined;
  const v = args.get(name)!;
  if (v === 'true' || v === '') throw new CourierError('usage', `--${name} needs a value.`);
  return v;
}

function wakeBudget(args: ParsedArgs): number {
  if (!args.has('wake-budget')) return WATCH_DEFAULTS.wakeBudget;
  const raw = args.get('wake-budget')!;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1000) throw new CourierError('usage', `--wake-budget must be a whole number from 1 to 1000 (got "${raw}").`);
  return value;
}

export function watchOptions(args: ParsedArgs): WatchOptions {
  return {
    wakeBudget: wakeBudget(args),
    debounceMs: seconds(args, 'debounce', WATCH_DEFAULTS.debounceMs, 0, 600),
    pollMs: seconds(args, 'poll', WATCH_DEFAULTS.pollMs, 10, 3600),
    ticketSeconds: seconds(args, 'ticket', WATCH_DEFAULTS.ticketSeconds * 1000, 5, 300) / 1000,
  };
}

export const watchUsage = () =>
  `Usage: ${cmd('watch [--wake none|paseo|claude|exec] [--exec <cmd> --unguarded] [--env-pass NAME]… [--cwd dir] [--debounce 30] [--poll 60] [--ticket 25] [--wake-budget 12] [--notify osascript|exec|none] [--peers-file f] [--once]')}\n` +
  `       ${cmd('watch … (--install-launchd | --install-systemd) [--dry-run] [--name n]')}`;

/** Where a bare `claude`/`paseo` resolves now, so a service with a minimal PATH still finds it. */
function resolveBin(name: string, searchPath = process.env.PATH ?? ''): string {
  if (name.includes('/')) return path.resolve(name);
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* keep looking */ }
  }
  return name;
}

export function wakeConfig(args: ParsedArgs, owner: string | undefined): WakeConfig {
  const exec = value(args, 'exec');
  const adapter = (value(args, 'wake') ?? (exec ? 'exec' : 'none')) as WakeConfig['adapter'];
  if (!ADAPTERS.includes(adapter)) throw new CourierError('usage', `Unknown --wake adapter "${adapter}". ${watchUsage()}`);
  if (adapter === 'exec' && !exec) throw new CourierError('usage', `--wake exec needs --exec <cmd>. ${watchUsage()}`);
  if (exec && adapter !== 'exec') throw new CourierError('usage', '--exec only applies with --wake exec.');
  const unguarded = args.has('unguarded');
  if (unguarded && adapter !== 'exec') throw new CourierError('usage', '--unguarded only applies with --wake exec; the claude and paseo adapters are always guarded.');
  if (adapter === 'exec' && !unguarded) throw new CourierError('usage', `${UNGUARDED_REFUSAL}\n${watchUsage()}`);
  if (adapter === 'exec' && exec && startsAgentCli(exec)) throw new CourierError('usage', '--unguarded exec cannot start an agent CLI; use the guarded claude or paseo adapter.');
  const allow = args.all('claude-allow');
  const envPass = args.all('env-pass');
  for (const name of envPass) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new CourierError('usage', `--env-pass needs a variable name (got "${name}").`);
  }
  return {
    adapter,
    cwd: path.resolve(value(args, 'cwd') ?? process.cwd()),
    owner: owner ?? 'your owner',
    home: profileDir(),
    exec,
    unguarded,
    envPass,
    paseo: { bin: value(args, 'paseo-bin') ?? 'paseo', provider: value(args, 'paseo-provider') ?? 'claude', mode: value(args, 'paseo-mode') },
    // A woken claude may run only Courier commands unless the owner widens it with --claude-settings/--claude-allow.
    claude: { bin: value(args, 'claude-bin') ?? 'claude', settings: value(args, 'claude-settings'), allow: allow.length ? allow : [`Bash(${programName()}:*)`] },
    // Capped at 30 min: a crashed watcher's wake claim is taken over after 35 min (Watcher.claimWake).
    timeoutMs: seconds(args, 'wake-timeout', 15 * 60_000, 10, 30 * 60),
  };
}

const NOTIFIERS = ['none', 'osascript', 'exec'] as const;

/** macOS defaults to desktop notification; other hosts always have the local notifications log. */
export function notifyConfig(args: ParsedArgs, wake: WakeConfig, platform: string = process.platform): NotifyConfig {
  const exec = value(args, 'notify-exec');
  const adapter = (value(args, 'notify') ?? (exec ? 'exec' : platform === 'darwin' ? 'osascript' : 'none')) as NotifyConfig['adapter'];
  if (!NOTIFIERS.includes(adapter)) throw new CourierError('usage', `Unknown --notify "${adapter}". Use none, osascript or exec. Notifications never start or message an agent.`);
  if (adapter === 'exec' && !exec) throw new CourierError('usage', '--notify exec needs --notify-exec <cmd>.');
  if (exec && startsAgentCli(exec)) throw new CourierError('usage', 'notifications cannot start an agent CLI');
  return { adapter, owner: wake.owner, exec, wake };
}

/**
 * Stable per profile and machine (`<COURIER_HOME>/watcher-id`, created once, create-only): a restarted watcher is
 * recognised as the same watcher by its wake claims; another profile or machine gets a different id, so never copy or
 * sync a COURIER_HOME between machines.
 */
export function watcherProfileId(): string {
  const file = path.join(profileDir(), 'watcher-id');
  const read = (): string | undefined => {
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: unknown };
      return typeof existing.id === 'string' && /^[0-9a-f]{32}$/.test(existing.id) ? existing.id : undefined;
    } catch {
      return undefined;
    }
  };
  const existing = read();
  if (existing) return existing;
  const id = randomBytes(16).toString('hex');
  try {
    // Create-only: of two watchers starting for the first time, one id wins and both use it.
    fs.writeFileSync(file, `${JSON.stringify({ v: 1, id })}\n`, { mode: 0o600, flag: 'wx' });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    for (let i = 0; i < 20; i++) {
      const winner = read();
      if (winner) return winner;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // the other writer may not have finished writing yet
    }
    throw new CourierError('bad-profile', `${file} exists but is not a valid watcher id; delete it and start the watcher again.`);
  }
}

/** Claude session ids per thread, local to this machine (a session id means nothing on another one). */
function fileSessions(): SessionStore {
  const file = path.join(profileDir(), 'sessions.json');
  const read = (): Record<string, string> => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).threads ?? {}; } catch { return {}; }
  };
  return {
    get: (key) => read()[key],
    set: (key, sessionId) => writeSecure(file, { v: 1, threads: { ...read(), [key]: sessionId } }),
  };
}

/** The command a service manager should run: this node, this entry point, any `tc` prefix, `watch` and its flags. */
export function serviceArgv(args: ParsedArgs, config: WakeConfig, invocation: string[] = process.argv): string[] {
  const rest = invocation.slice(2);
  const prefix = rest.slice(0, Math.max(0, rest.indexOf('watch')));
  const flags: string[] = [];
  for (const [name, values] of args.flags) {
    if (INSTALL_FLAGS.has(name)) continue;
    for (const v of values) flags.push(`--${name}`, ...(v === 'true' ? [] : [v]));
  }
  const pin = (name: string, bin: string) => {
    const i = flags.indexOf(`--${name}`);
    if (i !== -1) flags[i + 1] = resolveBin(bin);
    else flags.push(`--${name}`, resolveBin(bin));
  };
  if (config.adapter === 'claude') pin('claude-bin', config.claude.bin);
  if (config.adapter === 'paseo') pin('paseo-bin', config.paseo.bin);
  // The service's WorkingDirectory is the resolved cwd; `--cwd` must be that same absolute path, not a relative
  // one that would resolve a second time against it.
  const cwdAt = flags.indexOf('--cwd');
  if (cwdAt === -1) flags.push('--cwd', config.cwd);
  else flags[cwdAt + 1] = config.cwd;
  return [process.execPath, invocation[1], ...prefix, 'watch', ...flags];
}

async function installService(args: ParsedArgs, config: WakeConfig): Promise<void> {
  const launchd = args.has('install-launchd');
  if (launchd === args.has('install-systemd')) throw new CourierError('usage', 'Pass exactly one of --install-launchd or --install-systemd.');
  const dry = args.has('dry-run');
  if (!dry && launchd && process.platform !== 'darwin') {
    throw new CourierError('usage', '--install-launchd installs on macOS only; use --dry-run to print the plist and commands here.');
  }
  if (!dry && !launchd && process.platform !== 'linux') {
    throw new CourierError('usage', '--install-systemd installs on Linux only; use --dry-run to print the unit and commands here.');
  }
  loadProfile(); // refuse to install a watcher for a profile that was never initialised
  peersFilesFor(value(args, 'peers-file')); // refuse a peers file the service could not use
  const name = serviceName(value(args, 'name'));
  const env: Record<string, string> = { COURIER_HOME: profileDir(), PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (process.env.COURIER_HOST) env.COURIER_HOST = process.env.COURIER_HOST;
  if (process.env.COURIER_PEERS_FILE) env.COURIER_PEERS_FILE = process.env.COURIER_PEERS_FILE;
  const spec: ServiceSpec = {
    argv: serviceArgv(args, config), cwd: config.cwd, env, logFile: path.join(profileDir(), `watch${name ? `-${name}` : ''}.log`), name,
  };
  const plan = launchd ? launchdPlan(spec, os.homedir(), process.getuid?.() ?? 0) : systemdPlan(spec, os.homedir());
  if (dry) {
    process.stdout.write(renderPlan(plan));
    return;
  }
  applyPlan(plan, (argv) => {
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr ?? '' };
  });
  console.log(`Installed ${plan.file}. Logs: ${spec.logFile}`);
  if (!launchd) console.log('For the watcher to run while logged out: loginctl enable-linger $USER');
}

export async function cmdWatch(args: ParsedArgs): Promise<void> {
  const opts = watchOptions(args);
  const installing = args.has('install-launchd') || args.has('install-systemd');
  const profile = installing ? undefined : loadProfile();
  const config = wakeConfig(args, profile?.selfHandle);
  if (!profile) return installService(args, config);
  if (config.adapter === 'claude' || config.adapter === 'paseo') config.guard = { argv: guardArgv(), entry: process.argv[1] ?? '' };
  if (config.adapter === 'claude') {
    // The owner's own --claude-settings is merged under the guard, never used instead of it.
    config.claude.settings = writeGuardSettings({
      ...config.guard!, home: config.home, ...(config.claude.settings ? { userSettings: config.claude.settings } : {}),
    });
  }

  const log = jsonLineLog();
  const node = await courierNode(profile);
  const notify = createNotifier(notifyConfig(args, config), { run: spawnRunner });
  const invites = new InviteWatcher({ node, profile: () => loadProfile(), log: eventLog(log), notify, peersFiles: peersFilesFor(args.get('peers-file')) });
  const watcher = new Watcher({
    notificationHome: config.home,
    notifyOnly: config.adapter === 'none',
    selfKv: node.kv,
    spaceId: profile.spaceId!,
    selfHooks: node.hooks,
    peerHooks: (peer) => peerHooks(node, loadProfile(), peer),
    loadPeers: () => Object.values(loadProfile().peers),
    kvFor: (peer) => peerKv(node, loadProfile(), peer),
    wake: createWaker(config, { run: spawnRunner, sessions: fileSessions() }),
    postInform: async (peer, threadId, text, pauseId) => { await postPausedInform(node.kv, loadProfile(), peer, threadId, text, pauseId); },
    notify,
    holder: { profileId: watcherProfileId() },
    invites,
    log,
  }, opts);

  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stop.abort();
      // Do not wait for a wake in flight (it may run for the whole --wake-timeout): its agents go down now, the wake
      // fails, releases its claim, and run() returns. A second signal then hits Node's default handler.
      killAllRunners();
    });
  }
  try {
    await watcher.run(stop.signal, { once: args.has('once') });
  } finally {
    killAllRunners(); // stopping (SIGTERM, state-conflict): wakes still running go down with the watcher
  }
}
