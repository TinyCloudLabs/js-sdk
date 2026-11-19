import fs from 'node:fs';
import path from 'node:path';
import { agentHome, profileId } from './install.js';
import { spawnSync } from 'node:child_process';

/**
 * A separate HOME for woken agents. The clean HOME holds Claude's login (for Claude wakes),
 * the git user.name/email identity and explicitly selected --home-file copies.
 * Session files stay between wakes for --resume. Shell start-up files are removed on every wake.
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
  /** Exec adapters need no model login. */
  claude?: boolean;
  /** The agent CLI the exec command starts (`codex`, `omp`, …), if it starts one: which `--home-file` login files are allowed. */
  agentCli?: string;
}

export interface CleanHome {
  home: string;
  configDir: string;
  /** What was put there, relative to the clean HOME (for the log line). */
  exposed: string[];
  /** Symbolic links the agent had planted in the clean HOME since the last wake; each was removed (the link, never its target). */
  removedLinks: string[];
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

/** Never reused from a previous wake and never copied in: user settings, MCP config and credential tool directories. */
const SCRUBBED = ['.claude.json', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.config/gh', '.config/git', '.npmrc', '.netrc', '.ssh', '.aws'];

const under = (rel: string, roots: readonly string[]) => roots.some((f) => rel === f || rel.startsWith(`${f}/`));

/** Owner tool state and credential stores no `--home-file` may name, whatever else is allowed: refused with their own message. */
const DENIED_ROOTS = ['.omp', '.tinycloud', '.gnupg', '.docker', '.kube', '.config/gcloud', '.paseo'];

/**
 * The model-login file each supported agent CLI keeps in a file of the owner's HOME, and the only files `--home-file`
 * copies. Settings files are not logins (they can name MCP servers, hooks and extensions that run commands), so none is listed.
 * An empty list means the CLI's login cannot be carried by one file; hand it the login another way (`--env-pass`).
 *  - codex: ~/.codex/auth.json (checked on a host with codex installed).
 *  - gemini: ~/.gemini/oauth_creds.json (newer versions may keep it in the OS keychain instead: then there is nothing to copy).
 *  - opencode: ~/.local/share/opencode/auth.json. amp: ~/.local/share/amp/secrets.json (Amp's security reference).
 *  - goose: ~/.config/goose/secrets.yaml (only when goose uses file storage; its default is the keyring).
 *  - aider: ~/.aider/oauth-keys.env (the OpenRouter key from aider's own sign-in).
 *  - omp: none. Its login is inside ~/.omp/agent/agent.db together with every account and its state; copying it hands over all of them.
 *  - cursor-agent: none. Cursor does not publish where the CLI keeps its credentials.
 */
export const MODEL_LOGIN_FILES: Readonly<Record<string, readonly string[]>> = {
  codex: ['.codex/auth.json'],
  gemini: ['.gemini/oauth_creds.json'],
  opencode: ['.local/share/opencode/auth.json'],
  amp: ['.local/share/amp/secrets.json'],
  goose: ['.config/goose/secrets.yaml'],
  aider: ['.aider/oauth-keys.env'],
  omp: [],
  'cursor-agent': [],
};

const NO_LOGIN_FILE: Readonly<Record<string, string>> = {
  omp: 'its login sits in a database with every account and its state, so no single file can carry just a login',
  'cursor-agent': 'it does not publish where its credentials are kept',
};

/** Which login files `--home-file` may name: none for the claude adapter, the started CLI's, or (a wrapper command) every supported CLI's. */
function allowedLoginFiles(target: HomeFileTarget): { files: readonly string[]; cli?: string } {
  if (target.adapter === 'claude') return { files: [] };
  const cli = target.agentCli;
  if (cli !== undefined && cli in MODEL_LOGIN_FILES) return { files: MODEL_LOGIN_FILES[cli]!, cli };
  return { files: [...new Set(Object.values(MODEL_LOGIN_FILES).flat())] };
}

/** What a `--home-file` is for: the adapter, and the agent CLI an exec command starts (if any). */
export interface HomeFileTarget {
  adapter?: string;
  agentCli?: string;
}

/** Why `--home-file <rel>` is refused, before anything is read: the same rules at start-up and on every wake. */
export function homeFileRefusal(rel: string, target: HomeFileTarget = {}): string | undefined {
  const normal = path.posix.normalize(rel.split(path.sep).join('/'));
  const name = `--home-file ${JSON.stringify(rel)}`;
  if (!rel || path.isAbsolute(rel) || normal === '.' || normal === '..' || normal.startsWith('../')) return `${name} must be a path inside the home directory`;
  if (under(normal, SHELL_STARTUP_FILES)) return `${name} is a shell start-up file and is never copied`;
  if (under(normal, SCRUBBED)) return `${name} is tool configuration or a credential store the clean HOME never holds`;
  if (under(normal, DENIED_ROOTS)) return `${name} is owner tool state or a credential store (${DENIED_ROOTS.join(', ')}) and is never copied`;
  const { files, cli } = allowedLoginFiles(target);
  if (files.includes(normal)) return undefined;
  if (target.adapter === 'claude') return `${name} is not needed with --wake claude: its login is copied automatically, and no other file is`;
  if (cli !== undefined && files.length === 0) return `${name} is refused: ${cli} cannot take a login through --home-file (${NO_LOGIN_FILE[cli] ?? 'no login file is known'}); give it the login with --env-pass or run it under its own account`;
  const known = files.map((file) => JSON.stringify(file)).join(', ');
  return `${name} is not a model-login file${cli ? ` of ${cli}` : ' of a supported agent CLI'} (only ${known} can be copied)`;
}

function copyFile(from: string, to: string, mode: number): boolean {
  try {
    if (!fs.statSync(from).isFile()) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.rmSync(to, { force: true });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * `rel` (a relative path with `/` separators) inside the clean HOME, ready to be made, removed or written. The agent controls
 * the clean HOME between wakes and may have planted a link there, so every component that exists is checked with lstat
 * (never followed): a link is removed (the link only, never its target) and recorded in `removed`, and the caller then
 * recreates a real directory or file. Anything below a removed link is out of view, so nothing deeper needs checking.
 */
function ownedPath(home: string, rel: string, removed: string[]): string {
  let current = home;
  for (const part of rel.split('/').filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      break;
    }
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(current);
      removed.push(path.relative(home, current));
      break;
    }
  }
  return path.join(home, rel);
}

/** A source that is, or sits behind, a symbolic link: refused, never followed. */
class LinkRefused extends Error {}

/**
 * Read one file of the owner's HOME without following a link: the path must resolve to exactly itself inside the real HOME
 * (no link on the file or on any directory above it), it is opened with O_NOFOLLOW, and it must still be the same inode
 * afterwards. Returns the bytes, or throws with the reason (`LinkRefused` for a link). `name` says what is being copied.
 */
function readHomeFile(realHome: string, rel: string, name = `--home-file ${JSON.stringify(rel)}`): Buffer {
  const from = path.join(realHome, rel);
  let expected: string;
  let resolved: string;
  try {
    expected = path.join(fs.realpathSync(realHome), path.posix.normalize(rel.split(path.sep).join('/')));
    resolved = fs.realpathSync(from);
  } catch {
    throw new Error(`${name} is not a readable file in ${realHome}`);
  }
  if (resolved !== expected) throw new LinkRefused(`${name} is a symbolic link or sits behind one and is never followed; name the real file inside ${realHome}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error('not a regular file');
    const still = fs.lstatSync(expected);
    if (still.isSymbolicLink() || still.dev !== opened.dev || still.ino !== opened.ino) throw new Error('changed while it was read');
    return fs.readFileSync(fd);
  } catch (error) {
    throw new Error(`${name} is not a readable regular file in ${realHome} (${error instanceof Error && /changed while|regular file/.test(error.message) ? error.message : 'it could not be opened without following a link'})`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Build (or refresh) the clean HOME. Throws if it cannot be made safe; the wake then fails closed. */
export function prepareCleanHome(options: CleanHomeOptions): CleanHome {
  const realHome = path.resolve(options.realHome);
  const home = path.resolve(options.cleanHome);
  if (home === realHome || realHome.startsWith(`${home}${path.sep}`) || home.startsWith(`${realHome}${path.sep}.`)) {
    throw new Error(`the clean HOME ${home} must be a directory of its own, not the real HOME or a dot-directory inside it`);
  }
  // The clean HOME itself must not be a link: a swapped-in link would send every write below somewhere else.
  try {
    if (fs.lstatSync(home).isSymbolicLink()) throw new Error(`the clean HOME ${home} is a symbolic link; remove it so Courier can make a directory of its own`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const exposed: string[] = [];
  const removedLinks: string[] = [];

  for (const rel of SHELL_STARTUP_FILES) {
    if (inside(home, rel)) fs.rmSync(ownedPath(home, rel.split(path.sep).join('/'), removedLinks), { recursive: true, force: true });
  }

  const claudeDir = ownedPath(home, '.claude', removedLinks);
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  const credential = ownedPath(home, '.claude/.credentials.json', removedLinks);
  fs.rmSync(credential, { force: true });
  if (options.claude !== false) {
    // The owner's Claude login, read like a --home-file: a link on the file or above it is refused (the wake fails closed);
    // a missing or unreadable file is skipped as before, and the agent then has no Claude login.
    let login: Buffer | undefined;
    try {
      login = readHomeFile(realHome, '.claude/.credentials.json', 'the Claude login ".claude/.credentials.json"');
    } catch (error) {
      if (error instanceof LinkRefused) throw error;
    }
    if (login) {
      fs.writeFileSync(credential, login, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(credential, 0o600);
      exposed.push('.claude/.credentials.json');
    }
  }
  // Never reuse user settings, MCP config, shell files or credential tool directories from a previous wake.
  for (const rel of SCRUBBED) fs.rmSync(ownedPath(home, rel, removedLinks), { recursive: true, force: true });
  for (const rel of ['.config', '.local/share', '.cache', '.local/state', '.runtime']) fs.mkdirSync(ownedPath(home, rel, removedLinks), { recursive: true, mode: 0o700 });

  const git = gitIdentity(realHome);
  const gitconfig = ownedPath(home, '.gitconfig', removedLinks);
  fs.rmSync(gitconfig, { force: true });
  if (git) {
    fs.writeFileSync(gitconfig, git, { mode: 0o600, flag: 'wx' });
    exposed.push('.gitconfig (user.name, user.email)');
  }

  for (const rel of options.files ?? []) {
    const refusal = homeFileRefusal(rel, { adapter: options.claude === false ? 'exec' : 'claude', agentCli: options.agentCli });
    const to = inside(home, rel) ? ownedPath(home, rel.split(path.sep).join('/'), removedLinks) : undefined;
    if (refusal || !inside(realHome, rel) || !to) throw new Error(refusal ?? `--home-file ${JSON.stringify(rel)} must be a path inside the home directory`);
    const bytes = readHomeFile(realHome, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.rmSync(to, { force: true });
    fs.writeFileSync(to, bytes, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(to, 0o600);
    exposed.push(rel);
  }
  return { home, configDir: claudeDir, exposed, removedLinks };
}

/** Copy only the Courier identity, never broker state or a pointer to its directory. Returns the planted links it removed. */
export function prepareAgentProfile(courierHome: string): string[] {
  const home = agentHome(courierHome);
  const removed: string[] = [];
  const dir = ownedPath(home, '.courier', removed);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  for (const name of ['profile.json', 'key.json', 'grant.json']) {
    const from = path.join(courierHome, name);
    if (fs.existsSync(from) && !copyFile(from, ownedPath(home, `.courier/${name}`, removed), 0o600)) throw new Error('Cannot prepare agent Courier identity');
  }
  const marker = ownedPath(home, '.courier-agent.json', removed);
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(marker, JSON.stringify({ v: 1, profileId: profileId(courierHome) }), { mode: 0o600, flag: 'wx' });
  for (const name of ['tmp', 'no-owner-profile']) fs.mkdirSync(ownedPath(home, name, removed), { recursive: true, mode: 0o700 });
  return removed;
}
