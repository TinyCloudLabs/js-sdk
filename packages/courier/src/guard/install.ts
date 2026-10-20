import fs from 'node:fs';
import path from 'node:path';
import { programName } from '../program.js';
import { isRecord } from '../a2a.js';

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

/** Variables that point at an owner's TinyCloud CLI profile or keys. None of them reach a woken agent. */
const OWNER_VARS = /^(TC_PRIVATE_KEY|TC_PROFILE|TC_OWNER_DID|TC_AUTH_.*|TC_OPENKEY_.*|TC_REPLICATION.*|TC_API.*|TC_TOKEN.*)$/;

/**
 * Environment for a woken agent: the courier profile only. The owner's `tc` profile is hidden by pointing `TC_HOME`
 * at an empty directory and dropping the variables that carry owner keys.
 */
export function courierOnlyEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) if (!OWNER_VARS.test(name)) env[name] = value;
  env.COURIER_HOME = home;
  env.TC_HOME = noOwnerProfileDir(home);
  return env;
}

/** The same hiding as {@link courierOnlyEnv}, as overrides for a launcher that can only set variables (`paseo run --env`). */
export function courierEnvOverrides(base: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const out: Record<string, string> = { COURIER_HOME: home, TC_HOME: noOwnerProfileDir(home) };
  for (const name of Object.keys(base)) if (OWNER_VARS.test(name)) out[name] = '';
  return out;
}
