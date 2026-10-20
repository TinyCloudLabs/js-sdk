import path from 'node:path';
import { parseShell, wordLiteral, type RawCmd, type RawWord } from './shell.js';
import { expansionRefusal } from './expansion.js';
import { credentialTextRefusal, protectedTextRefusal, realpathBest, unquoted } from './paths.js';
import { parseArgs } from '../args.js';
import { ULID } from '../request.js';
import type { Verb } from './target.js';
import {
  normApi, normChangeset, normGhPrMerge, normGhRelease, normGhWorkflowRun, normPhala, normPublish, normPush, normScript, normWrangler,
  releaseIsReadOnly, type Norm, type NormCtx,
} from './normalize.js';

/**
 * Which shell commands a woken agent may not run on its own (spec §7), found by reading the command the way a shell
 * would. Best effort, not a sandbox: it reads quoting, wrappers, chains, subshells and nested `sh -c`/`eval`, and it
 * treats everything it cannot read exactly as a reason to refuse, never as a reason to allow.
 */

export interface Word { value: string; dynamic: boolean }

export type Finding =
  /** A gated command with a fully literal argv; `key` identifies it for approval matching. */
  | { kind: 'gated'; label: string; verb: Verb; target: string; key: string; display: string }
  /** Never allowed in a guarded session, with or without approval. */
  | { kind: 'never'; label: string }
  /** Could be a gated command and cannot be told apart or approved (dynamic words, loops, scripts, pipes). */
  | { kind: 'unresolved'; label: string };

export type FileRead = { state: 'absent' } | { state: 'unreadable' } | { state: 'text'; text: string };

export interface PolicyEnv {
  /** Working directory the tool call starts in. */
  cwd: string;
  readFile(file: string): FileRead;
  /** Run `git <args>` in `dir`; ok=false on any failure. */
  git(dir: string, args: string[]): { ok: boolean; out: string };
  /** Environment variable of the guard process (the woken agent's environment). */
  getenv(name: string): string | undefined;
  /** Absolute paths of this install and profile (courier home, guard dir, package roots) that a command must not name. */
  literals?: string[];
  /** Real paths of the courier entry points (`cli.js`, the `tc` entry): `node <entry> pair …` is a courier command. */
  courierEntries?: string[];
}

/** The exec opt-out never starts a second agent CLI. */
export function startsAgentCli(command: string): boolean {
  const head = parseShell(command).cmds[0]?.words[0];
  const literal = head ? wordLiteral(head) : undefined;
  return literal !== undefined && AGENT_CLIS.has(progName(literal));
}

const MAX_DEPTH = 6;
const PLACEHOLDER = '\u0001';

// ---------- tables ----------

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'csh', 'tcsh', 'fish']);
/** Programs that start another coding agent. A woken agent may not launch one: it would run outside the guard. */
const AGENT_CLIS = new Set(['paseo', 'claude', 'codex', 'omp', 'opencode', 'gemini', 'cursor-agent', 'amp', 'aider', 'goose']);
/** Programs that run another program given in their arguments. */
const WRAPPERS = new Set([
  'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'setsid', 'stdbuf', 'timeout',
  'unbuffer', 'chronic', 'flock', 'script', 'strace', 'ltrace', 'taskset', 'chrt',
  'watch', 'parallel', 'xargs', 'find', 'trap', 'caffeinate', 'xvfb-run',
  'dbus-run-session', 'xdotool', 'nsjail', 'firejail', 'busybox', 'toybox', 'entr', 'cronic', 'cpulimit',
]);
/**
 * Programs a woken agent never runs: they change user or namespace (sudo works without a password on some hosts), start
 * a session that outlives the call (tmux, screen, cron, systemd, launchd, at), reach another machine or a loopback service
 * such as the Paseo daemon (ssh, nc, socat), or hand out credentials.
 */
const NEVER_PROGS = new Set([
  'sudo', 'doas', 'su', 'runuser', 'pkexec', 'setpriv', 'unshare', 'nsenter', 'chroot', 'machinectl', 'run0',
  'tmux', 'screen', 'byobu', 'zellij', 'crontab', 'at', 'batch', 'systemctl', 'systemd-run', 'launchctl', 'loginctl',
  'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'socat', 'telnet',
]);
/** Variables a woken agent may not set for a command: they redirect the profile, the home, the shell or the tools. */
const SENSITIVE_VAR = /^(COURIER_|TC_|XDG_|GH_|GITHUB_|GIT_|CLAUDE_|ANTHROPIC_|NPM_|NODE_|LD_|DYLD_|PASEO_|CLOUDFLARE_|WRANGLER_|PHALA_|AWS_|SSH_|BASH_|HOME$|PATH$|SHELL$|ENV$|ZDOTDIR$)/;

/** Wrappers that run the inner command more than once (or an unknown number of times): approvals cannot cover those. */
const REPEATERS = new Set(['xargs', 'parallel', 'find', 'watch', 'trap', 'at', 'batch', 'entr']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'perl', 'ruby', 'php', 'lua', 'luajit', 'tsx', 'ts-node', 'osascript', 'bun']);
const SOURCE_EXT = /\.(py|js|mjs|cjs|ts|mts|rb|pl|php|lua|sh|bash|zsh)$/i;
const NPM_FAMILY = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'corepack']);
const CURLS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'xhs', 'aria2c']);
const SCRIPT_NAME = /^(deploy|publish|release)(:|$)/i;
const PKG_NAMES: Record<string, string> = {
  '@anthropic-ai/claude-code': 'claude', '@openai/codex': 'codex', '@tinycloud/cli': 'tinycloud', '@changesets/cli': 'changeset', '@phala/cli': 'phala',
};
const EMBEDDED = new Set(['claude', 'codex', 'semantic-release', 'turbo', 'nx', 'gh', 'git', 'wrangler', 'phala', 'changeset', 'tc', 'tinycloud', 'courier', 'secret-bridge', 'curl', 'wget']);
const GIT_BUILTINS = new Set((
  'add am apply archive bisect blame branch bundle cat-file check-ignore checkout cherry-pick clean clone commit config describe diff ' +
  'difftool fetch for-each-ref format-patch fsck gc grep hash-object help init log ls-files ls-remote ls-tree maintenance merge ' +
  'merge-base mergetool mv name-rev notes pull push range-diff rebase reflog remote request-pull reset restore rev-list rev-parse ' +
  'revert rm send-email shortlog show show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-ref ' +
  'version whatchanged worktree'
).split(' '));

// Pre-compiled patterns for GitHub API calls that merge PRs or write refs (REST and GraphQL), best effort.
const MERGE_API: RegExp[] = [
  /\/pulls\/[^\/\s]*\/merge\b/i,
  /\/repos\/[^\/\s]+\/[^\/\s]+\/merges\b/i,
  /\/git\/refs\/(heads\/)?(main|master)\b/i,
  /\bmergePullRequest\b|\benablePullRequestAutoMerge\b|\bmergeBranch\b|\bupdateRef\b|\bcreateCommitOnBranch\b/i,
];

const mergeApi = (text: string) => MERGE_API.some((re) => re.test(text));

/** Phrases that mean a gated action when they appear inside code a script interpreter will run. */
const CODE_PHRASES: [string, RegExp][] = [
  ['gh pr merge', /\bgh pr merge\b/],
  ['gh workflow run', /\bgh workflow run\b/],
  ['gh release', /\bgh release\b/],
  ['publish', /\b(npm|bun|pnpm|yarn|changeset|npx|bunx) (\S+ )*?publish\b/],
  ['wrangler deploy', /\bwrangler (\S+ ){0,4}(deploy|publish)\b/],
  ['phala deploy', /\bphala (\S+ ){0,4}deploy\b/],
  ['git push to main', /\bgit (\S+ ){0,6}push (\S+ ){0,8}?\S*\b(main|master)\b/],
  ['tc secrets', /\b(tc|tinycloud) (\S+ ){0,4}secrets?\b/],
  ['secret bridge', /secret[-_]?bridge/],
];

function codeHits(text: string): string[] {
  const hits: string[] = [];
  if (mergeApi(text)) hits.push('GitHub API merge or ref write');
  const flat = text.replace(/["'`,\[\](){};]/g, ' ').replace(/\s+/g, ' ');
  for (const [label, re] of CODE_PHRASES) if (re.test(flat)) hits.push(label);
  return hits;
}

// ---------- word resolution ----------

interface Census {
  defs: Map<string, RawWord>;
  counts: Map<string, number>;
  taintAll: boolean;
  ifs: boolean;
}

const ASSIGN_BUILTINS = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);
const READ_BUILTINS = new Set(['read', 'mapfile', 'readarray', 'getopts', 'unset', 'printf', 'let']);

function census(cmds: RawCmd[]): Census {
  const c: Census = { defs: new Map(), counts: new Map(), taintAll: false, ifs: false };
  const bump = (name: string, by: number) => {
    c.counts.set(name, (c.counts.get(name) ?? 0) + by);
    if (name === 'IFS') c.ifs = true;
  };
  for (const cmd of cmds) {
    for (const a of cmd.assigns) { bump(a.name, a.append ? 2 : 1); c.defs.set(a.name, a.value); }
    for (const n of cmd.forVars) bump(n, 2);
    const head = cmd.words.length ? wordLiteral(cmd.words[0]) : undefined;
    if (head === undefined && cmd.words.length) {
      // A head decided at run time could be `eval`, `read`, ...: stop trusting any variable.
      if (cmd.words[0].parts.some((p) => p.t === 'dyn' || p.t === 'var')) c.taintAll = c.taintAll || false;
      continue;
    }
    if (head === 'eval' || head === 'source' || head === '.') c.taintAll = true;
    if (head && ASSIGN_BUILTINS.has(head)) {
      for (const w of cmd.words.slice(1)) {
        const t = wordLiteral(w);
        const m = t === undefined ? /^$/.exec('') : /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(t);
        if (t === undefined) c.taintAll = true;
        else if (m && m[1]) bump(m[1], 2);
        else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) bump(t, 2);
      }
    }
    if (head && READ_BUILTINS.has(head)) {
      for (const w of cmd.words.slice(1)) {
        const t = wordLiteral(w);
        if (t === undefined) c.taintAll = true;
        else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) bump(t, 2);
      }
    }
  }
  return c;
}

/** Static value of variable `name`, or undefined when it can differ at run time. */
function lookup(name: string, c: Census, cmd: RawCmd, resolving: Set<string>): string | undefined {
  if (c.taintAll || cmd.inLoop || cmd.inFunc) return undefined;
  if (c.counts.get(name) !== 1 || resolving.has(name)) return undefined;
  const def = c.defs.get(name);
  if (!def) return undefined;
  resolving.add(name);
  let out = '';
  for (const p of def.parts) {
    if (p.t === 'lit') out += p.s;
    else if (p.t === 'var') {
      const v = lookup(p.name, c, cmd, resolving);
      if (v === undefined) { resolving.delete(name); return undefined; }
      out += v;
    } else { resolving.delete(name); return undefined; }
  }
  resolving.delete(name);
  return out;
}

/** Expand one raw word into the words a shell would hand to the command (splitting only unquoted expansions). */
function expand(word: RawWord, c: Census, cmd: RawCmd): Word[] {
  const fields: Word[] = [];
  let cur = { text: '', dyn: false, started: false };
  const push = () => { if (cur.started) fields.push({ value: cur.text, dynamic: cur.dyn }); cur = { text: '', dyn: false, started: false }; };
  for (const p of word.parts) {
    if (p.t === 'lit') { cur.text += p.s; if (p.s || p.q) cur.started = true; continue; }
    if (p.t === 'dyn') { cur.text += PLACEHOLDER; cur.dyn = true; cur.started = true; continue; }
    const v = lookup(p.name, c, cmd, new Set());
    if (v === undefined || (!p.q && c.ifs)) { cur.text += PLACEHOLDER; cur.dyn = true; cur.started = true; continue; }
    if (p.q) { cur.text += v; cur.started = true; continue; }
    const pieces = v.split(/[ \t\n]+/);
    pieces.forEach((piece, idx) => {
      if (idx > 0) push();
      if (piece) { cur.text += piece; cur.started = true; if (/[*?[]/.test(piece)) cur.dyn = true; }
    });
  }
  push();
  return fields;
}

const expandAll = (words: RawWord[], c: Census, cmd: RawCmd): Word[] => words.flatMap((w) => expand(w, c, cmd));

// ---------- analysis ----------

interface Shared { env: PolicyEnv; findings: Finding[]; seen: Set<string> }

interface Io { heredocs: string[]; hereStrings: string[]; piped: boolean; otherStdin: boolean; stdinFile?: Word }

interface Scope {
  sh: Shared;
  depth: number;
  cwds: string[];
  cwdUnknown: boolean;
  written: Set<string>;
  inexact: boolean;
  assigns: string[];
  noAlias: boolean;
}

function emit(sh: Shared, f: Finding): void {
  const id = f.kind === 'gated' ? `g|${f.key}` : `${f.kind}|${f.label}`;
  if (sh.seen.has(id)) return;
  sh.seen.add(id);
  sh.findings.push(f);
}

const unresolved = (sh: Shared, label: string) => emit(sh, { kind: 'unresolved', label });

export function progName(value: string): string {
  return path.basename(value).toLowerCase();
}

/** `wrangler@3`, `@tinycloud/cli@1.2`, `./bin/changeset.js` → the program it names. */
function embeddedName(value: string): string | undefined {
  let v = value;
  const at = v.startsWith('@') ? v.indexOf('@', 1) : v.indexOf('@');
  if (at > 0) v = v.slice(0, at);
  if (PKG_NAMES[v.toLowerCase()]) return PKG_NAMES[v.toLowerCase()];
  const base = path.basename(v).replace(/\.(c|m)?(js|ts)$/i, '').toLowerCase();
  return EMBEDDED.has(base) ? base : undefined;
}

type Normaliser = () => Norm;

const nctx = (sc: Scope): NormCtx => ({ env: sc.sh.env, cwds: sc.cwds, cwdUnknown: sc.cwdUnknown, assigns: sc.assigns });

const branchName = (ref: string): string => (ref.includes('*') ? '*' : ref.replace(/^\+/, '').replace(/^(refs\/)?(heads\/)?/, ''));

/** Record a gated command, keyed by what it does (verb + canonical target). Anything that cannot be named is refused. */
function gate(sc: Scope, label: string, top: Word[], normalise: Normaliser): void {
  if (top.some((w) => w.dynamic)) return unresolved(sc.sh, `${label}: write the command out literally (no variables, substitutions, globs or braces)`);
  if (sc.inexact) return unresolved(sc.sh, `${label} inside a loop, function or repeating runner (xargs, find, watch, trap): run it once, directly`);
  const norm = normalise();
  if (typeof norm === 'string') return unresolved(sc.sh, `${label}: ${norm}`);
  emit(sc.sh, { kind: 'gated', label, verb: norm.verb, target: norm.target, key: `${norm.verb}|${norm.target}`, display: `${norm.verb} ${norm.target}` });
}

const never = (sc: Scope, label: string) => emit(sc.sh, { kind: 'never', label });

const statics = (args: Word[]) => args.filter((a) => !a.dynamic).map((a) => a.value);

// ---------- per-program rules ----------

function classifyGh(args: Word[], top: Word[], sc: Scope, io: Io): void {
  const pos: string[] = [];
  const valueFlags = new Set(['-R', '--repo', '--hostname']);
  let subIdx = -1;
  for (let i = 0; i < args.length && pos.length < 2; i++) {
    const a = args[i];
    if (!a.dynamic && a.value.startsWith('-')) { if (valueFlags.has(a.value)) i++; continue; }
    if (a.dynamic) return unresolved(sc.sh, 'gh subcommand built at run time');
    pos.push(a.value.toLowerCase());
    subIdx = i;
  }
  const [group, sub] = pos;
  const rest = args.slice(subIdx + 1);
  if (group === 'pr' && sub === 'merge') return gate(sc, 'gh pr merge', top, () => normGhPrMerge(rest, nctx(sc), args));
  if (group === 'workflow' && sub === 'run') return gate(sc, 'gh workflow run', top, () => normGhWorkflowRun(rest, nctx(sc), args));
  if (group === 'release') {
    if (releaseIsReadOnly(sub)) return;
    return gate(sc, 'gh release', top, () => normGhRelease(rest, nctx(sc), args));
  }
  if ((group === 'repo' && sub === 'sync') || (group === 'run' && ['rerun', 'cancel', 'delete'].includes(sub)) || group === 'secret' || group === 'variable') return unresolved(sc.sh, 'GitHub write command: your owner runs it');
  if (['auth', 'config', 'extension'].includes(group)) return never(sc, 'GitHub credential/configuration tools are not available');
  if (group === 'alias') return unresolved(sc.sh, 'gh alias (can hide a gated command)');
  if (group === 'api') classifyApi(args, top, sc, io, 'gh');
}

/** Flags of `gh api` / curl that take a separate value (so the value is not a URL). */
const API_VALUE_FLAGS = new Set([
  '-X', '--method', '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-f', '-F', '--field', '--raw-field',
  '--input', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '-o', '--output', '-u', '--user', '-A', '--user-agent',
  '-e', '--referer', '-w', '-b', '--cookie', '-x', '--proxy', '--url-query', '-T', '--upload-file', '--request', '-O', '-K', '--config',
]);

/** Payload sources of an API call: `key=@file`, `@file`, `--input file`, `-K file`; stdin counts as unverifiable unless a here-doc supplies it. */
function apiText(args: Word[], sc: Scope, io: Io): { text: string; unverifiable: boolean; dynamic: boolean } {
  let text = '';
  let unverifiable = false;
  let dynamic = false;
  const readRef = (ref: string) => {
    if (ref === '-') {
      if (io.heredocs.length || io.hereStrings.length) text += `\n${io.heredocs.join('\n')}\n${io.hereStrings.join('\n')}`;
      else if (io.piped || !io.stdinFile) unverifiable = true;
      return;
    }
    for (const dir of sc.cwds) {
      const r = sc.sh.env.readFile(path.resolve(dir, ref));
      if (r.state === 'text') { text += `\n${r.text}`; return; }
      if (r.state === 'unreadable') { unverifiable = true; return; }
    }
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.dynamic) { dynamic = true; text += `\n${a.value}`; continue; }
    text += `\n${a.value}`;
    const m = /(?:^|=)@(.+)$/.exec(a.value);
    if (m) readRef(m[1]);
    if ((a.value === '--input' || a.value === '-K' || a.value === '--config') && args[i + 1] && !args[i + 1].dynamic) readRef(args[i + 1].value);
  }
  return { text, unverifiable, dynamic };
}

function classifyApi(args: Word[], top: Word[], sc: Scope, io: Io, tool: string): void {
  const info = apiText(args, sc, io);
  if (mergeApi(info.text)) return gate(sc, 'GitHub API merge or ref write', top, () => normApi(info.text));
  const github = tool === 'gh' || /github/i.test(info.text);
  if (!github) return;
  let method: string | undefined;
  let payload = false;
  for (let i = 0; i < args.length; i++) {
    const value = args[i].value;
    if (['-X', '--method', '--request'].includes(value)) method = args[++i]?.value.toUpperCase();
    else if (/^(--method=|--request=|-X.)/.test(value)) method = value.replace(/^(--method=|--request=|-X)/, '').toUpperCase();
    else if (/^(-f|-F|--field|--raw-field|--input|-d|--data(?:-[a-z]+)?|--form(?:-string)?|--json|-T|--upload-file)(=|$)/.test(value) || /^-[fFdT].+/.test(value)) payload = true;
  }
  const verb = method ?? (payload ? 'POST' : 'GET');
  // Only literal comment writes are allowed here. Other GitHub writes cannot be brokered in v0.
  const comment = args.some(a => !a.dynamic && /^(https:\/\/api\.github\.com\/)?\/?repos\/[^/\s]+\/[^/\s]+\/(issues|pulls)\/[1-9][0-9]*\/comments$/.test(a.value));
  if (!['GET', 'HEAD', 'OPTIONS'].includes(verb) && !(verb === 'POST' && comment)) return unresolved(sc.sh, 'GitHub API write outside the comment allowlist: your owner runs it');
  if (/graphql/i.test(info.text)) return unresolved(sc.sh, 'GitHub GraphQL calls are not resolved by the guard');
  if (info.unverifiable) return unresolved(sc.sh, 'GitHub API call whose payload cannot be read here');
  if (info.dynamic && /graphql/i.test(info.text)) return unresolved(sc.sh, 'GitHub GraphQL call built at run time');
  // An endpoint that is entirely decided at run time could be a merge.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.dynamic && API_VALUE_FLAGS.has(a.value)) { i++; continue; }
    if (a.dynamic && a.value.replace(/\u0001/g, '').trim() === '') return unresolved(sc.sh, 'GitHub API endpoint built at run time');
  }
}

function classifyCurl(args: Word[], top: Word[], sc: Scope, io: Io): void {
  for (const arg of args) {
    if (arg.dynamic) continue;
    try {
      const host = new URL(arg.value).hostname;
      if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(host)) return never(sc, 'loopback requests can reach local services outside the guard');
    } catch { /* not a URL */ }
  }
  classifyApi(args, top, sc, io, 'curl');
}

function executableGitKey(key: string): boolean {
  return /^(alias\.|core\.(fsmonitor|pager|editor|sshcommand|hookspath)$|pager\.|sequence\.editor$|diff\..*\.(textconv|command)$|filter\..*\.(clean|smudge|process)$|merge\..*\.driver$|credential\..*helper$|credential\.helper$|gpg\.program$|remote\..*\.(receivepack|uploadpack|pushurl)$|url\..*\.(insteadof|pushinsteadof)$)/i.test(key);
}

const GIT_DIR_VALUE_FLAGS = new Set(['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']);

function classifyGit(args: Word[], top: Word[], sc: Scope, io: Io, depth = 0): void {
  if (args.some(a => !a.dynamic && (a.value === '-c' || a.value.startsWith('-c') || a.value.startsWith('--config-env')))) return unresolved(sc.sh, 'git runtime config overrides can execute commands');
  const probeArgs: string[] = [];
  const dirs: string[] = [...sc.cwds];
  let dirsUnknown = sc.cwdUnknown;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a.dynamic) return unresolved(sc.sh, 'git option or subcommand built at run time');
    const v = a.value;
    if (v === '-C') {
      const d = args[++i];
      if (!d || d.dynamic) dirsUnknown = true;
      else for (let j = 0; j < dirs.length; j++) dirs[j] = path.resolve(dirs[j], d.value);
      continue;
    }
    if (GIT_DIR_VALUE_FLAGS.has(v)) {
      const val = args[++i];
      if (!val || val.dynamic) return unresolved(sc.sh, 'git directory option built at run time');
      if (v === '--git-dir' || v === '--work-tree') probeArgs.push(v, val.value);
      continue;
    }
    if (v.startsWith('--git-dir=') || v.startsWith('--work-tree=')) { probeArgs.push(v); continue; }
    if (v.startsWith('-')) continue;
    break;
  }
  const subWord = args[i];
  if (!subWord) return;
  const sub = subWord.value.toLowerCase();
  const rest = args.slice(i + 1);
  const cfg = (key: string, dir: string): string[] => {
    const got = sc.sh.env.git(dir, [...probeArgs, 'config', '--get-all', key]);
    return [...(got.ok ? got.out.split('\n').filter(Boolean) : [])];
  };

  if (!GIT_BUILTINS.has(sub) && !sc.noAlias && depth < 3) {
    const lookups = dirsUnknown ? [] : dirs.flatMap((d) => cfg(`alias.${sub}`, d).slice(-1));
    for (const aliased of lookups) {
      if (aliased.startsWith('!')) analyzeScript(aliased.slice(1), sc, sc.inexact);
      else classifyGit([...aliased.split(/\s+/).filter(Boolean).map((value) => ({ value, dynamic: false })), ...rest], top, sc, io, depth + 1);
    }
    return;
  }
  if (sub === 'send-pack') return unresolved(sc.sh, 'git send-pack');
  if (sub === 'config') {
    if (statics(rest).some((s) => executableGitKey(s))) unresolved(sc.sh, 'git command-running configuration is not allowed');
    return;
  }
  // `git config` itself is read-only here. Detect local helpers before invoking commands that could run them.
  for (const dir of dirs) {
    const configured = sc.sh.env.git(dir, [...probeArgs, 'config', '--get-regexp', '.*']);
    if (configured.ok && configured.out.split('\n').some(line => executableGitKey(line.split(/\s+/)[0]) && !/^core\.hookspath\s+\/dev\/null$/i.test(line))) return unresolved(sc.sh, 'existing git configuration can execute commands');
  }
  if (sub !== 'push') return;

  // ---- git push ----
  if (rest.some((a) => a.dynamic)) return unresolved(sc.sh, 'git push with a branch, remote or option built at run time: write it out literally');
  const pos: string[] = [];
  let repoFlag = false;
  let afterDashDash = false;
  let gated = false;
  for (let j = 0; j < rest.length; j++) {
    const v = rest[j].value;
    if (!afterDashDash && v === '--') { afterDashDash = true; continue; }
    if (!afterDashDash && v.startsWith('-') && v !== '-') {
      if (v === '--tags' || v === '--follow-tags') return unresolved(sc.sh, 'tag pushes can publish or deploy; your owner runs them');
      if (v === '--all' || v === '--mirror' || v === '--branches') gated = true;
      if (v === '--repo') repoFlag = true;
      if (v.startsWith('--repo=')) repoFlag = true;
      if (v === '-o' || v === '--push-option' || v === '--repo' || v === '--receive-pack' || v === '--exec') j++;
      continue;
    }
    pos.push(v);
  }
  // `--all`/`--mirror` are handled once the remote is known.
  const remote = repoFlag ? undefined : pos[0];
  const refspecs = repoFlag ? pos : pos.slice(1);
  let implicit = refspecs.length === 0;
  const hit: string[] = [];
  if (gated) return gate(sc, 'git push --all/--mirror (includes the default branch)', top, () => normPush(remote, ['*'], nctx(sc)));
  for (const spec of refspecs) {
    const bare = spec.replace(/^\+/, '');
    const colon = bare.indexOf(':');
    const dst = colon < 0 ? bare : bare.slice(colon + 1) || bare.slice(0, colon);
    if (dst === 'HEAD' || dst === '@') implicit = true;
    else if (protectedRef(dst)) hit.push(branchName(dst));
  }
  if (hit.length) return gate(sc, 'git push to main/master', top, () => normPush(remote, hit, nctx(sc)));
  if (!implicit) return unresolved(sc.sh, 'direct pushes (including tags) are not brokered in v0; your owner runs it');
  if (dirsUnknown || !dirs.length) return unresolved(sc.sh, 'git push without a branch from a directory that cannot be determined');
  for (const dir of dirs) {
    const head = sc.sh.env.git(dir, [...probeArgs, 'symbolic-ref', '-q', '--short', 'HEAD']);
    if (!head.ok || !head.out) return unresolved(sc.sh, 'git push without a branch and no current branch could be read');
    const branch = head.out.trim();
    const rem = remote ?? cfg(`branch.${branch}.remote`, dir).pop();
    if (protectedRef(branch)) return gate(sc, 'git push from main/master', top, () => normPush(rem, [branch], nctx(sc)));
    const pd = (cfg('push.default', dir).pop() ?? 'simple').toLowerCase();
    if (pd === 'matching') return gate(sc, 'git push (push.default=matching pushes main too)', top, () => normPush(rem, ['*'], nctx(sc)));
    if ((pd === 'upstream' || pd === 'tracking') && cfg(`branch.${branch}.merge`, dir).some(protectedRef)) {
      return gate(sc, 'git push to an upstream of main/master', top, () => normPush(rem, cfg(`branch.${branch}.merge`, dir).filter(protectedRef).map(branchName), nctx(sc)));
    }
    const remotes = new Set([remote, cfg(`branch.${branch}.remote`, dir).pop(), 'origin'].filter((r): r is string => Boolean(r)));
    for (const r of remotes) {
      for (const spec of cfg(`remote.${r}.push`, dir)) {
        const bare = spec.replace(/^\+/, '');
        const dst = bare.includes(':') ? bare.slice(bare.indexOf(':') + 1) : bare;
        if (protectedRef(dst)) return gate(sc, 'git push (configured refspec targets main/master)', top, () => normPush(rem, [branchName(dst)], nctx(sc)));
      }
    }
  }
  unresolved(sc.sh, 'direct pushes are not brokered in v0; your owner runs them');
}

function protectedRef(ref: string): boolean {
  const r = ref.replace(/^\+/, '');
  if (r.includes('*')) return true;
  return /^(refs\/)?(heads\/)?(main|master)$/i.test(r);
}

function classifyNpm(prog: string, args: Word[], top: Word[], sc: Scope, io: Io): void {
  const before = sc.sh.findings.length;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.dynamic) continue;
    if (embeddedName(a.value)) {
      classify(args.slice(i), top, sc, io);
      if (sc.sh.findings.length > before) return;
    }
  }
  const lits = statics(args);
  if (lits.includes('publish')) return gate(sc, `${prog} publish`, top, () => normPublish(prog, args.slice(args.findIndex((a) => !a.dynamic && a.value === 'publish') + 1), nctx(sc)));
  if (lits.some(v => ['unpublish', 'dist-tag'].includes(v))) return unresolved(sc.sh, `${prog} registry write: your owner runs it`);
  const positions: string[] = [];
  let dirs = [...sc.cwds];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.dynamic) return unresolved(sc.sh, `${prog} command built at run time`);
    const v = arg.value;
    if (/^(--filter|--workspace|--workspaces|--recursive|-r|-w)(=|$)/.test(v) || /^-w.+/.test(v)) return unresolved(sc.sh, 'workspace-selected scripts cannot be resolved safely');
    if (['--prefix', '--cwd', '-C'].includes(v) || /^(--prefix|--cwd)=/.test(v)) {
      const dir = v.includes('=') ? v.slice(v.indexOf('=') + 1) : args[++i]?.value;
      if (!dir || sc.cwdUnknown) return unresolved(sc.sh, 'package directory cannot be resolved');
      dirs = dirs.map(d => path.resolve(d, dir)); continue;
    }
    if (v.startsWith('-')) continue;
    positions.push(v);
  }
  const [sub, name] = positions;
  if (!sub || (prog === 'bun' && sub === 'test')) return;
  if (['install', 'i', 'ci', 'add', 'rebuild', 'version', 'prepare', 'pack'].includes(sub)) return unresolved(sc.sh, 'package lifecycle scripts can execute commands; your owner runs this');
  const script = ['run', 'run-script'].includes(sub) ? name : ['test', 't', 'start', 'stop', 'restart'].includes(sub) ? (sub === 't' ? 'test' : sub) : ['bun', 'pnpm', 'yarn'].includes(prog) && !['x', 'exec', 'dlx', 'list', 'ls', 'info', 'why', 'outdated', 'remove', 'update', 'pm', 'repl', ...(prog === 'bun' ? ['build'] : [])].includes(sub) ? sub : undefined;
  if (!script) return;
  if (SCRIPT_NAME.test(script)) return gate(sc, `${prog} script ${script}`, top, () => normScript(prog, script, { ...nctx(sc), cwds: dirs }));
  if (sc.cwdUnknown) return unresolved(sc.sh, 'package script directory cannot be determined');
  if (sc.depth >= MAX_DEPTH) return unresolved(sc.sh, 'package scripts nested too deeply');
  for (const dir of dirs) {
    const file = sc.sh.env.readFile(path.join(dir, 'package.json'));
    if (file.state !== 'text') return unresolved(sc.sh, 'package script cannot be read');
    let pkg: { scripts?: Record<string, unknown> };
    try { pkg = JSON.parse(file.text); } catch { return unresolved(sc.sh, 'package.json cannot be parsed'); }
    const scripts = pkg?.scripts;
    if (!scripts || typeof scripts[script] !== 'string') return unresolved(sc.sh, `package script ${script} cannot be resolved`);
    for (const key of [`pre${script}`, script, `post${script}`]) {
      const body = scripts[key];
      if (body === undefined) continue;
      if (typeof body !== 'string') return unresolved(sc.sh, `package script ${key} is not text`);
      analyzeScript(body, { ...sc, cwds: [dir], depth: sc.depth + 1 }, sc.inexact);
    }
  }
}

function classifyTool(prog: 'wrangler' | 'phala' | 'changeset', args: Word[], top: Word[], sc: Scope): void {
  const words = prog === 'wrangler' ? ['deploy', 'publish'] : prog === 'phala' ? ['deploy'] : ['publish'];
  if ((prog === 'wrangler' && statics(args).some(v => ['rollback', 'delete', 'secret'].includes(v))) || (prog === 'phala' && statics(args).includes('cvms'))) return unresolved(sc.sh, `${prog} write command: your owner runs it`);
  if (statics(args).some((s) => words.includes(s.toLowerCase()))) {
    return gate(sc, `${prog} ${words[0]}`, top, () => (prog === 'wrangler' ? normWrangler(args, nctx(sc)) : prog === 'phala' ? normPhala(args) : normChangeset(nctx(sc))));
  }
  const positionals = args.filter((a) => a.dynamic || !a.value.startsWith('-')).slice(0, 2);
  if (positionals.some((a) => a.dynamic)) unresolved(sc.sh, `${prog} subcommand built at run time`);
}

function classifyTc(args: Word[], sc: Scope): void {
  // `tc` reaches an owner profile (any `--profile`, `TC_HOME`, the default one): a woken agent only gets `tc courier …`.
  const first = args[0];
  if (!first || first.dynamic || first.value.toLowerCase() !== 'courier') {
    return never(sc, 'tc/tinycloud is not available to a woken agent (it reaches an owner profile); use `courier …` or `tc courier …`');
  }
  classifyCourier(args.slice(1), sc);
}

/** Subcommands for humans only: pairing, grants, the wake budget, the watcher, the broker's credential, the guard's own settings. */
const COURIER_HUMAN_ONLY = new Set(['pair', 'revoke', 'init', 'pause', 'resume', 'watch', 'broker', 'guard']);

function classifyCourier(args: Word[], sc: Scope): void {
  if (args.some((a) => a.dynamic)) return unresolved(sc.sh, 'courier command with words built at run time');
  // The CLI's own parser decides what the subcommand is: `courier --peer bob pause` is `pause`, and everything after `--` is positional.
  const parsed = parseArgs(args.map((a) => a.value));
  const sub = parsed.positional[0]?.toLowerCase();
  if (!sub) return;
  if (COURIER_HUMAN_ONLY.has(sub)) {
    return never(sc, `courier ${sub} is for humans (pairing, grants, the wake budget, the watcher, the broker credential and the guard settings are never touched by an agent)`);
  }
  if (sub === 'approval' && !parsed.has('peek')) {
    return never(sc, 'courier approval without --peek would use the approval up; check with --peek, and run the approved action with `courier run-approved <requestId>`');
  }
  if (sub === 'run-approved') {
    if (parsed.positional.length !== 2 || !ULID.test(parsed.positional[1]) || parsed.flags.size > 0) {
      return unresolved(sc.sh, 'courier run-approved takes exactly one request id and no flags: `courier run-approved <requestId>`');
    }
  }
}

// ---------- scripts and files ----------

function classifyScriptText(text: string, sc: Scope, label: string): void {
  if (text.includes('\0')) return;
  for (const hit of codeHits(text)) unresolved(sc.sh, `${label} contains ${hit}`);
}

function classifyFile(file: Word, sc: Scope, asShell: boolean, io?: Io): void {
  if (file.dynamic) return unresolved(sc.sh, 'script path built at run time');
  if (/^\/(dev\/(stdin|fd\/\d+)|proc\/self\/fd\/\d+)$/.test(file.value)) {
    // `bash /dev/stdin <<< "…"`, `. /dev/fd/3`: the commands come from stdin or a descriptor.
    if (io && (io.heredocs.length || io.hereStrings.length)) {
      for (const body of [...io.heredocs, ...io.hereStrings]) analyzeScript(body, sc, sc.inexact);
      return;
    }
    return unresolved(sc.sh, 'commands read from stdin or a file descriptor');
  }
  if (sc.cwdUnknown && !path.isAbsolute(file.value)) return unresolved(sc.sh, 'script path relative to a directory that cannot be determined');
  const candidates = path.isAbsolute(file.value) ? [file.value] : sc.cwds.map((d) => path.resolve(d, file.value));
  for (const c of candidates) {
    if (sc.written.has(c)) return unresolved(sc.sh, 'runs a file that this same command writes');
  }
  if (sc.depth + 1 > MAX_DEPTH) return unresolved(sc.sh, 'scripts nested too deeply to inspect');
  for (const c of candidates) {
    const r = sc.sh.env.readFile(c);
    if (r.state === 'absent') continue;
    if (r.state === 'unreadable') return unresolved(sc.sh, 'script file cannot be read (too large or no access)');
    if (r.text.includes('\0')) return;
    const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(r.text);
    const interp = shebang ? (progName(shebang[1]) === 'env' ? progName(shebang[2] ?? '') : progName(shebang[1])) : '';
    if (shebang ? SHELLS.has(interp) : asShell || !SOURCE_EXT.test(c) || /\.(sh|bash|zsh)$/i.test(c)) {
      analyzeScript(r.text, sc, sc.inexact);
    } else {
      classifyScriptText(r.text, sc, `${path.basename(c)}`);
    }
    return;
  }
}

function classifyShell(args: Word[], sc: Scope, io: Io): void {
  let i = 0;
  let c = false;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a.dynamic) return unresolved(sc.sh, 'shell options built at run time');
    const v = a.value;
    if (v === '--') { i++; break; }
    if (!(v.startsWith('-') || v.startsWith('+')) || v === '-' || v === '+') break;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(v)) c = true;
    if (v === '-o' || v === '+o' || v === '-O' || v === '+O' || v === '--rcfile' || v === '--init-file') i++;
  }
  const next = args[i];
  if (c) {
    if (!next) return;
    if (next.dynamic) return unresolved(sc.sh, 'shell -c command built at run time');
    return analyzeScript(next.value, sc, sc.inexact);
  }
  if (next) return classifyFile(next, sc, true, io);
  for (const body of [...io.heredocs, ...io.hereStrings]) analyzeScript(body, sc, sc.inexact);
  if (io.stdinFile) return classifyFile(io.stdinFile, sc, true, io);
  if (io.otherStdin) return unresolved(sc.sh, 'a shell reading commands from a file descriptor');
  if (io.piped && !io.heredocs.length && !io.hereStrings.length) unresolved(sc.sh, 'a shell reading commands from a pipe');
}

function classifyInterpreter(prog: string, args: Word[], sc: Scope, io: Io): void {
  // Only a literal, option-free installed entry is the Courier CLI.
  const entry = args[0];
  if ((prog === 'node' || prog === 'nodejs') && entry && !entry.dynamic && !entry.value.startsWith('-') &&
      sc.sh.env.courierEntries?.includes(realpathBest(path.resolve(sc.cwds[0], entry.value)))) {
    const rest = args.slice(1);
    return rest[0]?.value === 'courier' ? classifyTc(rest, sc) : classifyCourier(rest, sc);
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.dynamic) continue;
    const name = embeddedName(a.value);
    if (name && (a.value.includes('/') || i === 0)) classify(args.slice(i), args.slice(i), sc, io);
  }
  let sawCode = false;
  for (const a of args) {
    if (a.dynamic) continue;
    if (SOURCE_EXT.test(a.value) && !a.value.includes(' ')) {
      sawCode = true;
      for (const d of sc.cwds) {
        const r = sc.sh.env.readFile(path.resolve(d, a.value));
        if (r.state === 'text') { classifyScriptText(r.text, sc, a.value); break; }
        if (r.state === 'unreadable') { unresolved(sc.sh, `${a.value} cannot be read`); break; }
      }
      if ([...sc.written].some((w) => w.endsWith(path.basename(a.value)))) unresolved(sc.sh, 'runs a file that this same command writes');
    } else if (/\s|[(){};]/.test(a.value) || a.value.length > 12) {
      sawCode = true;
      classifyScriptText(a.value, sc, `${prog} code`);
    }
  }
  for (const body of [...io.heredocs, ...io.hereStrings]) { sawCode = true; classifyScriptText(body, sc, `${prog} stdin`); }
  if (!sawCode && io.piped && (args.length === 0 || (args.length === 1 && args[0].value === '-'))) unresolved(sc.sh, `${prog} reading code from a pipe`);
}

function classifyWrapper(prog: string, args: Word[], top: Word[], sc: Scope, io: Io): void {
  const inner: Scope = REPEATERS.has(prog) ? { ...sc, inexact: true } : sc;
  const limit = Math.min(args.length, 100);
  for (let i = 0; i < limit; i++) {
    const w = args[i];
    if (!w.dynamic && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value) && SENSITIVE_VAR.test(w.value.split('=')[0])) {
      return never(sc, `setting ${w.value.split('=')[0]} is not allowed for a woken agent`);
    }
    classify(args.slice(i), top, inner, io);
    const a = args[i];
    if (!a.dynamic && /[\s;&|`$()<>]/.test(a.value) && a.value.trim()) analyzeScript(a.value, inner, inner.inexact);
  }
}

function classifyDynamicHead(argv: Word[], top: Word[], sc: Scope, io: Io): void {
  const rest = argv.slice(1);
  const probe: Scope = { ...sc, noAlias: true };
  classifyGh(rest, top, probe, io);
  classifyGit(rest, top, probe, io);
  classifyNpm('npm', rest, top, probe, io);
  classifyTool('wrangler', rest, top, probe);
  classifyTool('phala', rest, top, probe);
  classifyTool('changeset', rest, top, probe);
  classifyCurl(rest, top, probe, io);
  for (const a of rest) {
    if (!a.dynamic && /[\s;&|`$()<>]/.test(a.value) && a.value.trim()) analyzeScript(a.value, probe, probe.inexact);
  }
  const first = rest.find((a) => !a.dynamic);
  if (first && /^(eval|source|\.)$/.test(first.value)) unresolved(sc.sh, 'command built at run time');
}

/** Classify one simple command. `top` is the whole command as typed (what an approval has to name). */
function classify(argv: Word[], top: Word[], sc: Scope, io: Io): void {
  if (!argv.length) return;
  const head = argv[0];
  if (head.dynamic) return classifyDynamicHead(argv, top, sc, io);
  const prog = embeddedName(head.value) ?? progName(head.value);
  const args = argv.slice(1);

  if (/^secret[-_]?bridge$/.test(prog)) return never(sc, 'Secret Bridge is retired and never allowed');
  if (AGENT_CLIS.has(prog)) return never(sc, `${prog} would start another agent without the Courier guard; do the work yourself`);
  if (NEVER_PROGS.has(prog)) return never(sc, `${prog} is not available to a woken agent (it changes user, outlives the call, or reaches another machine or a local service)`);
  if (head.value.includes('=') && SENSITIVE_VAR.test(head.value.split('=')[0])) return never(sc, `setting ${head.value.split('=')[0]} is not allowed for a woken agent`);
  if (WRAPPERS.has(prog)) return classifyWrapper(prog, args, top, sc, io);
  if (SHELLS.has(prog)) return classifyShell(args, sc, io);
  switch (prog) {
    case 'eval': {
      if (args.some((a) => a.dynamic)) return unresolved(sc.sh, 'eval of text built at run time');
      return analyzeScript(args.map((a) => a.value).join(' '), sc, sc.inexact);
    }
    case 'source':
    case '.': {
      const file = args.find((a) => a.dynamic || !a.value.startsWith('-'));
      if (file) classifyFile(file, sc, true, io);
      return;
    }
    case 'gh': return classifyGh(args, top, sc, io);
    case 'git': return classifyGit(args, top, sc, io);
    case 'tc':
    case 'tinycloud': return classifyTc(args, sc);
    case 'export':
    case 'declare':
    case 'typeset':
    case 'readonly':
    case 'local':
    case 'unset':
    case 'set': {
      for (const a of args) {
        const name = a.value.replace(/^-+/, '').split('=')[0];
        if (a.dynamic || (name && SENSITIVE_VAR.test(name))) return never(sc, `changing ${name || 'the environment'} is not allowed for a woken agent`);
      }
      return;
    }
    case 'semantic-release': return unresolved(sc.sh, 'semantic-release publishes from agent-controlled code; your owner runs it');
    case 'make': case 'gmake': case 'turbo': case 'nx': case 'just': return unresolved(sc.sh, 'task runner recipes cannot be resolved safely; run the literal commands instead');
    case 'courier': return classifyCourier(args, sc);
    case 'wrangler': return classifyTool('wrangler', args, top, sc);
    case 'phala': return classifyTool('phala', args, top, sc);
    case 'changeset': return classifyTool('changeset', args, top, sc);
    case 'lerna': if (statics(args).includes('publish')) gate(sc, 'lerna publish', top, () => 'lerna publish is not supported; use `changeset publish` or `npm publish` from a package directory'); return;
    default:
  }
  if (NPM_FAMILY.has(prog)) {
    classifyNpm(prog, args, top, sc, io);
    if (prog !== 'bun') return;
  }
  if (CURLS.has(prog)) return classifyCurl(args, top, sc, io);
  if (INTERPRETERS.has(prog)) return classifyInterpreter(prog, args, sc, io);
  if (head.value.includes('/')) classifyFile(head, sc, false, io);
}

const WRITERS = new Set(['tee', 'cp', 'mv', 'install', 'sponge', 'dd']);

/** Resolve a command string into findings. */
export function analyze(command: string, env: PolicyEnv): Finding[] {
  const sh: Shared = { env, findings: [], seen: new Set() };
  const sc: Scope = { sh, depth: 0, cwds: [path.resolve(env.cwd)], cwdUnknown: false, written: new Set(), inexact: false, assigns: [], noAlias: false };
  analyzeScript(command, sc, false);
  return sh.findings;
}

function analyzeScript(text: string, parent: Scope, inexact: boolean): void {
  const sh = parent.sh;
  if (parent.depth + 1 > MAX_DEPTH) return unresolved(sh, 'scripts nested too deeply to inspect');
  // Credential and guard-configuration paths are refused wherever they appear, read or write (R2, B1, B2).
  for (const candidate of unquoted(text).match(/https?:\/\/[^\s;]+/gi) ?? []) {
    try {
      if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(new URL(candidate).hostname)) return never(parent, 'loopback requests can reach local services outside the guard');
    } catch { /* not a literal URL */ }
  }
  const credential = credentialTextRefusal(text);
  if (credential) return never(parent, `refused: ${credential}`);
  const parsed = parseShell(text);
  if (parsed.errors.length) unresolved(sh, `could not read the command (${parsed.errors[0]})`);
  for (const command of parsed.cmds) {
    for (const assignment of command.assigns) if (SENSITIVE_VAR.test(assignment.name)) return never(parent, `setting ${assignment.name} is not allowed for a woken agent`);
    const words = command.words.map(wordLiteral);
    if (words[0] && ['env', 'export', 'declare', 'typeset', 'readonly', 'local', 'set', 'unset'].includes(progName(words[0]))) {
      for (const word of words.slice(1)) if (word && SENSITIVE_VAR.test(word.replace(/^-+/, '').split('=')[0])) return never(parent, 'changing the credential or tool environment is not allowed for a woken agent');
    }
  }
  const refusal = expansionRefusal(text, parsed);
  if (refusal) return unresolved(sh, refusal);
  // A literal installed CLI entry must be callable; arbitrary reads/writes of its install still refuse.
  const single = parsed.cmds.length === 1 ? parsed.cmds[0] : undefined;
  const words = single?.words.map(wordLiteral);
  if (single && words && words.every((w) => w !== undefined) && ['node', 'nodejs'].includes(progName(words[0] ?? '')) &&
      words[1] && sh.env.courierEntries?.includes(realpathBest(path.resolve(parent.cwds[0], words[1])))) {
    if (single.assigns.length || single.redirs.length || single.inLoop || single.inFunc || single.piped) return unresolved(sh, 'Courier entry must run as one literal command without redirects or wrappers');
    const protectedArgs = protectedTextRefusal(words.slice(2).join(' '), sh.env.literals);
    if (protectedArgs) return never(parent, `refused: ${protectedArgs}`);
    return classifyInterpreter(progName(words[0]!), words.slice(1).map((value) => ({ value: value!, dynamic: false })), parent, { heredocs: [], hereStrings: [], piped: false, otherStdin: false });
  }
  const protectedText = protectedTextRefusal(text, sh.env.literals);
  if (protectedText) return never(parent, `refused: ${protectedText}`);
  const sc: Scope = { ...parent, depth: parent.depth + 1, cwds: [...parent.cwds], written: new Set(parent.written), inexact: inexact || parent.inexact, assigns: [] };
  const c = census(parsed.cmds);
  const resolved = parsed.cmds.map((cmd) => ({
    cmd,
    words: expandAll(cmd.words, c, cmd),
    redirs: cmd.redirs.map((r) => ({ op: r.op, target: expand(r.target, c, cmd) })),
    assigns: cmd.assigns.map((a) => ({ name: a.name, words: expand(a.value, c, cmd) })),
    here: cmd.hereStrings.map((h) => expand(h, c, cmd).map((w) => w.value).join(' ')),
  }));

  // Pass A: directories the command can move to, and files it writes.
  for (const r of resolved) {
    const head = r.words[0]?.dynamic ? undefined : progName(r.words[0]?.value ?? '');
    if (head === 'cd' || head === 'pushd' || head === 'popd') {
      const target = r.words.slice(1).find((w) => w.dynamic || !w.value.startsWith('-'));
      if (head === 'popd' || !target || target.dynamic || target.value === '-' || target.value.startsWith('~')) sc.cwdUnknown = true;
      else for (const d of [...sc.cwds]) sc.cwds.push(path.resolve(d, target.value));
    }
  }
  const note = (w: Word | undefined) => {
    if (!w) return;
    if (w.dynamic) { sc.cwdUnknown = sc.cwdUnknown || false; return; }
    for (const d of sc.cwds) sc.written.add(path.resolve(d, w.value));
  };
  for (const r of resolved) {
    for (const red of r.redirs) if (['>', '>>', '>|', '&>', '&>>', '<>'].includes(red.op)) note(red.target[0]);
    const head = r.words[0] && !r.words[0].dynamic ? progName(r.words[0].value) : '';
    if (WRITERS.has(head)) for (const w of r.words.slice(1)) { if (!w.dynamic && w.value.startsWith('of=')) note({ value: w.value.slice(3), dynamic: false }); else if (!w.value.startsWith('-')) note(w); }
    if (head === 'curl') r.words.forEach((w, i) => { if ((w.value === '-o' || w.value === '--output') && r.words[i + 1]) note(r.words[i + 1]); });
    if (head === 'wget') r.words.forEach((w, i) => { if ((w.value === '-O' || w.value === '--output-document') && r.words[i + 1]) note(r.words[i + 1]); });
  }

  // Pass B: classify every simple command.
  for (const r of resolved) {
    const cmdScope: Scope = {
      ...sc,
      inexact: sc.inexact || r.cmd.inLoop || r.cmd.inFunc,
      assigns: r.assigns.map((a) => `${a.name}=${a.words.map((w) => w.value).join(' ')}`),
    };
    const stdin = r.redirs.find((x) => x.op === '<');
    const io: Io = {
      heredocs: r.cmd.heredocs,
      hereStrings: r.here,
      piped: r.cmd.piped,
      otherStdin: r.redirs.some((x) => x.op === '<&' || x.op === '<>'),
      ...(stdin?.target[0] ? { stdinFile: stdin.target[0] } : {}),
    };
    for (const a of r.assigns) if (SENSITIVE_VAR.test(a.name)) { never(cmdScope, `setting ${a.name} is not allowed for a woken agent`); }
    // Variables set for one command (`GH_REPO=x gh pr merge`) are part of what an approval has to name.
    if (r.words.length) classify(r.words, r.words, cmdScope, io);
    for (const red of r.redirs) if (red.op === '<' && !r.words.length) continue;
  }
}
