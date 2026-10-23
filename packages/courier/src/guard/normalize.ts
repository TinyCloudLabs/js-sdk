import path from 'node:path';
import { canonicalTarget, type Verb } from './target.js';
import type { PolicyEnv, Word } from './policy.js';

/** A gated command reduced to what an approval names, or the reason it cannot be (the guard then refuses it). */
export type Norm = { verb: Verb; target: string } | string;

export interface NormCtx {
  env: PolicyEnv;
  cwds: string[];
  cwdUnknown: boolean;
  /** `NAME=value` prefix assignments of the command. */
  assigns: string[];
}

const fail = (why: string): string => why;
const lits = (args: Word[]) => args.map((a) => a.value);

function ok(verb: Verb, target: string): Norm {
  try { return { verb, target: canonicalTarget(verb, target) }; } catch { return fail(`cannot name the target (${target.slice(0, 80)})`); }
}

/** Value of `--flag v`, `--flag=v` or `-f v` (first occurrence), or undefined. */
function flagValue(args: Word[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    for (const n of names) {
      if (v === n) return args[i + 1]?.value;
      if (n.startsWith('--') && v.startsWith(`${n}=`)) return v.slice(n.length + 1);
    }
  }
  return undefined;
}

const GITHUB_REMOTE = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** `owner/repo` of a git remote (name or URL), identical across every directory the command may run in. */
export function repoOfRemote(ctx: NormCtx, remote: string | undefined): string | undefined {
  const direct = remote ? GITHUB_REMOTE.exec(remote) : null;
  if (direct) return `${direct[1]}/${direct[2]}`.toLowerCase();
  if (ctx.cwdUnknown) return undefined;
  const found = new Set<string>();
  for (const dir of ctx.cwds) {
    const r = ctx.env.git(dir, ['remote', 'get-url', remote ?? 'origin']);
    if (!r.ok) continue;
    const m = GITHUB_REMOTE.exec(r.out.trim());
    if (m) found.add(`${m[1]}/${m[2]}`.toLowerCase());
    else return undefined;
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** The repo `gh` will act on: -R/--repo, then GH_REPO (assigned here or in the environment), then the origin remote. */
function ghRepo(args: Word[], ctx: NormCtx): string | undefined {
  const fromFlag = flagValue(args, ['-R', '--repo']);
  const assigned = ctx.assigns.find((a) => a.startsWith('GH_REPO='))?.slice(8) ?? ctx.env.getenv('GH_REPO');
  const raw = fromFlag ?? assigned;
  if (raw) {
    const m = /^(?:[^/\s]+\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
  }
  return repoOfRemote(ctx, undefined);
}

const MERGE_VALUE_FLAGS = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit']);

/** Positionals of `rest`, skipping flags and the values of `valueFlags`. */
function positionals(rest: Word[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i].value;
    if (v === '--') { out.push(...lits(rest.slice(i + 1))); break; }
    if (v.startsWith('-')) { if (valueFlags.has(v)) i++; continue; }
    out.push(v);
  }
  return out;
}

export function normGhPrMerge(rest: Word[], ctx: NormCtx, all: Word[] = rest): Norm {
  const [selector] = positionals(rest, MERGE_VALUE_FLAGS);
  if (!selector) return fail('name the PR by number or URL (gh pr merge <number> --repo owner/repo); the current branch is not a target');
  const url = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/i.exec(selector);
  const repo = url ? `${url[1]}/${url[2]}`.toLowerCase() : /^#?\d+$/.test(selector) ? ghRepo(all, ctx) : undefined;
  const number = url ? url[3] : /^#?(\d+)$/.exec(selector)?.[1];
  if (!number) return fail('name the PR by number or URL, not by branch');
  if (!repo) return fail('could not tell which repository (add --repo owner/repo)');
  return ok('merge', `${repo}#${number}`);
}

export function normGhWorkflowRun(rest: Word[], ctx: NormCtx, all: Word[] = rest): Norm {
  const [workflow] = positionals(rest, new Set(['-R', '--repo', '-r', '--ref', '-f', '--raw-field', '-F', '--field', '--json']));
  const repo = ghRepo(all, ctx);
  if (!workflow) return fail('name the workflow (gh workflow run <file or name> --repo owner/repo)');
  if (!repo) return fail('could not tell which repository (add --repo owner/repo)');
  return ok('other', `workflow:${repo}:${workflow}`);
}

const RELEASE_READ_ONLY = new Set(['list', 'view', 'download', 'verify', 'verify-asset']);
export const releaseIsReadOnly = (sub: string | undefined) => sub !== undefined && RELEASE_READ_ONLY.has(sub);

export function normGhRelease(rest: Word[], ctx: NormCtx, all: Word[] = rest): Norm {
  const [tag] = positionals(rest, new Set(['-R', '--repo', '-t', '--title', '-n', '--notes', '-F', '--notes-file', '--target', '--discussion-category', '--notes-start-tag']));
  const repo = ghRepo(all, ctx);
  if (!tag) return fail('name the release tag (gh release <create|edit|delete|upload> <tag> --repo owner/repo)');
  if (!repo) return fail('could not tell which repository (add --repo owner/repo)');
  return ok('publish', `release:${repo}@${tag}`);
}

// ---- GitHub API ----

export function normApi(text: string): Norm {
  const targets = new Set<string>();
  const clean = text.replace(/\u0001/g, '\u0001');
  if (clean.includes('\u0001') && /merge|refs|graphql/i.test(clean)) {
    // A placeholder inside the endpoint (e.g. pulls/$N/merge) means the target is decided at run time.
    if (/\/pulls\/[^\/\s]*\u0001[^\/\s]*\/merge|repos\/[^\s]*\u0001/i.test(clean)) return fail('the API endpoint contains a variable; write it out literally');
  }
  // Every target goes through the same canonicalTarget as an approval's: exact PR digits, lower-cased repo, and a
  // number it cannot name (0, or more than 9 digits) becomes 'unknown', which refuses the call.
  const addAll = (re: RegExp, build: (m: RegExpExecArray) => string | undefined) => {
    for (const m of clean.matchAll(re)) {
      const raw = build(m);
      let canonical: string | undefined;
      try { canonical = raw === undefined ? undefined : canonicalTarget('merge', raw); } catch { canonical = undefined; }
      targets.add(canonical ?? 'unknown');
    }
  };
  addAll(/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pulls\/(\d+)\/merge\b/gi, (m) => `${m[1]}/${m[2]}#${m[3]}`);
  addAll(/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/git\/refs\/heads\/(main|master)\b/gi, (m) => `${m[1]}/${m[2]}`.toLowerCase() + `@${m[3].toLowerCase()}`);
  addAll(/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/merges\b/gi, (m) => {
    const base = /(?:^|\n)(?:base=|"base"\s*:\s*")([A-Za-z0-9_./-]+)/.exec(clean)?.[1];
    return base ? `${m[1]}/${m[2]}`.toLowerCase() + `@${base}` : undefined;
  });
  const merged = /\/pulls\/[^\/\s]*\/merge\b|\/merges\b|\/git\/refs\/(heads\/)?(main|master)\b/i.test(clean);
  const graphql = /\bmergePullRequest\b|\benablePullRequestAutoMerge\b|\bmergeBranch\b|\bupdateRef\b|\bcreateCommitOnBranch\b/i.test(clean);
  if (graphql) return fail('GraphQL merges and ref writes cannot be tied to a target; use `gh pr merge <number> --repo owner/repo`');
  if (!merged || targets.size !== 1 || targets.has('unknown')) return fail('could not tie the API call to a single repository and PR or branch');
  const [t] = [...targets];
  return ok('merge', t);
}

// ---- package publish / deploy ----

function readJson(ctx: NormCtx, rel: string): { name?: unknown; version?: unknown; private?: unknown } | undefined {
  if (ctx.cwdUnknown) return undefined;
  const dirs = new Set<string>();
  for (const dir of ctx.cwds) {
    const r = ctx.env.readFile(path.resolve(dir, rel));
    if (r.state !== 'text') continue;
    try { dirs.add(r.text); } catch { /* skip */ }
  }
  if (dirs.size !== 1) return undefined;
  try { return JSON.parse([...dirs][0]); } catch { return undefined; }
}

function readText(ctx: NormCtx, rel: string): string | undefined {
  if (ctx.cwdUnknown) return undefined;
  const found = new Set<string>();
  for (const dir of ctx.cwds) {
    const r = ctx.env.readFile(path.resolve(dir, rel));
    if (r.state === 'text') found.add(r.text);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

const PUBLISH_VALUE_FLAGS = new Set(['--tag', '--access', '--otp', '--registry', '--prefix', '--userconfig', '--cache', '--provenance-file', '--auth-type', '--tolerate-republish', '--gzip-level']);

export function normPublish(prog: string, rest: Word[], ctx: NormCtx): Norm {
  const flags = lits(rest);
  if (flags.some((f) => /^(-w|--workspace(=.*)?|-ws|--workspaces|--recursive|-r|--filter(=.*)?)$/.test(f))) {
    return fail('publishing several workspaces at once cannot be tied to one target; publish one package directory at a time');
  }
  const pos = positionals(rest, PUBLISH_VALUE_FLAGS);
  if (pos.length > 1) return fail('give at most one package directory');
  const arg = pos[0];
  if (arg && /\.(tgz|tar\.gz)$/i.test(arg)) return fail('publishing a tarball cannot be tied to a package; publish from the package directory');
  const dir = arg && !/^(\w+:|[^./~][^/]*\/[^/]*@)/.test(arg) ? arg : undefined;
  const pkg = readJson(ctx, path.join(dir ?? '.', 'package.json'));
  if (!pkg) return fail(`could not read ${prog}'s package.json (name and version) to name the target`);
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') return fail('package.json has no name and version');
  return ok('publish', `npm:${pkg.name}@${pkg.version}`);
}

export function normChangeset(ctx: NormCtx): Norm {
  const pkg = readJson(ctx, 'package.json');
  if (!pkg || typeof pkg.name !== 'string') return fail('could not read the root package.json to name `changeset publish` (it publishes every pending package)');
  return ok('publish', `changeset:${pkg.name}`);
}

export function normScript(prog: string, script: string, ctx: NormCtx): Norm {
  const pkg = readJson(ctx, 'package.json');
  if (!pkg || typeof pkg.name !== 'string') return fail('could not read package.json to name the script');
  const verb: Verb = /^deploy/i.test(script) ? 'deploy' : 'publish';
  return ok(verb, `script:${pkg.name}:${script}`);
}

function configName(ctx: NormCtx, configFlag: string | undefined): string | undefined {
  const toml = readText(ctx, configFlag ?? 'wrangler.toml');
  if (toml !== undefined) return /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  for (const file of configFlag ? [] : ['wrangler.jsonc', 'wrangler.json']) {
    const text = readText(ctx, file);
    if (text !== undefined) return /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  }
  return undefined;
}

export function normWrangler(rest: Word[], ctx: NormCtx): Norm {
  const pos = positionals(rest, new Set(['-n', '--name', '-e', '--env', '-c', '--config', '--project-name', '--branch', '--commit-hash', '--commit-message', '--compatibility-date', '--message', '--tag']));
  if (pos[0] === 'pages') {
    const project = flagValue(rest, ['--project-name']);
    return project ? ok('deploy', `pages:${project}`) : fail('name the Pages project (--project-name)');
  }
  const name = flagValue(rest, ['-n', '--name']) ?? configName(ctx, flagValue(rest, ['-c', '--config']));
  const env = flagValue(rest, ['-e', '--env']);
  if (!name) return fail('could not tell which worker (add --name or run from a directory with a wrangler config that has a name)');
  return ok('deploy', `wrangler:${name}${env ? `:${env}` : ''}`);
}

export function normPhala(rest: Word[]): Norm {
  const name = flagValue(rest, ['-n', '--name']) ?? flagValue(rest, ['--cvm-id', '--uuid']);
  return name ? ok('deploy', `phala:${name}`) : fail('name the CVM (phala deploy --name <name>)');
}

export function normSecrets(rest: Word[]): Norm {
  const words = lits(rest);
  return ok('other', `secrets:${words.join(' ')}`);
}

// ---- git push ----

export function normPush(remote: string | undefined, branches: string[], ctx: NormCtx): Norm {
  const repo = repoOfRemote(ctx, remote);
  if (!repo) return fail('could not tell which GitHub repository the push goes to');
  const names = new Set(branches.map((b) => (/^(main|master)$/i.test(b) ? b.toLowerCase() : b)));
  if (names.size !== 1) return fail('a push to several branches cannot be tied to one target');
  return ok('merge', `${repo}@${[...names][0]}`);
}
