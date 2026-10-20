import path from 'node:path';
import { isRecord } from '../a2a.js';
import { cmd } from '../program.js';
import { analyze, type Finding, type PolicyEnv } from './policy.js';
import { isCredentialFile, isProtectedFile, type ProtectedSet } from './paths.js';

/**
 * Claude Code `PreToolUse` decision for one tool call (spec §7). The hook never allows a gated action: it classifies and
 * refuses. Merges run through `courier run-approved <requestId>` (the broker, `broker.ts`), which checks the owner's
 * approval itself and runs a fixed command with the owner's credential outside the agent's environment. Two outcomes:
 *  - `pass`: not a gated command; say nothing, so Claude's own permission rules decide as usual;
 *  - `deny`: everything else, including every error.
 * Only the tool call itself is read. Message text, task text and the owner's records never are, and the hook needs no
 * network, so a missing profile or a node outage cannot change what it decides.
 */
export type Decision = { kind: 'pass' } | { kind: 'deny'; reason: string };

export interface GuardDeps {
  env: PolicyEnv;
  /** Real paths no tool call may write (courier home, install roots) and the homes whose tool configuration is protected. */
  protectedSet: ProtectedSet;
  /** MCP tool names (exact, or `mcp__server__*`) a woken agent may use. Default: none. */
  mcpAllow?: readonly string[];
}

const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit']);
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'notebookread', 'ls', 'lsp']);
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;

const short = (text: string, n = 160) => text.replace(/\s+/g, ' ').slice(0, n);
const deny = (reason: string): Decision => ({ kind: 'deny', reason });

/** The file-ish and command-ish strings of a tool call. */
export function toolCommand(input: unknown): { tool: string; command?: string; files: string[]; patterns: string[]; url?: string } | undefined {
  if (!isRecord(input) || typeof input.tool_name !== 'string') return undefined;
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
  const str = (key: string) => (typeof toolInput[key] === 'string' ? (toolInput[key] as string) : undefined);
  const files = ['file_path', 'notebook_path', 'path'].map(str).filter((v): v is string => v !== undefined);
  const patterns = ['pattern', 'glob'].map(str).filter((v): v is string => v !== undefined);
  return { tool: input.tool_name, command: str('command'), files, patterns, ...(str('url') !== undefined ? { url: str('url') } : {}) };
}

function mcpAllowed(tool: string, allow: readonly string[]): boolean {
  return allow.some((entry) => entry === tool || (entry.endsWith('*') && tool.startsWith(entry.slice(0, -1))));
}

export async function decide(input: unknown, deps: GuardDeps): Promise<Decision> {
  try {
    const call = toolCommand(input);
    if (!call) return deny('Courier guard could not read this tool call; refusing.');
    const cwd = isRecord(input) && typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : deps.env.cwd;
    const tool = call.tool.toLowerCase();

    if (tool.startsWith('mcp__')) {
      return mcpAllowed(call.tool, deps.mcpAllow ?? [])
        ? { kind: 'pass' }
        : deny('MCP tools are not available to a woken agent (they run with their own credentials, outside the Courier guard).');
    }
    if (WRITE_TOOLS.has(tool)) {
      if (call.files.length === 0) return deny('Courier guard could not read the file path of this edit; refusing.');
      for (const file of call.files) {
        if (isProtectedFile(file, cwd, deps.protectedSet)) return deny('That file belongs to the Courier guard, the Courier profile or the tool configuration (settings, hooks, MCP, git hooks) and cannot be edited from a woken agent.');
        if (isCredentialFile(file, cwd)) return deny('That file holds credentials and cannot be written from a woken agent.');
      }
      return { kind: 'pass' };
    }
    if (READ_TOOLS.has(tool)) {
      for (const file of call.files) if (isCredentialFile(file, cwd)) return deny('That path holds credentials and cannot be read from a woken agent.');
      for (const pattern of call.patterns) if (isCredentialFile(pattern, cwd)) return deny('That pattern reaches credential paths and cannot be used from a woken agent.');
      return { kind: 'pass' };
    }
    if (tool === 'webfetch' || tool === 'websearch') {
      if (call.url) {
        let host = '';
        try { host = new URL(call.url).hostname; } catch { return deny('Courier guard could not read that URL; refusing.'); }
        if (LOOPBACK.test(host)) return deny('Requests to this machine (loopback) are not available to a woken agent: local services such as the Paseo daemon can start agents outside the guard.');
      }
      return { kind: 'pass' };
    }
    if (tool === 'powershell') return deny('PowerShell cannot be inspected by the Courier guard; use Bash.');
    if (call.command === undefined) {
      if (tool === 'bash') return deny('Courier guard could not read the Bash command; refusing.');
      return { kind: 'pass' };
    }
    return decideCommand(call.command, { ...deps, env: { ...deps.env, cwd } });
  } catch (error) {
    return deny(`Courier guard failed (${short(String((error as Error)?.message ?? error), 120)}); refusing.`);
  }
}

/** The merge verb with a PR target is the one action the broker runs; everything else is for the owner to do. */
export const isBrokered = (verb: string, target: string) => verb === 'merge' && /#\d+$/.test(target);

function decideCommand(command: string, deps: GuardDeps): Decision {
  const findings = analyze(command, deps.env);
  const never = findings.filter((f): f is Extract<Finding, { kind: 'never' }> => f.kind === 'never');
  if (never.length) return deny(`Blocked: ${never[0].label}. This is not something an owner approval can unlock.`);
  const unresolved = findings.filter((f): f is Extract<Finding, { kind: 'unresolved' }> => f.kind === 'unresolved');
  if (unresolved.length) {
    return deny(
      `Blocked: ${unresolved[0].label}. The Courier guard cannot tell this command apart from a gated one (merge, deploy, publish, push to main, secrets). ` +
        'Write the command out with plain words, one action per call.',
    );
  }
  const gated = findings.filter((f): f is Extract<Finding, { kind: 'gated' }> => f.kind === 'gated');
  if (!gated.length) return { kind: 'pass' };

  const [g] = gated;
  const more = gated.length > 1 ? ` (and ${gated.length - 1} more gated action${gated.length > 2 ? 's' : ''} in the same call)` : '';
  const how = isBrokered(g.verb, g.target)
    ? `Merging goes through the broker: ${cmd(`request <threadId> --peer <peer> --task <taskId> --verb ${g.verb} --target ${g.target} --summary "…"`)}, stop and wait for your owner's approval, then run exactly ${cmd('run-approved <requestId>')}.`
    : `Agents do not run this action in v0: ask your owner with ${cmd(`request <threadId> --peer <peer> --task <taskId> --verb ${g.verb} --target ${g.target} --summary "…"`)}; your owner runs it.`;
  return deny(`Blocked: ${g.verb} ${g.target}${more} is a gated action and a woken agent never runs it directly. ${how}`);
}

/** What Claude Code reads from the hook's stdout. `pass` writes nothing. */
export function hookOutput(decision: Decision): string {
  if (decision.kind === 'pass') return '';
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  })}\n`;
}
