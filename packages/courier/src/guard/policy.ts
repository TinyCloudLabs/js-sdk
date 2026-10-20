import path from 'node:path';
import { parseShell, wordLiteral, type RawCmd, type RawWord } from './shell.js';
import { expansionRefusal } from './expansion.js';
import type { Verb } from './target.js';
import {
  normApi, normChangeset, normGhPrMerge, normGhRelease, normGhWorkflowRun, normPhala, normPublish, normPush, normScript, normSecrets, normWrangler,
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
}

const MAX_DEPTH = 6;
const PLACEHOLDER = '\u0001';

// ---------- tables ----------

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'csh', 'tcsh', 'fish']);
/** Programs that start another coding agent. A woken agent may not launch one: it would run outside the guard. */
const AGENT_CLIS = new Set(['paseo', 'claude', 'codex', 'omp', 'opencode', 'gemini', 'cursor-agent', 'amp', 'aider', 'goose']);
/** Programs that run another program given in their arguments. */
const WRAPPERS = new Set([
  'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'sudo', 'doas', 'setsid', 'stdbuf', 'timeout',
  'unbuffer', 'chronic', 'flock', 'su', 'runuser', 'script', 'strace', 'ltrace', 'taskset', 'chrt', 'unshare', 'nsenter',
  'chroot', 'watch', 'parallel', 'xargs', 'find', 'trap', 'at', 'batch', 'caffeinate', 'systemd-run', 'xvfb-run',
  'dbus-run-session', 'xdotool', 'ssh', 'nsjail', 'firejail', 'busybox', 'toybox', 'entr', 'cronic', 'cpulimit',
]);
/** Wrappers that run the inner command more than once (or an unknown number of times): approvals cannot cover those. */
const REPEATERS = new Set(['xargs', 'parallel', 'find', 'watch', 'trap', 'at', 'batch', 'entr']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'perl', 'ruby', 'php', 'lua', 'luajit', 'tsx', 'ts-node', 'osascript', 'bun']);
const SOURCE_EXT = /\.(py|js|mjs|cjs|ts|mts|rb|pl|php|lua|sh|bash|zsh)$/i;
const NPM_FAMILY = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'corepack']);
const CURLS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'xhs', 'aria2c']);
const SCRIPT_NAME = /^(deploy|publish|release)$/i;
const PKG_NAMES: Record<string, string> = {
  '@tinycloud/cli': 'tinycloud', '@tinycloud/courier': 'courier', '@changesets/cli': 'changeset', '@phala/cli': 'phala',
};
const EMBEDDED = new Set(['gh', 'git', 'wrangler', 'phala', 'changeset', 'tc', 'tinycloud', 'courier', 'secret-bridge', 'curl', 'wget']);
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
const firstPositional = (args: Word[]) => args.find((a) => a.dynamic || !a.value.startsWith('-'));

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
  classifyApi(args, top, sc, io, 'curl');
}

const GIT_DIR_VALUE_FLAGS = new Set(['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']);

function classifyGit(args: Word[], top: Word[], sc: Scope, io: Io, depth = 0): void {
  const probeArgs: string[] = [];
  const dirs: string[] = [...sc.cwds];
  let dirsUnknown = sc.cwdUnknown;
  const overrides: [string, string][] = [];
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
    if (v === '-c') {
      const kv = args[++i];
      if (!kv || kv.dynamic) return unresolved(sc.sh, 'git -c value built at run time');
      const eq = kv.value.indexOf('=');
      overrides.push([(eq < 0 ? kv.value : kv.value.slice(0, eq)).toLowerCase(), eq < 0 ? 'true' : kv.value.slice(eq + 1)]);
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
    const ov = overrides.filter(([k]) => k === key.toLowerCase()).map(([, v]) => v);
    const got = sc.sh.env.git(dir, [...probeArgs, 'config', '--get-all', key]);
    return [...ov, ...(got.ok ? got.out.split('\n').filter(Boolean) : [])];
  };

  if (!GIT_BUILTINS.has(sub) && !sc.noAlias && depth < 3) {
    const cli = overrides.find(([k]) => k === `alias.${sub}`)?.[1];
    const lookups = cli !== undefined ? [cli] : dirsUnknown ? [] : dirs.flatMap((d) => cfg(`alias.${sub}`, d).slice(-1));
    for (const aliased of lookups) {
      if (aliased.startsWith('!')) analyzeScript(aliased.slice(1), sc, sc.inexact);
      else classifyGit([...aliased.split(/\s+/).filter(Boolean).map((value) => ({ value, dynamic: false })), ...rest], top, sc, io, depth + 1);
    }
    return;
  }
  if (sub === 'send-pack') return unresolved(sc.sh, 'git send-pack');
  if (sub === 'config') {
    if (statics(rest).some((s) => /^alias\./i.test(s))) unresolved(sc.sh, 'git alias definitions are not allowed (they can hide a push)');
    return;
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
  if (!implicit) return;
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
  const first = firstPositional(args);
  if (first?.dynamic) return unresolved(sc.sh, `${prog} subcommand built at run time`);
  const positionals = args.filter((a) => a.dynamic || !a.value.startsWith('-'));
  const [p0, p1] = positionals;
  if (!p0) return;
  const runs = prog === 'npm' || prog === 'npx' ? ['run', 'run-script'] : ['run', 'run-script', 'x'];
  if (prog !== 'npm' && prog !== 'npx' && SCRIPT_NAME.test(p0.value)) return gate(sc, `${prog} ${p0.value} (package script)`, top, () => normScript(prog, p0.value, nctx(sc)));
  if (runs.includes(p0.value) && p1 && !p1.dynamic && SCRIPT_NAME.test(p1.value)) return gate(sc, `${prog} ${p0.value} ${p1.value} (package script)`, top, () => normScript(prog, p1.value, nctx(sc)));
  if (runs.includes(p0.value) && p1?.dynamic) return unresolved(sc.sh, `${prog} script name built at run time`);
}

function classifyTool(prog: 'wrangler' | 'phala' | 'changeset', args: Word[], top: Word[], sc: Scope): void {
  const words = prog === 'wrangler' ? ['deploy', 'publish'] : prog === 'phala' ? ['deploy'] : ['publish'];
  if (statics(args).some((s) => words.includes(s.toLowerCase()))) {
    return gate(sc, `${prog} ${words[0]}`, top, () => (prog === 'wrangler' ? normWrangler(args, nctx(sc)) : prog === 'phala' ? normPhala(args) : normChangeset(nctx(sc))));
  }
  const positionals = args.filter((a) => a.dynamic || !a.value.startsWith('-')).slice(0, 2);
  if (positionals.some((a) => a.dynamic)) unresolved(sc.sh, `${prog} subcommand built at run time`);
}

function classifyTc(args: Word[], top: Word[], sc: Scope): void {
  const first = firstPositional(args);
  if (first?.dynamic) return unresolved(sc.sh, 'tc subcommand built at run time');
  const lits = statics(args).map((s) => s.toLowerCase());
  if (lits.includes('secrets') || lits.includes('secret')) return gate(sc, 'tc secrets', top, () => normSecrets(args.slice(args.findIndex((a) => !a.dynamic && /^secrets?$/i.test(a.value)) + 1)));
  const at = lits.indexOf('courier');
  if (at >= 0) classifyCourier(args.slice(args.findIndex((a) => !a.dynamic && a.value.toLowerCase() === 'courier') + 1), sc);
}

function classifyCourier(args: Word[], sc: Scope): void {
  const first = firstPositional(args);
  if (!first) return;
  if (first.dynamic) return unresolved(sc.sh, 'courier subcommand built at run time');
  const sub = first.value.toLowerCase();
  if (['pair', 'revoke', 'init'].includes(sub)) never(sc, `courier ${first.value} is for humans (pairing, revoking and initialising are never done by an agent)`);
  // The wake budget is the reply loop's breaker: an agent must not lift its own pause, nor start another watcher.
  if (['pause', 'resume'].includes(sub)) never(sc, `courier ${first.value} is for humans (a woken agent must not pause or un-pause its own reply loop)`);
  if (sub === 'watch') never(sc, 'courier watch is for humans (a woken agent must not start a watcher, which could wake agents without the guard)');
  // The guard uses an approval up when it lets the command through; an agent that consumes it first only burns it.
  if (sub === 'approval' && !args.some((a) => !a.dynamic && /^--peek(=true)?$/.test(a.value))) never(sc, 'courier approval without --peek would use the approval up before the guard can; check with --peek and run the approved command');
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
  classifyTc(rest, top, probe);
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
    case 'tinycloud': return classifyTc(args, top, sc);
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
  const parsed = parseShell(text);
  if (parsed.errors.length) unresolved(sh, `could not read the command (${parsed.errors[0]})`);
  // First rule (see expansion.ts): run-time expansion or indirection syntax next to a gated name is refused outright.
  const refusal = expansionRefusal(text, parsed);
  if (refusal) return unresolved(sh, refusal);
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
    // Variables set for one command (`GH_REPO=x gh pr merge`) are part of what an approval has to name.
    if (r.words.length) classify(r.words, r.words, cmdScope, io);
    for (const red of r.redirs) if (red.op === '<' && !r.words.length) continue;
  }
}
