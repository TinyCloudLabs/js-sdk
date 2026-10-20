import path from 'node:path';
import { CourierError } from '../errors.js';
import { isRecord } from '../a2a.js';
import { verifyApproval } from '../approval.js';
import { isConsumed, markConsumed } from '../consumed.js';
import { cmd } from '../program.js';
import { k } from '../keys.js';
import { getJson, listAll } from '../store.js';
import type { KV } from '../inbox.js';
import { analyze, type Finding, type PolicyEnv } from './policy.js';
import { canonicalTarget } from './target.js';

/**
 * Claude Code `PreToolUse` decision for one tool call (spec §7). Three outcomes:
 *  - `pass`: not a gated command; say nothing, so Claude's own permission rules decide as usual;
 *  - `allow`: a gated command with a matching, current, unused owner approval, consumed just now;
 *  - `deny`: everything else, including every error.
 * Only the command, the owner's own `me/` records and the clock are consulted. Inbound message text never is.
 */
export type Decision = { kind: 'pass' } | { kind: 'allow'; reason: string } | { kind: 'deny'; reason: string };

export interface GuardDeps {
  env: PolicyEnv;
  /** The owner's space as the courier key sees it. Only called when a gated command needs an approval. */
  openKv(): Promise<KV>;
  now(): number;
  /** Absolute paths no tool call may write (guard files, the hook itself, the courier profile). */
  protectedPaths: string[];
}

const SAFE_ID = /^[0-9A-Za-z_-]{1,64}$/;
const MAX_CANDIDATES = 60;
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit']);

const short = (text: string, n = 160) => text.replace(/\s+/g, ' ').slice(0, n);
const deny = (reason: string): Decision => ({ kind: 'deny', reason });

export function toolCommand(input: unknown): { tool: string; command?: string; file?: string } | undefined {
  if (!isRecord(input) || typeof input.tool_name !== 'string') return undefined;
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
  const file = typeof toolInput.file_path === 'string' ? toolInput.file_path : typeof toolInput.notebook_path === 'string' ? toolInput.notebook_path : undefined;
  return { tool: input.tool_name, command: typeof toolInput.command === 'string' ? toolInput.command : undefined, ...(file !== undefined ? { file } : {}) };
}

function isProtected(file: string, cwd: string, protectedPaths: string[]): boolean {
  const abs = path.resolve(cwd, file);
  return protectedPaths.some((p) => abs === p || abs.startsWith(p.endsWith(path.sep) ? p : `${p}${path.sep}`));
}

export async function decide(input: unknown, deps: GuardDeps): Promise<Decision> {
  try {
    const call = toolCommand(input);
    if (!call) return deny('Courier guard could not read this tool call; refusing.');
    const cwd = isRecord(input) && typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : deps.env.cwd;
    const tool = call.tool.toLowerCase();

    if (WRITE_TOOLS.has(tool)) {
      if (call.file === undefined) return deny('Courier guard could not read the file path of this edit; refusing.');
      return isProtected(call.file, cwd, deps.protectedPaths)
        ? deny('That file belongs to the Courier guard or the Courier profile and cannot be edited from a woken agent.')
        : { kind: 'pass' };
    }
    if (tool.startsWith('mcp__paseo')) return deny('Paseo tools can start agents outside the Courier guard and are not available to a woken agent.');
    if (tool === 'powershell') return deny('PowerShell cannot be inspected by the Courier guard; use Bash.');
    if (call.command === undefined) {
      if (tool === 'bash') return deny('Courier guard could not read the Bash command; refusing.');
      return { kind: 'pass' };
    }
    return await decideCommand(call.command, { ...deps, env: { ...deps.env, cwd } });
  } catch (error) {
    return deny(`Courier guard failed (${short(String((error as Error)?.message ?? error), 120)}); refusing.`);
  }
}

async function decideCommand(command: string, deps: GuardDeps): Promise<Decision> {
  const findings = analyze(command, deps.env);
  const never = findings.filter((f): f is Extract<Finding, { kind: 'never' }> => f.kind === 'never');
  if (never.length) return deny(`Blocked: ${never[0].label}. This is not something an owner approval can unlock.`);
  const unresolved = findings.filter((f): f is Extract<Finding, { kind: 'unresolved' }> => f.kind === 'unresolved');
  if (unresolved.length) {
    return deny(
      `Blocked: ${unresolved[0].label}. The Courier guard cannot tell this command apart from a gated one (merge, deploy, publish, push to main, secrets). ` +
        'Run each such command on its own, written out literally; if it is gated, ask your owner with a request.',
    );
  }
  const gated = findings.filter((f): f is Extract<Finding, { kind: 'gated' }> => f.kind === 'gated');
  if (!gated.length) return { kind: 'pass' };
  if (gated.length > 1) return deny(`Blocked: this command contains ${gated.length} gated actions (${gated.map((g) => g.display).join('; ')}). Run each one separately, each with its own approval.`);

  const [g] = gated;
  const how = `Ask your owner first: ${cmd(`request <threadId> --peer <peer> --task <taskId> --verb ${g.verb} --target ${g.target} --summary "…"`)}, then stop and wait for the approval.`;
  const approved = await consumeMatchingApproval(g, deps);
  if (approved.kind === 'ok') return { kind: 'allow', reason: `Approved by your owner (request ${approved.id}: ${g.verb} ${g.target}); the approval is now used.` };
  if (approved.kind === 'denied') return deny(`Blocked: your owner denied ${g.verb} ${g.target} (request ${approved.id}). Do not take this action.`);
  return deny(`Blocked: ${g.verb} ${g.target} needs an approval from your owner and none is current (${approved.why}). ${how}`);
}

type Outcome = { kind: 'ok'; id: string } | { kind: 'denied'; id: string } | { kind: 'none'; why: string };

/** Find a current approved request for exactly (verb, target) and use it up. Throws on any state it cannot read. */
async function consumeMatchingApproval(finding: Extract<Finding, { kind: 'gated' }>, deps: GuardDeps): Promise<Outcome> {
  const kv = await deps.openKv();
  const keys = await listAll(kv, k.approvalsPrefix);
  const ids = keys
    .map((key) => /\/([^/]+)\.json$/.exec(key)?.[1])
    .filter((id): id is string => id !== undefined && SAFE_ID.test(id))
    .sort()
    .reverse()
    .slice(0, MAX_CANDIDATES);
  let denied: string | undefined;
  let sawApproved = false;
  for (const id of ids) {
    const request = (await getJson<unknown>(kv, k.request(id)))?.value;
    const approval = (await getJson<unknown>(kv, k.approval(id)))?.value;
    if (request === undefined || approval === undefined || !isRecord(request)) continue;
    let verified;
    try {
      verified = verifyApproval(id, request, approval, { now: deps.now() });
    } catch {
      continue; // wrong request, hash mismatch, expired, malformed: not an approval for anything
    }
    if (verified.verb !== finding.verb) continue;
    let target: string;
    try { target = canonicalTarget(finding.verb, verified.target); } catch { continue; }
    if (target !== finding.target) continue;
    if (verified.decision === 'denied') { denied ??= id; continue; }
    sawApproved = true;
    if (await isConsumed(kv, id)) continue;
    try {
      await markConsumed(kv, id, new Date(deps.now()));
    } catch (error) {
      if (error instanceof CourierError && error.code === 'approval-used') continue;
      throw error;
    }
    return { kind: 'ok', id };
  }
  if (denied) return { kind: 'denied', id: denied };
  return { kind: 'none', why: sawApproved ? 'the matching approval was already used' : 'no approved request for this exact action' };
}

/** What Claude Code reads from the hook's stdout. `pass` writes nothing. */
export function hookOutput(decision: Decision): string {
  if (decision.kind === 'pass') return '';
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.kind,
      permissionDecisionReason: decision.reason,
    },
  })}\n`;
}
