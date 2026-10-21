import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Paths and words a woken agent has no business with (R2, B1, B2). Three layers use this module:
 *  - `credentialTextRefusal` / `protectedTextRefusal`: substring checks on the raw command text (quotes and backslashes
 *    removed first), so `cat ~/.n"p"mrc` and a glob into `.config` are refused. A shell can still build a path
 *    out of pieces; the inverted expansion rule and the clean HOME cover that, and the README says what is left.
 *  - `isProtectedFile`: the file tools (Edit, Write, Read, …), compared on real paths so a symlink does not hide a target.
 */

/** Where credentials live. A command that names one is refused, whether it reads or writes. */
const CREDENTIAL_SUBSTRINGS = [
  '.config/gh', '.config/gcloud', '.config/wrangler', '.config/.wrangler', '.wrangler', '.npmrc', '.netrc', '.ssh', '.aws', '.docker/config',
  '.git-credentials', '.claude/.credentials', '.claude.json', '.paseo', '.tinycloud', 'hosts.yml', '.courier/broker', 'broker/gh.json',
  'application_default_credentials', '.kube/config', '.gnupg', '.password-store', '.local/share/keyrings',
];

/** Config and hook files that decide what runs next: writing them could switch the guard off or add a command. */
const PROTECTED_SUBSTRINGS = [
  '.courier-agent.json', '.claude/settings', 'settings.local.json', '.claude/hooks', '.claude/commands', '.claude/agents', '.mcp.json', '.git/hooks', '.git/config', 'guard/settings.json',
  '.config/git', '.gitconfig', '.git-hooks',
];

const CREDENTIAL_PATTERNS: [string, RegExp][] = [
  ['owner shell startup files', /(?:^|[\s/])\.(?:bashrc|bash_profile|bash_login|profile|zshenv|zshrc|zprofile)(?:[\s/]|$)/i],
  ['a glob in a process environment path', /\/proc\/[^\s]*[*?[]/i],
  ['a glob hiding a credential directory', /(?:^|[\s/])[^\s/]*[*?[][^\s/]*(?:config|tinycloud|courier)[^\s/]*\//i],
  ['a glob hiding gh hosts', /(?:^|[\s/])host[^\s/]*[*?[][^\s/]*\.ya?ml/i],
  ['an embedded privilege command', /['"(;]\s*(?:sudo|doas|pkexec|runuser)\s/i],
  ['process environments (/proc/*/environ)', /\/proc\b[^\n]*environ/i],
  ['a glob in a dot-directory under .config', /\.config\/[^\s/]*[*?[]/],
  ['a glob in a dot-file name', /(^|[\s/=:])\.[A-Za-z_-]+[*?[]/],
  ['a credential-printing command (gh auth, gh config)', /(^|[\s/;&|(`])gh\s+(auth|config|extension)(\s|$)/],
  ['a credential-printing command (git credential)', /(^|[\s/;&|(`])git\s+([^\s]+\s+)*credential(\s|$|-)/],
  ['a credential-printing command (npm/yarn/pnpm config)', /(^|[\s/;&|(`])(npm|yarn|pnpm|bun)\s+config(\s|$)/],
  ['a keyring or secret-store command', /(^|[\s/;&|(`])(secret-tool|keyctl|gnome-keyring-daemon|pass|gpg|gpg2|ssh-add|ssh-agent|security\s+(find|dump|export)[-\w]*)(\s|$)/],
];

/** Quotes and backslashes removed, so `.n"p"mrc` and `.n\pmrc` read as the name they spell. */
export const unquoted = (text: string) => text.replace(/\$?['"]/g, '').replace(/\\\n/g, '').replace(/\\/g, '');

const variants = (text: string) => [text, unquoted(text)];

export function credentialTextRefusal(text: string): string | undefined {
  for (const t of variants(text)) {
    const lower = t.toLowerCase();
    for (const s of CREDENTIAL_SUBSTRINGS) if (lower.includes(s)) return `it names a credential path (${s})`;
    for (const [label, re] of CREDENTIAL_PATTERNS) if (re.test(t)) return `it uses ${label}`;
  }
  return undefined;
}

/** `literals`: absolute paths of this install (courier home, guard dir, package roots) that a command must not name. */
export function protectedTextRefusal(text: string, literals: readonly string[] = []): string | undefined {
  for (const t of variants(text)) {
    for (const s of PROTECTED_SUBSTRINGS) if (t.includes(s)) return `it names a guard or tool configuration file (${s})`;
    for (const literal of literals) if (literal && t.includes(literal)) return `it names the Courier install or profile directory (${literal})`;
  }
  return undefined;
}

// ---------- file tools ----------

/** The real path of `file`, even when it does not exist yet: the nearest existing ancestor is resolved, the rest appended. */
export function realpathBest(file: string): string {
  const abs = path.resolve(file);
  let probe = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...tail.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return abs;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

const within = (file: string, root: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/** Every directory from `from` up to the filesystem root. */
function ancestors(from: string): string[] {
  const out: string[] = [];
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    out.push(dir);
    if (path.dirname(dir) === dir) return out;
  }
}

/** Names that must not be written in any directory above the agent's cwd. */
const PER_DIRECTORY = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks', '.claude/commands', '.claude/agents', '.mcp.json', '.git/hooks', '.git/config', '.gitmodules'];

/** Names under a home directory (the real one and the agent's clean one). */
const PER_HOME = ['.courier-agent.json', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks', '.claude/commands', '.claude/agents', '.claude.json', '.gitconfig', '.config/git', '.bashrc', '.bash_profile', '.profile', '.zshenv', '.zshrc', '.zprofile', '.npmrc'];

export interface ProtectedSet {
  /** Absolute paths (courier home, guard install dir, node_modules chain, package roots): nothing under them may be written. */
  roots: string[];
  /** Home directories whose tool configuration may not be written. */
  homes: string[];
  realHome?: string;
}

/** True if `file` (relative to `cwd`) may not be written by a woken agent. Compares real paths. */
export function isProtectedFile(file: string, cwd: string, set: ProtectedSet): boolean {
  const home = set.homes[set.homes.length - 1] ?? process.env.HOME ?? '';
  const expanded = file.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  const real = realpathBest(path.resolve(cwd, expanded));
  for (const root of set.roots) if (within(real, realpathBest(root))) return true;
  for (const dir of ancestors(cwd)) for (const rel of PER_DIRECTORY) if (within(real, realpathBest(path.join(dir, rel)))) return true;
  for (const home of set.homes) for (const rel of PER_HOME) if (within(real, realpathBest(path.join(home, rel)))) return true;
  return false;
}

/** True if a file tool (Read, Grep, Glob, Edit, …) names a credential path. */
export function isCredentialFile(file: string, cwd: string): boolean {
  const abs = path.resolve(cwd, file);
  return credentialTextRefusal(abs) !== undefined || credentialTextRefusal(realpathBest(abs)) !== undefined;
}

/**
 * Directories to protect for this install: the entry's directory, its package root (the first `package.json` above it)
 * and every `node_modules` directory the hook's imports can resolve to (the ones above the entry). Not the repository
 * around them: a developer's checkout stays editable.
 */
export function installRoots(entry: string): string[] {
  const real = realpathBest(entry);
  const roots = new Set<string>([path.dirname(real)]);
  let sawPackage = false;
  for (const dir of ancestors(path.dirname(real))) {
    if (!sawPackage && fs.existsSync(path.join(dir, 'package.json'))) { roots.add(dir); sawPackage = true; }
    if (path.basename(dir) === 'node_modules') roots.add(dir);
    if (fs.existsSync(path.join(dir, 'node_modules'))) roots.add(path.join(dir, 'node_modules'));
  }
  roots.delete(path.parse(real).root);
  return [...roots];
}

export function protectedSet(home: string, entry: string, extra: { agentHome?: string } = {}): ProtectedSet {
  return {
    roots: [path.resolve(home), ...installRoots(entry)],
    homes: [...new Set([os.homedir(), ...(extra.agentHome ? [extra.agentHome] : [])])],
  };
}

/** Reads/searches must not descend into protected state or enumerate an ancestor that contains it. */
export function isProtectedRead(file: string, cwd: string, set: ProtectedSet): boolean {
  const home = set.homes[set.homes.length - 1] ?? process.env.HOME ?? '';
  const expanded = file.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  const real = realpathBest(path.resolve(cwd, expanded));
  for (const root of set.roots) {
    const r = realpathBest(root);
    if (within(real, r) || within(r, real)) return true;
  }
  const owner = set.realHome ?? set.homes[0];
  if (owner && within(real, realpathBest(owner)) && !within(real, realpathBest(cwd))) return true;
  return false;
}

/** Check literal shell paths by realpath, including symlinks and broad ancestor searches. */
export function pathTextRefusal(text: string, cwd: string, home: string, roots: readonly string[], realHome?: string): string | undefined {
  const flat = unquoted(text);
  if (/\bCOURIER_(HOME|REAL_HOME|BROKER\w*)\b/.test(flat) || /(?:~|\$\{?HOME\}?)\/\.\.(?:\/|\s|$)/.test(flat)) return 'broker/profile environment or home traversal';
  for (let word of flat.split(/[\s;&|<>]+/)) {
    if (!word || word.startsWith('-') || word.includes('://')) continue;
    word = word.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
    if (!word.includes('/') && word !== '.' && word !== '..') continue;
    const prefix = word.split(/[*?[]/, 1)[0];
    const file = prefix || '.';
    if (isProtectedRead(file, cwd, { roots: [...roots], homes: realHome ? [realHome] : [], realHome })) return 'a protected root or its parent';
  }
  return undefined;
}
