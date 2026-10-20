import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { programName } from '../program.js';
import { isRecord } from '../a2a.js';

/** Where this OS user keeps credentials that a woken agent can read through the Read tool (and a shell) unless HOME differs. */
export const CREDENTIAL_FILES = ['.config/gh/**', '.npmrc', '.netrc', '.ssh/**', '.aws/**', '.config/gcloud/**', '.docker/config.json', '.config/wrangler/**', '.config/.wrangler/**', '.git-credentials'];
/**
 * The guard's Claude Code settings and the environment woken agents get (spec §7).
 *
 * Settings = a `PreToolUse` hook that runs `courier guard` on every tool call, plus deny rules for what no approval can
 * unlock (pairing and revoking, Secret Bridge) and for the files the guard lives in. Approvable commands (merge,
 * deploy, publish, push to main, secrets) are deliberately NOT deny rules: a deny rule would also refuse them after the
 * owner approved, so those are decided by the hook alone.
 */

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command Claude Code runs for the hook. `|| exit 2` turns any crash into a blocking error (exit 1 would fail open). */
export function hookCommand(argv: string[], home: string): string {
  return `COURIER_HOME=${shq(home)} ${argv.map(shq).join(' ')} || exit 2`;
}

/** Everything the guard keeps for a profile lives here; no tool call may write it. */
export const guardDir = (home: string) => path.join(home, 'guard');
export const guardSettingsFile = (home: string) => path.join(guardDir(home), 'settings.json');
/** `TC_HOME` for woken agents: an empty directory, so the owner's `tc` profile is not found. */
export const noOwnerProfileDir = (home: string) => path.join(guardDir(home), 'no-owner-profile');

/** Paths no tool call may write: the courier profile (keys, grant, state), the guard files and the hook program itself. */
export function protectedPaths(home: string, entry: string): string[] {
  return [path.resolve(home), path.dirname(path.resolve(entry))];
}

export interface GuardSettings {
  hooks: { PreToolUse: { matcher: string; hooks: { type: 'command'; command: string; timeout: number }[] }[] };
  permissions: { deny: string[] };
  disableAllHooks: false;
}

/** Claude Code permission paths: `//abs/path` is absolute. */
const rulePath = (p: string) => `/${path.resolve(p)}`;

export function guardSettings(options: { argv: string[]; home: string; entry: string }): GuardSettings {
  const { argv, home, entry } = options;
  const programs = [...new Set(['courier', 'tc courier', 'tinycloud courier', programName()])];
  const deny: string[] = [];
  for (const p of protectedPaths(home, entry)) {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) deny.push(`${tool}(${rulePath(p)}/**)`);
  }
  for (const f of ['key.json', 'grant.json']) deny.push(`Read(${rulePath(path.join(home, f))})`);
  // Only the Read tool: a shell can still `cat` these (the README lists them as residual).
  for (const rel of CREDENTIAL_FILES) deny.push(`Read(${rulePath(path.join(os.homedir(), rel))})`);
  for (const prog of programs) for (const sub of ['pair', 'revoke', 'init']) deny.push(`Bash(${prog} ${sub}:*)`);
  deny.push('Bash(secret-bridge:*)', 'Bash(secret_bridge:*)', 'mcp__paseo', 'mcp__paseo__*');
  return {
    disableAllHooks: false,
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand(argv, home), timeout: 60 }] }] },
    permissions: { deny },
  };
}

/** The guard's own hook command, as {@link hookCommand} writes it. */
export const GUARD_HOOK_RE = /^COURIER_HOME=.* 'guard' \|\| exit 2$/;

const isGuardHook = (entry: unknown): boolean =>
  isRecord(entry) && Array.isArray(entry.hooks) && entry.hooks.some((h) => isRecord(h) && typeof h.command === 'string' && GUARD_HOOK_RE.test(h.command));

/**
 * `ours` merged over a user's settings: the guard's hook goes first, its deny rules are added, `disableAllHooks` is
 * forced to false, and an older copy of the guard's hook in `theirs` is replaced, not duplicated.
 */
export function mergeGuardSettings(ours: GuardSettings, theirs: unknown): Record<string, unknown> {
  if (theirs === undefined) return { ...ours };
  if (!isRecord(theirs)) throw new Error('settings are not a JSON object');
  const theirHooks = isRecord(theirs.hooks) ? theirs.hooks : {};
  const theirPre = (Array.isArray(theirHooks.PreToolUse) ? theirHooks.PreToolUse : []).filter((entry) => !isGuardHook(entry));
  const theirPerms = isRecord(theirs.permissions) ? theirs.permissions : {};
  const theirDeny = Array.isArray(theirPerms.deny) ? theirPerms.deny : [];
  return {
    ...theirs,
    disableAllHooks: false,
    hooks: { ...theirHooks, PreToolUse: [...ours.hooks.PreToolUse, ...theirPre] },
    permissions: { ...theirPerms, deny: [...new Set([...ours.permissions.deny, ...theirDeny])] },
  };
}

/**
 * Write the guard settings for `home`. A settings file the owner passed with `--claude-settings` is merged in, with the
 * guard's hook and deny rules added to (never replacing) whatever it holds. Returns the path to give `claude --settings`.
 */
export function writeGuardSettings(options: { argv: string[]; home: string; entry: string; userSettings?: string }): string {
  const dir = guardDir(options.home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(noOwnerProfileDir(options.home), { recursive: true, mode: 0o700 });
  const theirs: unknown = options.userSettings ? JSON.parse(fs.readFileSync(options.userSettings, 'utf8')) : undefined;
  if (options.userSettings && !isRecord(theirs)) throw new Error(`${options.userSettings} is not a JSON object`);
  const merged = mergeGuardSettings(guardSettings(options), theirs);
  const file = guardSettingsFile(options.home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/**
 * The only variables a woken agent inherits (claude and exec adapters build the environment from this list; nothing else
 * is passed on): paths and locale, proxy and CA settings, what Claude Code itself needs, and `COURIER_*`. No tokens:
 * not `GH_TOKEN`/`GITHUB_TOKEN`, `NPM_TOKEN`, `CLOUDFLARE_*`, `WRANGLER_*`, `PHALA_*`, `LINEAR_*`, `AWS_*`, cloud or
 * `TC_*` credentials, nor `SSH_AUTH_SOCK`. An operator who really needs one names it with `--env-pass`.
 */
const ALLOWED_ENV: RegExp[] = [
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TZ|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|TMPDIR|TMP|TEMP|HOSTNAME)$/,
  /^LC_[A-Z_]+$/,
  /^(HTTPS?_PROXY|NO_PROXY|ALL_PROXY)$/i,
  /^(SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|NODE_EXTRA_CA_CERTS)$/,
  /^XDG_(CONFIG|DATA|CACHE|STATE)_HOME$/,
  /^(ANTHROPIC|CLAUDE|CLAUDE_CODE)_[A-Z0-9_]+$/,
  /^CLAUDECODE$/,
  /^COURIER_[A-Z0-9_]+$/,
  /^TC_BIN$/,
];

/**
 * Credential variables that are blanked for agents the watcher cannot build an environment for (`paseo run` inherits the
 * Paseo daemon's environment, which the watcher cannot see). Exact names only; a daemon that holds others is a residual
 * risk the README names. Includes what an audit of a real Paseo host found (`CLOUDFLARE_*`, `TYPESAFE_API_KEY`, `TC_OWNER_DID`).
 */
const BLANKED_ENV = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITHUB_PAT', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'YARN_NPM_AUTH_TOKEN', 'NPM_CONFIG_TOKEN',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'WRANGLER_API_TOKEN',
  'PHALA_CLOUD_API_KEY', 'PHALA_API_KEY', 'LINEAR_API_KEY', 'LINEAR_ACCESS_TOKEN', 'TYPESAFE_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_API_KEY', 'AZURE_CLIENT_SECRET',
  'OPENAI_API_KEY', 'SLACK_BOT_TOKEN', 'SLACK_TOKEN', 'DOCKER_PASSWORD', 'SSH_AUTH_SOCK', 'SSH_ASKPASS', 'GIT_ASKPASS',
  'TC_PRIVATE_KEY', 'TC_PROFILE', 'TC_OWNER_DID', 'TC_API_KEY', 'TC_TOKEN', 'TC_OPENKEY_HOST', 'TC_OPENKEY_API_HOST', 'TC_AUTH_NO_POPUP', 'TC_NO_POPUP',
];

const allowed = (name: string, extra: readonly string[]) => extra.includes(name) || ALLOWED_ENV.some((re) => re.test(name));

/**
 * Environment for a woken agent: an allowlist (see {@link ALLOWED_ENV}) plus `extra` names the operator passed with
 * `--env-pass`. The owner's `tc` profile is hidden by pointing `TC_HOME` at an empty directory.
 */
export function courierOnlyEnv(base: NodeJS.ProcessEnv, home: string, extra: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && allowed(name, extra)) env[name] = value;
  env.COURIER_HOME = home;
  env.TC_HOME = noOwnerProfileDir(home);
  return env;
}

const CREDENTIAL_LIKE = /(TOKEN|SECRET|PASSW|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)|^(TC|CLOUDFLARE|CF|WRANGLER|PHALA|LINEAR|AWS|GOOGLE|AZURE|GH|GITHUB|NPM|SSH)_/i;

/**
 * The same as overrides for a launcher that can only set variables (`paseo run --env`). The agent inherits the Paseo
 * daemon's environment, not the watcher's, so this blanks every well-known credential name and every credential-looking
 * variable of the watcher's own environment that is not allowed. Anything else the daemon holds still reaches the agent;
 * the README says so.
 */
export function courierEnvOverrides(base: NodeJS.ProcessEnv, home: string, extra: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...Object.keys(base).filter((n) => CREDENTIAL_LIKE.test(n)), ...BLANKED_ENV]) {
    if (!allowed(name, extra) && !name.startsWith('PASEO_') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) out[name] = '';
  }
  out.COURIER_HOME = home;
  out.TC_HOME = noOwnerProfileDir(home);
  return out;
}
