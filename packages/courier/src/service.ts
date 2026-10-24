import fs from 'node:fs';
import path from 'node:path';
import { CourierError } from './errors.js';

/** What a service manager needs to keep `courier watch` running for this user. */
export interface ServiceSpec {
  /** Absolute command: node, the courier entry point, any `tc` prefix, `watch` and its flags. */
  argv: string[];
  cwd: string;
  /** Only what the watcher needs (COURIER_HOME, PATH, COURIER_HOST). Never secrets: unit files are world-readable. */
  env: Record<string, string>;
  logFile: string;
  /** Distinguishes several profiles on one machine. */
  name?: string;
}

export interface ServicePlan {
  file: string;
  content: string;
  /** Run in order after the file is written. `ignoreFailure` steps are cleanup (a first install has nothing to stop). */
  commands: { argv: string[]; ignoreFailure?: boolean }[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function serviceName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (!NAME.test(name)) throw new CourierError('usage', `--name must match ${NAME} (got "${name}").`);
  return name;
}

export const launchdLabel = (name?: string) => `xyz.tinycloud.courier.watch${name ? `.${name}` : ''}`;
export const systemdUnit = (name?: string) => `courier-watch${name ? `-${name}` : ''}.service`;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function launchdPlist(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).sort(([a], [b]) => (a < b ? -1 : 1));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(launchdLabel(spec.name))}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...spec.argv.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(spec.cwd)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`]),
    '  </dict>',
    '  <key>AbandonProcessGroup</key>',
    '  <false/>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>30</integer>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(spec.logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(spec.logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function launchdPlan(spec: ServiceSpec, home: string, uid: number): ServicePlan {
  const file = path.join(home, 'Library', 'LaunchAgents', `${launchdLabel(spec.name)}.plist`);
  const domain = `gui/${uid}`;
  return {
    file,
    content: launchdPlist(spec),
    commands: [
      { argv: ['launchctl', 'bootout', `${domain}/${launchdLabel(spec.name)}`], ignoreFailure: true },
      { argv: ['launchctl', 'bootstrap', domain, file] },
    ],
  };
}

/**
 * systemd.exec: ExecStart= splits on whitespace and expands `%` specifiers and `$VAR`; Environment= values expand
 * `%` only (`$` is literal there); WorkingDirectory= is a plain path (quotes are rejected) with `%` expansion.
 * Newline, carriage return and tab are written as their `\n`, `\r`, `\t` escapes so a value can never start a new directive; any other control
 * character is refused.
 */
const quoted = (s: string, expandsDollar: boolean) => {
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  if (/[\u0000-\u001f\u007f]/.test(escaped)) throw new CourierError('usage', 'A systemd unit value must not contain control characters.');
  return `"${expandsDollar ? escaped.replace(/\$/g, '$$$$') : escaped}"`;
};
const execArg = (s: string) => quoted(s, true);
const envAssignment = (s: string) => quoted(s, false);

export function systemdUnitFile(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).sort(([a], [b]) => (a < b ? -1 : 1));
  return [
    '[Unit]',
    'Description=Courier watcher (agent-to-agent threads over TinyCloud)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${spec.cwd.replace(/%/g, '%%')}`,
    ...env.map(([key, value]) => `Environment=${envAssignment(`${key}=${value}`)}`),
    `ExecStart=${spec.argv.map(execArg).join(' ')}`,
    // Every process the watcher started (agents run in their own process groups) belongs to this cgroup, so a stop,
    // a crash or a restart takes them all down.
    'KillMode=control-group',
    'SendSIGKILL=yes',
    'TimeoutStopSec=15',
    'Restart=always',
    'RestartSec=30',
    `StandardOutput=append:${spec.logFile}`,
    `StandardError=append:${spec.logFile}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function systemdPlan(spec: ServiceSpec, home: string): ServicePlan {
  const unit = systemdUnit(spec.name);
  return {
    file: path.join(home, '.config', 'systemd', 'user', unit),
    content: systemdUnitFile(spec),
    commands: [
      { argv: ['systemctl', '--user', 'daemon-reload'] },
      { argv: ['systemctl', '--user', 'enable', '--now', unit] },
      // `enable --now` does not restart a running unit, so a re-install would keep the old command line.
      { argv: ['systemctl', '--user', 'restart', unit] },
    ],
  };
}

export function renderPlan(plan: ServicePlan): string {
  return `# ${plan.file}\n${plan.content}\n# then run:\n${plan.commands.map((c) => c.argv.map(shellWord).join(' ')).join('\n')}\n`;
}

const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export type CommandRunner = (argv: string[]) => { status: number | null; stderr: string };

/** Writes the service file (0644, it holds no secrets) and runs the manager commands. */
export function applyPlan(plan: ServicePlan, run: CommandRunner): void {
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.writeFileSync(plan.file, plan.content, { mode: 0o644 });
  for (const command of plan.commands) {
    const result = run(command.argv);
    if (result.status !== 0 && !command.ignoreFailure) {
      throw new CourierError('install-failed', `\`${command.argv.join(' ')}\` exited ${result.status}: ${result.stderr.trim().slice(-300)}`);
    }
  }
}
