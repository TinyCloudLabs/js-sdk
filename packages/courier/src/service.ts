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

const CONTROL = /[\u0000-\u001f\u007f]/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Every value in the unit goes through one of two functions: `quoted` for values in a quoted word (ExecStart= arguments, Environment= assignments) and
 * `unitPath` for directives that take a path (WorkingDirectory=, StandardOutput=append:, StandardError=append:). Nothing else is interpolated.
 *
 * systemd.exec: ExecStart= splits on whitespace and expands `%` specifiers and `$VAR`; Environment= values expand `%` only (`$` is literal there).
 * `quoted` writes newline, carriage return and tab as their `\n`, `\r`, `\t` escapes so a value can never start a new directive, and refuses any
 * other control character.
 */
const quoted = (s: string, expandsDollar: boolean) => {
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  if (CONTROL.test(escaped)) throw new CourierError('usage', 'A systemd unit value must not contain control characters.');
  return `"${expandsDollar ? escaped.replace(/\$/g, '$$$$') : escaped}"`;
};

/**
 * A path directive takes the path as written (quotes and escapes are not interpreted there), so the value must be absolute and free of control
 * characters, and only `%` is doubled (specifiers are expanded in these directives; `$` is not). A trailing backslash would continue the line
 * and swallow the next directive, and trailing whitespace is dropped by the parser, so both are refused.
 */
const unitPath = (directive: string, p: string) => {
  if (CONTROL.test(p)) throw new CourierError('usage', `${directive} must not contain control characters.`);
  if (!path.isAbsolute(p)) throw new CourierError('usage', `${directive} must be an absolute path.`);
  if (/[\\\s]$/.test(p)) throw new CourierError('usage', `${directive} must not end with a backslash or whitespace.`);
  return p.replace(/%/g, '%%');
};

const execArg = (s: string) => quoted(s, true);
const envAssignment = (key: string, value: string) => {
  if (!ENV_KEY.test(key)) throw new CourierError('usage', 'A systemd unit environment name must be letters, digits and "_".');
  return quoted(`${key}=${value}`, false);
};

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
    `WorkingDirectory=${unitPath('WorkingDirectory', spec.cwd)}`,
    ...env.map(([key, value]) => `Environment=${envAssignment(key, value)}`),
    `ExecStart=${spec.argv.map(execArg).join(' ')}`,
    // Every process the watcher started (agents run in their own process groups) belongs to this cgroup, so a stop,
    // a crash or a restart takes them all down.
    'KillMode=control-group',
    'SendSIGKILL=yes',
    'TimeoutStopSec=15',
    'Restart=always',
    'RestartSec=30',
    `StandardOutput=append:${unitPath('StandardOutput', spec.logFile)}`,
    `StandardError=append:${unitPath('StandardError', spec.logFile)}`,
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
