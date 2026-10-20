import type { ParseResult } from './shell.js';

/**
 * The guard's first rule, and the one that does not depend on reading shell correctly: a command that contains
 * run-time expansion or indirection syntax AND names a gated tool or verb anywhere is refused. The shell can build a
 * command out of pieces (`{gh,pr,merge} 5`, `$(echo gh) pr merge`, `eval`, an alias, `xargs`), and a static reader can
 * never be sure it saw the final words. When the pieces and a gated name are in the same command, the guard does not
 * try: it refuses, accepting false refusals. Commands without such syntax are read word by word, as before.
 *
 * This stops a prompted or confused agent, including one carrying a peer's prompt injection. It is not a sandbox against
 * a process that is deliberately hostile (see the README).
 */

/** Syntax whose result is decided by the shell at run time, found in the raw text. */
const SYNTAX: [string, RegExp][] = [
  ['parameter, command or arithmetic expansion ($)', /\$/],
  ['backticks', /`/],
  ['brace expansion', /\{[^{}\n]*(,|\.\.)[^{}\n]*\}/],
  ['eval, source, alias or a function definition', /(^|[\s;&|(])(eval|source|alias|unalias|coproc|function)(\s|$)|(^|[;&|(\n]\s*)\.\s+\S|(^|[\s;&|(])[A-Za-z_][\w-]*\s*\(\)\s*(\{|$)/],
  ['a command prefix (env, command, builtin, exec, sudo, nohup, timeout, …)', /(^|[\s;&|(])(env|command|builtin|exec|sudo|doas|nohup|timeout|setsid|stdbuf|watch|nice|ionice|time|xargs|parallel|trap|script|su|runuser|flock|strace|ltrace|unbuffer|chronic|taskset|chrt|unshare|nsenter|chroot|busybox|toybox|systemd-run|xvfb-run|ssh|at|batch|entr|caffeinate)(\s|$)/i],
  ['find -exec', /\s-(exec|execdir|ok|okdir)(\s|$)/],
  ['env -S', /(^|[\s;&|(])env\s+(-\w*S|--split-string)/],
  ['a here-document, here-string or process substitution', /<<|<\(|>\(/],
  ['text piped into a shell', /\|\s*(sh|bash|dash|zsh|ksh|fish|source|\.|xargs|eval)(\s|$)/],
  ['decoded text', /\b(base64|b64decode|xxd|openssl\s+enc)\b[^|;&]*(-d|--decode|-r)\b/],
];

const NAMES = [
  'gh', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'npx', 'changeset', 'wrangler', 'phala', 'tc', 'tinycloud', 'lerna',
  'secret-bridge', 'secret_bridge', 'secretbridge', 'paseo', 'claude', 'codex', 'omp', 'opencode', 'gemini', 'cursor-agent', 'aider', 'goose', 'amp',
];
const VERBS = ['merge', 'publish', 'deploy', 'push', 'release', 'secrets', 'secret', 'pair', 'revoke'];

/** `name` as a word of its own: not part of a longer identifier and not a `$NAME` variable. */
const token = (names: string[]) => new RegExp(`(?<![A-Za-z0-9_$.-])(${names.map((n) => n.replace(/[-_]/g, '[-_]?')).join('|')})(?![A-Za-z0-9_-])`, 'i');
const NAME_RE = token(NAMES);
const VERB_RE = token(VERBS);
const FETCH_RE = token(['curl', 'wget', 'http', 'https', 'xh', 'xhs', 'httpie', 'aria2c']);
const GRAPHQL_RE = /mergePullRequest|enablePullRequestAutoMerge|updateRef|createCommitOnBranch|mergeBranch/i;
const COURIER_HUMAN_RE = token(['courier']);
const COURIER_SUB_RE = token(['pair', 'revoke', 'init', 'pause', 'resume', 'watch']);

/** Quotes and backslashes removed, so `g""h`, `'g'h` and `\gh` read as the name they spell. */
const unquoted = (text: string) => text.replace(/\$?['"]/g, '').replace(/\\\n/g, '').replace(/\\/g, '');

/** Which gated tool or verb appears in `text`, if any. */
export function gatedName(text: string): string | undefined {
  for (const t of [text, unquoted(text)]) {
    const name = NAME_RE.exec(t)?.[1] ?? VERB_RE.exec(t)?.[1];
    if (name) return name.toLowerCase();
    if (GRAPHQL_RE.test(t)) return 'a GitHub merge mutation';
    if (FETCH_RE.test(t) && /github/i.test(t)) return 'a GitHub API call';
    if (COURIER_HUMAN_RE.test(t) && COURIER_SUB_RE.test(t)) return 'courier pair|revoke|init|pause|resume|watch';
  }
  return undefined;
}

/** The expansion or indirection syntax in `text` (and, from the parse, in a command word), if any. */
export function expansionSyntax(text: string, parsed?: ParseResult): string | undefined {
  for (const t of [text, unquoted(text)]) for (const [label, re] of SYNTAX) if (re.test(t)) return label;
  // A glob, `~` or substitution in the command position does not show up as `$`: the parser knows it.
  for (const cmd of parsed?.cmds ?? []) {
    if (cmd.words[0]?.parts.some((part) => part.t === 'dyn')) return 'a glob, tilde or substitution in the command word';
  }
  return undefined;
}

/**
 * The refusal for `text`, or undefined if the guard may read it word by word. The message names the rule, so an agent
 * knows what to change: write the command out with plain words.
 */
export function expansionRefusal(text: string, parsed?: ParseResult): string | undefined {
  const syntax = expansionSyntax(text, parsed);
  if (!syntax) return undefined;
  const name = gatedName(text);
  if (!name) return undefined;
  return `expansion syntax with a gated tool name (${syntax}; "${name}"). The guard refuses a command that can be built at run time and mentions a gated tool; write it out with plain words`;
}
