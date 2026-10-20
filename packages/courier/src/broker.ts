import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CourierError } from './errors.js';
import { k } from './keys.js';
import { getJson } from './store.js';
import { isConsumed, markConsumed } from './consumed.js';
import { verifyApproval, type VerifiedApproval } from './approval.js';
import { canonicalTarget } from './guard/target.js';
import { ULID } from './request.js';
import { loadProfile, profileDir, writeSecure } from './profile.js';
import { courierNode } from './node.js';
import { writeOut, type KV } from './inbox.js';
import { defer } from './defer.js';
import type { ParsedArgs } from './args.js';
import { cmd } from './program.js';

/**
 * The broker: `courier run-approved <requestId>` is the only way a woken agent's gated action runs. The agent says
 * WHEN; the owner's approved request says WHAT. The command is built here from a fixed template out of the approved verb
 * and canonical target only (nothing the agent types reaches it), run without a shell, with the owner's credential that
 * the broker reads itself from `<COURIER_HOME>/broker/gh.json`, never from the agent's environment.
 *
 * What it is not: a privilege boundary. The broker runs as the agent's own OS user, so the credential file is readable by
 * anything that user runs. The guard refuses commands that name it and the clean HOME hides the owner's own gh config,
 * but the real boundary is a separate OS user for the broker (see the README).
 */

export const MAX_OUTPUT = 4000;
const EXEC_TIMEOUT_MS = 120_000;

export interface BrokerCredential {
  /** Absolute path of the `gh` binary, fixed when the credential was set (never looked up on the agent's PATH). */
  ghBin: string;
  token: string;
}

export const brokerDir = (home = profileDir()) => path.join(home, 'broker');
export const brokerFile = (home = profileDir()) => path.join(brokerDir(home), 'gh.json');

const TOKEN = /^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/;

export function validToken(token: string): boolean {
  return TOKEN.test(token);
}

/** Read the broker's credential, or throw `broker-not-configured` with what the owner has to do. */
export function loadBrokerCredential(home = profileDir()): BrokerCredential {
  const file = brokerFile(home);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new CourierError('broker-not-configured', `No broker credential. Your owner sets one with \`${cmd('broker set-token')}\` (a GitHub token that can merge only the repositories you want merged); an agent cannot.`);
  }
  const rec = parsed as { v?: unknown; ghBin?: unknown; token?: unknown } | null;
  if (!rec || rec.v !== 1 || typeof rec.ghBin !== 'string' || typeof rec.token !== 'string' || !path.isAbsolute(rec.ghBin) || !validToken(rec.token)) {
    throw new CourierError('broker-not-configured', `The broker credential at ${file} is malformed; set it again with \`${cmd('broker set-token')}\`.`);
  }
  return { ghBin: rec.ghBin, token: rec.token };
}

// ---------- templates ----------

export interface Template {
  /** Read-only call that pins the state about to be merged. */
  view: string[];
  merge: (headSha: string) => string[];
  display: string;
}

const REPO = /^[a-z0-9_][a-z0-9_.-]{0,99}\/[a-z0-9_][a-z0-9_.-]{0,99}$/;

/**
 * The fixed command for an approved (verb, target). Only `merge` of a pull request is brokered: publish and deploy run
 * code from the agent's working tree with the owner's token, and `other`/`spend` have no safe fixed form, so their owner
 * runs them. Throws `broker-unsupported` for those.
 */
export function templateFor(verb: string, rawTarget: string): Template {
  const unsupported = (why: string) => new CourierError('broker-unsupported', `${why} Your owner runs this action; \`${cmd('run-approved')}\` only merges pull requests.`);
  if (verb !== 'merge') throw unsupported(`The broker does not run "${verb}" actions.`);
  let target: string;
  try { target = canonicalTarget('merge', rawTarget); } catch { throw unsupported(`"${rawTarget.slice(0, 60)}" is not a pull request target.`); }
  const m = /^([^#@]+)#([1-9][0-9]{0,8})$/.exec(target);
  if (!m || !REPO.test(m[1])) throw unsupported('A direct push or branch write is not brokered.');
  const [, repo, number] = m;
  return {
    // `--repo=` as one argument and a digit-only number: nothing here can read as a flag or start a second command.
    view: ['pr', 'view', number, `--repo=${repo}`, '--json', 'state,headRefOid,isDraft,baseRefName'],
    merge: (sha) => ['pr', 'merge', number, `--repo=${repo}`, '--squash', `--match-head-commit=${sha}`],
    display: `gh pr merge ${number} --repo ${repo} --squash`,
  };
}

// ---------- output ----------

const TOKEN_LIKE = /(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|(?:Bearer|token|Basic)\s+[A-Za-z0-9._~+/=-]{16,}|Authorization:\s*\S+)/gi;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** What the agent may see of a tool's output: secrets redacted, control characters gone, size capped. */
export function sanitizeOutput(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  out = out.replace(TOKEN_LIKE, '[redacted]').replace(CONTROL, ' ');
  return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n[output truncated at ${MAX_OUTPUT} characters]` : out;
}

// ---------- execution ----------

export interface ExecResult { code: number | null; stdout: string; stderr: string }
export type Exec = (bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;

/** argv exec, no shell, bounded output. */
export const execFileRunner: Exec = (bin, args, { cwd, env, timeoutMs }) => {
  const { promise, resolve } = defer<ExecResult>();
  execFile(bin, args, { cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, shell: false }, (error, stdout, stderr) => {
    const exit: unknown = error ? (error as { code?: unknown }).code : 0;
    resolve({ code: typeof exit === 'number' ? exit : 1, stdout: String(stdout ?? ''), stderr: `${String(stderr ?? '')}${error && !stderr ? error.message : ''}` });
  });
  return promise;
};

/** The only environment `gh` gets: nothing of the agent's, a throwaway HOME and config dir, the token in `GH_TOKEN`. */
export function brokerEnv(credential: BrokerCredential, scratch: string): NodeJS.ProcessEnv {
  return {
    PATH: `${path.dirname(credential.ghBin)}:/usr/bin:/bin`,
    HOME: scratch,
    GH_CONFIG_DIR: path.join(scratch, 'gh'),
    GH_TOKEN: credential.token,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    LANG: 'C',
  };
}

export interface BrokerDeps {
  kv: KV;
  credential(): BrokerCredential;
  exec: Exec;
  now(): number;
}

export interface BrokerResult {
  ok: boolean;
  requestId: string;
  verb: string;
  target: string;
  consumed: boolean;
  headSha?: string;
  command: string;
  exitCode: number | null;
  /** Untrusted text: what `gh` printed, redacted and capped. */
  output: string;
  note?: string;
}

function fail(code: string, message: string): never {
  throw new CourierError(code, message);
}

/**
 * Run the action the owner approved in request `id`. Order: verify (exact hash, decision, window, fields) → build the
 * fixed command → check the credential and the PR's state (read-only, nothing consumed yet) → mark the approval used
 * (create-only) → run. If the run fails after the marker is written the approval stays used: a retry needs a new request.
 */
export async function runApproved(id: string, deps: BrokerDeps): Promise<BrokerResult> {
  if (!ULID.test(id)) fail('usage', `"${id.slice(0, 40)}" is not a request id (a ULID). Usage: ${cmd('run-approved <requestId>')}`);
  const request = await getJson<unknown>(deps.kv, k.request(id));
  if (!request) fail('approval-mismatch', `No request ${id} in me/requests/.`);
  const approval = await getJson<unknown>(deps.kv, k.approval(id));
  if (!approval) fail('approval-missing', `No approval for request ${id} yet. Your owner decides in the view or in your chat; stop and wait.`);
  const verified: VerifiedApproval = verifyApproval(id, request.value, approval.value, { now: deps.now() });
  if (verified.decision !== 'approved') fail('approval-denied', `Your owner denied request ${id}. Do not take the action.`);

  const template = templateFor(verified.verb, verified.target);
  const credential = deps.credential();
  if (await isConsumed(deps.kv, id)) fail('approval-used', `Approval ${id} was already used; an approval covers one action.`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-broker-'));
  const env = brokerEnv(credential, scratch);
  const run = (args: string[]) => deps.exec(credential.ghBin, args, { cwd: scratch, env, timeoutMs: EXEC_TIMEOUT_MS });
  const clean = (text: string) => sanitizeOutput(text, [credential.token]);
  const base = { requestId: id, verb: verified.verb, target: verified.target, command: template.display };
  try {
    // Read-only: pin the state about to be merged, and refuse before anything is consumed if it is not mergeable.
    const view = await run(template.view);
    if (view.code !== 0) fail('broker-view-failed', `Could not read the pull request (nothing was consumed): ${clean(view.stderr || view.stdout).slice(0, 300)}`);
    let state: { state?: unknown; headRefOid?: unknown; isDraft?: unknown } = {};
    try { state = JSON.parse(view.stdout); } catch { fail('broker-view-failed', 'Could not read the pull request state (nothing was consumed).'); }
    if (state.state !== 'OPEN' || state.isDraft === true) fail('broker-not-mergeable', `The pull request is ${state.isDraft === true ? 'a draft' : String(state.state).toLowerCase()}; nothing was consumed.`);
    const sha = typeof state.headRefOid === 'string' && /^[0-9a-f]{40}$/.test(state.headRefOid) ? state.headRefOid : fail('broker-view-failed', 'The pull request has no readable head commit (nothing was consumed).');

    await markConsumed(deps.kv, id, new Date(deps.now()));
    const merged = await run(template.merge(sha));
    const ok = merged.code === 0;
    return {
      ...base, ok, consumed: true, headSha: sha, exitCode: merged.code,
      output: clean(`${merged.stdout}${merged.stderr ? `\n${merged.stderr}` : ''}`).trim(),
      ...(ok ? {} : { note: 'The approval is used up. If the merge should still happen, file a new request.' }),
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------- commands ----------

export const runApprovedUsage = () => `Usage: ${cmd('run-approved <requestId>')}`;

export async function cmdRunApproved(args: ParsedArgs): Promise<void> {
  const id = args.positional[0] ?? fail('usage', runApprovedUsage());
  if (args.positional.length !== 1 || args.flags.size > 0) fail('usage', runApprovedUsage());
  const node = await courierNode(loadProfile());
  const result = await runApproved(id, { kv: node.kv, credential: () => loadBrokerCredential(), exec: execFileRunner, now: () => Date.now() });
  await writeOut(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) throw new CourierError('broker-run-failed', `The approved action ran and failed (exit ${result.exitCode}); the approval is used up.`);
}

export const brokerUsage = () =>
  `Usage: ${cmd('broker set-token [--gh-bin <path>]')}   (token on stdin; humans only)\n` +
  `       ${cmd('broker status')}\n       ${cmd('broker clear')}`;

/** `courier broker …`: the owner installs the credential the broker merges with. Never an agent. */
export async function cmdBroker(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  if (sub === 'status') {
    let configured = false;
    let ghBin: string | undefined;
    try { ({ ghBin } = loadBrokerCredential()); configured = true; } catch { /* not configured */ }
    await writeOut(`${JSON.stringify({ configured, ...(ghBin ? { ghBin } : {}), file: brokerFile() }, null, 2)}\n`);
    return;
  }
  if (sub === 'clear') {
    fs.rmSync(brokerFile(), { force: true });
    await writeOut('{"configured":false}\n');
    return;
  }
  if (sub !== 'set-token') fail('usage', brokerUsage());
  let ghBin = args.get('gh-bin');
  if (ghBin === 'true') fail('usage', '--gh-bin needs a path.');
  if (ghBin === undefined) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(dir || '.', 'gh');
      try { fs.accessSync(candidate, fs.constants.X_OK); ghBin = fs.realpathSync(candidate); break; } catch { /* next */ }
    }
  }
  if (!ghBin || !path.isAbsolute(ghBin)) fail('usage', 'Could not find gh; pass --gh-bin <absolute path>.');
  try { fs.accessSync(ghBin, fs.constants.X_OK); } catch { fail('usage', `${ghBin} is not an executable file.`); }
  const token = fs.readFileSync(0, 'utf8').trim();
  if (!validToken(token)) fail('usage', 'Expected a GitHub token (ghp_…, gho_…, ghs_…, ghu_… or github_pat_…) on stdin.');
  fs.mkdirSync(brokerDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(brokerDir(), 0o700);
  writeSecure(brokerFile(), { v: 1, ghBin, token });
  await writeOut(`${JSON.stringify({ configured: true, ghBin, file: brokerFile() }, null, 2)}\n`);
}
