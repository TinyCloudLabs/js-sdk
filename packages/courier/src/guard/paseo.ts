import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isRecord } from '../a2a.js';
import { GUARD_HOOK_RE, guardSettings, projectSettings } from './install.js';

/**
 * Guard for agents the `paseo` wake adapter starts. Paseo cannot pass `claude --settings`, so the guard goes where
 * Claude Code itself looks for it: `<cwd>/.claude/settings.local.json` (project-local, not meant to be committed).
 * Claude runs its hooks in every permission mode, and project settings merge with the user's, so the hook holds in
 * `default`, `bypassPermissions` and the rest. The adapter refuses to wake anything it cannot prove guarded.
 */

/** Label every guarded Paseo agent carries. An agent without it (created before the guard existed) is never messaged. */
export const GUARD_LABEL = 'courier-guard=1';

/** Paseo env that would send a nested `paseo run` into the caller's own workspace instead of `--cwd`. */
export const PASEO_CALLER_ENV = ['PASEO_AGENT_ID', 'PASEO_AGENT_CWD', 'PASEO_WORKSPACE_ID'];

export const projectSettingsFile = (cwd: string) => path.join(cwd, '.claude', 'settings.local.json');

export interface ProjectGuard {
  /** `node <entry> [tc prefix] guard` */
  argv: string[];
  entry: string;
}

/** Install (or refresh) the guard in `<cwd>/.claude/settings.local.json`, merged with whatever is already there. */
export function installProjectGuard(cwd: string, home: string, guard: ProjectGuard): string {
  const file = projectSettingsFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let theirs: unknown;
  let mode = 0o600;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    mode = fs.statSync(file).mode & 0o777;
    theirs = raw.trim() ? JSON.parse(raw) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot merge the guard into ${file}: ${(error as Error).message}`);
    }
  }
  if (theirs !== undefined && !isRecord(theirs)) throw new Error(`${file} is not a JSON object; refusing to overwrite it`);
  const merged = projectSettings(guardSettings({ argv: guard.argv, home, entry: guard.entry }), theirs);
  const next = `${JSON.stringify(merged, null, 2)}\n`;
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== next) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, { mode });
    fs.renameSync(tmp, file);
  }
  return file;
}

/** Managed (policy) settings that switch hooks off or pin hooks to the managed set: the guard would not run. */
const MANAGED_SETTINGS = ['/etc/claude-code/managed-settings.json', '/Library/Application Support/ClaudeCode/managed-settings.json'];

export function assertNoManagedOverride(files: readonly string[] = MANAGED_SETTINGS): void {
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      throw new Error(`cannot read managed settings ${file}: ${(error as Error).message}`);
    }
    let managed: unknown;
    try { managed = JSON.parse(text); } catch { throw new Error(`managed settings ${file} are not valid JSON; not waking an agent that may run without the guard`); }
    if (isRecord(managed) && (managed.disableAllHooks === true || managed.allowManagedHooksOnly === true)) {
      throw new Error(`managed settings ${file} turn off project hooks (disableAllHooks or allowManagedHooksOnly); the guard would not run, so no agent is woken`);
    }
  }
}

/**
 * Prove that `file` would block: it parses, hooks are not disabled, the PreToolUse `*` hook is the guard, and that exact
 * command, run the way Claude runs it, refuses a call no approval can unlock (`courier pair`, which needs no network).
 * Throws with the reason otherwise.
 */
export function verifyProjectGuard(file: string, cwd: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`guard settings ${file} are unreadable: ${(error as Error).message}`);
  }
  if (!isRecord(parsed) || parsed.disableAllHooks !== false) throw new Error(`guard settings ${file} do not keep hooks enabled`);
  // Nothing but the guard's own hook and deny rules (B1): any other hook event, `env`, `apiKeyHelper`, MCP server or allow rule can run a command.
  const extraKeys = Object.keys(parsed).filter((key) => !['disableAllHooks', 'hooks', 'permissions'].includes(key));
  if (extraKeys.length) throw new Error(`guard settings ${file} carry other settings (${extraKeys.join(', ')}); only the guard's hook and deny rules are allowed`);
  const hookEvents = isRecord(parsed.hooks) ? Object.keys(parsed.hooks) : [];
  if (hookEvents.length !== 1 || hookEvents[0] !== 'PreToolUse') throw new Error(`guard settings ${file} define other hook events (${hookEvents.join(', ')}); only the guard's PreToolUse hook is allowed`);
  const permKeys = isRecord(parsed.permissions) ? Object.keys(parsed.permissions) : [];
  if (permKeys.some((key) => key !== 'deny')) throw new Error(`guard settings ${file} carry permission rules other than deny rules`);
  assertNoManagedOverride();
  const hooks = isRecord(parsed.hooks) && Array.isArray(parsed.hooks.PreToolUse) ? parsed.hooks.PreToolUse : [];
  if (hooks.length !== 1) throw new Error(`guard settings ${file} must hold exactly one PreToolUse entry (found ${hooks.length})`);
  let command: string | undefined;
  for (const entry of hooks) {
    if (!isRecord(entry) || entry.matcher !== '*' || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (isRecord(hook) && hook.type === 'command' && typeof hook.command === 'string' && GUARD_HOOK_RE.test(hook.command)) command = hook.command;
    }
  }
  if (!command) throw new Error(`guard settings ${file} have no courier guard hook`);
  const probe = spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'courier pair start probe' }, cwd }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  let denied = probe.status === 2;
  if (probe.status === 0 && probe.stdout.trim()) {
    try {
      const out: unknown = JSON.parse(probe.stdout);
      const decision = isRecord(out) && isRecord(out.hookSpecificOutput) ? out.hookSpecificOutput.permissionDecision : undefined;
      denied = decision === 'deny';
    } catch { /* not JSON: not a denial */ }
  }
  if (!denied) throw new Error('the guard hook did not refuse a probe command; not waking an agent without a working guard');
}

/** Paseo env for a run: the caller's own agent and workspace must not redirect `--cwd`. */
export function paseoEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of PASEO_CALLER_ENV) delete env[name];
  return env;
}

/** True if `provider` (`claude` or `claude/<model>`) is Claude Code, the only agent the project hook covers. */
export const isClaudeProvider = (provider: string) => /^claude(\/|$)/.test(provider);

export function sameDir(a: string, b: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}
