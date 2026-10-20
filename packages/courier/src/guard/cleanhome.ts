import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * A clean HOME for woken agents. The shell reads its start-up files through `$HOME`, so an agent whose HOME is an empty
 * directory cannot source `~/.bashrc`, `~/.profile` or `~/.zshenv`, even through `bash -lc` or `bash -ic`, and cannot
 * reach `~/.config/gh`, `~/.npmrc`, `~/.ssh` and the rest by `~` or `$HOME`. (An absolute path to the real home still
 * resolves: that is the residual risk the README names, and the reason to prefer a dedicated OS user.)
 *
 * The clean HOME holds only what an agent needs to run:
 *  - Claude Code's login, `<real>/.claude/.credentials.json`, copied into `<clean>/.claude/` (the one credential the
 *    agent can read here: the account it is running as);
 *  - a `.gitconfig` with the owner's `user.name` and `user.email` and nothing else (no credential helper);
 *  - files the operator named with `--home-file`, copied as they are (a deliberate hole).
 * Session files Claude writes under `<clean>/.claude/` stay between wakes so `--resume` works. Shell start-up files an
 * earlier wake left behind are removed on every wake.
 */

/** Start-up files of the common shells, removed from the clean HOME before every wake. */
export const SHELL_STARTUP_FILES = [
  '.bashrc', '.bash_profile', '.bash_login', '.profile', '.bash_logout', '.inputrc',
  '.zshenv', '.zprofile', '.zshrc', '.zlogin', '.zlogout', '.shrc', '.kshrc', '.cshrc', '.tcshrc', '.login',
  '.config/fish', '.config/environment.d', '.pam_environment',
];

export interface CleanHomeOptions {
  /** The owner's real HOME: where Claude's login and the git identity are read from. */
  realHome: string;
  /** The empty HOME the agent gets. */
  cleanHome: string;
  /** Extra files relative to `realHome`, copied on purpose (`--home-file`). */
  files?: readonly string[];
}

export interface CleanHome {
  home: string;
  configDir: string;
  /** What was put there, relative to the clean HOME (for the log line). */
  exposed: string[];
}

const GIT_KEYS = ['user.name', 'user.email'];

function gitIdentity(realHome: string): string {
  const lines: string[] = [];
  for (const key of GIT_KEYS) {
    const r = spawnSync('git', ['config', '--global', '--get', key], {
      encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: realHome, GIT_CONFIG_NOSYSTEM: '1' },
    });
    const value = r.status === 0 ? r.stdout.trim() : '';
    if (value && !/[\n\r\0]/.test(value)) lines.push(`\t${key.split('.')[1]} = ${JSON.stringify(value)}`);
  }
  return lines.length ? `[user]\n${lines.join('\n')}\n` : '';
}

/** `rel` as a path inside `root`, or undefined if it is absolute or climbs out. */
function inside(root: string, rel: string): string | undefined {
  if (!rel || path.isAbsolute(rel)) return undefined;
  const full = path.resolve(root, rel);
  return full === root || !full.startsWith(`${root}${path.sep}`) ? undefined : full;
}

function copyFile(from: string, to: string, mode: number): boolean {
  try {
    if (!fs.statSync(from).isFile()) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.rmSync(to, { force: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, mode);
    return true;
  } catch {
    return false;
  }
}

/** Build (or refresh) the clean HOME. Throws if it cannot be made safe; the wake then fails closed. */
export function prepareCleanHome(options: CleanHomeOptions): CleanHome {
  const realHome = path.resolve(options.realHome);
  const home = path.resolve(options.cleanHome);
  if (home === realHome || realHome.startsWith(`${home}${path.sep}`) || home.startsWith(`${realHome}${path.sep}.`)) {
    throw new Error(`the clean HOME ${home} must be a directory of its own, not the real HOME or a dot-directory inside it`);
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const exposed: string[] = [];

  for (const rel of SHELL_STARTUP_FILES) {
    const target = inside(home, rel);
    if (target) fs.rmSync(target, { recursive: true, force: true });
  }

  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  if (copyFile(path.join(realHome, '.claude', '.credentials.json'), path.join(claudeDir, '.credentials.json'), 0o600)) exposed.push('.claude/.credentials.json');

  const git = gitIdentity(realHome);
  const gitconfig = path.join(home, '.gitconfig');
  fs.rmSync(gitconfig, { force: true });
  if (git) {
    fs.writeFileSync(gitconfig, git, { mode: 0o600 });
    exposed.push('.gitconfig (user.name, user.email)');
  }

  for (const rel of options.files ?? []) {
    const from = inside(realHome, rel);
    const to = inside(home, rel);
    if (!from || !to) throw new Error(`--home-file ${JSON.stringify(rel)} must be a path inside the home directory`);
    if (SHELL_STARTUP_FILES.some((f) => rel === f || rel.startsWith(`${f}/`))) throw new Error(`--home-file ${JSON.stringify(rel)} is a shell start-up file and is never copied`);
    if (!copyFile(from, to, 0o600)) throw new Error(`--home-file ${JSON.stringify(rel)} is not a readable file in ${realHome}`);
    exposed.push(rel);
  }
  return { home, configDir: claudeDir, exposed };
}
