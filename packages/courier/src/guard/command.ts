import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ParsedArgs } from '../args.js';
import { CourierError } from '../errors.js';
import { cmd } from '../program.js';
import { profileDir } from '../profile.js';
import { writeOut } from '../inbox.js';
import { discoverBinaries, type BinaryIdentity } from './binaries.js';
import { brokerRoot } from '../broker-config.js';
import { decide, hookOutput, type GuardDeps } from './hook.js';
import { guardSettings, writeGuardSettings } from './install.js';
import { installRoots, protectedSet, realpathBest } from './paths.js';
import type { FileRead, PolicyEnv } from './policy.js';

const MAX_FILE = 1_000_000;
const MAX_STDIN = 4_000_000;
/** The whole decision, network included, must finish well inside the hook timeout (60 s) or the call is refused. */
const DEADLINE_MS = 25_000;

/** Where this install lives: what the hook refuses to let a command name or an edit tool write. */
export function installLiterals(home: string, entry: string): string[] {
  return [realpathBest(home), ...installRoots(entry)].filter((p) => p.length >= 8);
}

export function realEnv(cwd: string, home = profileDir(), entry = process.argv[1] ?? ''): PolicyEnv {
  let installed: BinaryIdentity[] = [];
  try { installed = JSON.parse(fs.readFileSync(path.join(home, 'guard/binaries.json'), 'utf8')); if (!Array.isArray(installed)) installed = []; } catch { /* discovery still covers tools on PATH */ }
  return {
    cwd,
    binaries: [...installed, ...discoverBinaries(process.env.PATH ?? '', cwd)],
    literals: [...installLiterals(home, entry), brokerRoot()],
    protectedRoots: [home, brokerRoot(), path.join(os.homedir(), '.courier')],
    realHome: process.env.COURIER_REAL_HOME || os.userInfo().homedir,
    courierEntries: [realpathBest(entry), realpathBest(path.join(path.dirname(entry), 'cli.js'))],
    readFile(file): FileRead {
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) return { state: 'absent' };
        if (st.size > MAX_FILE) return { state: 'unreadable' };
        return { state: 'text', text: fs.readFileSync(file, 'utf8') };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'absent' } : { state: 'unreadable' };
      }
    },
    git(dir, args) {
      const r = spawnSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      });
      return { ok: r.status === 0 && !r.error, out: typeof r.stdout === 'string' ? r.stdout : '' };
    },
    getenv: (name) => process.env[name],
  };
}

function readStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  let total = 0;
  for (;;) {
    let n = 0;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'EAGAIN') continue;
      if (code === 'EOF') break;
      throw error;
    }
    if (n === 0) break;
    total += n;
    if (total > MAX_STDIN) throw new Error('hook input too large');
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function refuse(message: string): never {
  // Exit 2 is the only non-zero status Claude Code treats as "block the tool call"; flush stderr first.
  fs.writeSync(2, `${message}\n`);
  process.exit(2);
}

export const guardUsage = () =>
  `Usage: ${cmd('guard')}   (Claude Code PreToolUse hook: reads the tool call JSON on stdin)\n` +
  `       ${cmd('guard settings [--out file] [--claude-settings file]')}   Print or write the Claude Code settings that install the hook`;

/**
 * `courier guard`: the Claude Code PreToolUse hook. Reads one tool call on stdin, prints a permission decision. Any
 * failure refuses the call (exit 2). `courier guard settings` prints the settings that wire it in.
 */
export async function cmdGuard(args: ParsedArgs): Promise<void> {
  if (args.positional[0] === 'settings') return guardSettingsCommand(args);
  if (args.positional.length) throw new CourierError('usage', guardUsage());
  try {
    const input: unknown = JSON.parse(readStdin());
    const home = profileDir();
    const entry = process.argv[1] ?? '';
    // The hook runs with the agent's environment: HOME is the agent's clean one, so the owner's real home comes from the settings.
    const realHome = process.env.COURIER_REAL_HOME || os.homedir();
    const deps: GuardDeps = {
      env: realEnv(process.cwd(), home, entry),
      protectedSet: { ...protectedSet(home, entry, { agentHome: os.homedir() }), roots: [...protectedSet(home, entry).roots, brokerRoot(), path.join(os.homedir(), '.courier')], homes: [...new Set([realHome, os.homedir()])], realHome },
    };
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), DEADLINE_MS).unref());
    const decision = await Promise.race([decide(input, deps), timeout]);
    await writeOut(hookOutput(decision));
  } catch (error) {
    refuse(`Courier guard refused: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
  }
}

/** The command (`node <entry> [tc prefix] guard`) a hook should run, derived from how this process was started. */
export function guardArgv(invocation: string[] = process.argv): string[] {
  const rest = invocation.slice(2);
  const at = rest.indexOf('watch');
  const gi = rest.indexOf('guard');
  const prefix = rest.slice(0, at >= 0 ? at : gi >= 0 ? gi : rest.length > 0 && rest[0] === 'courier' ? 1 : 0);
  return [process.execPath, invocation[1], ...prefix, 'guard'];
}

async function guardSettingsCommand(args: ParsedArgs): Promise<void> {
  const home = profileDir();
  const argv = guardArgv();
  const entry = process.argv[1] ?? '';
  const user = args.get('claude-settings');
  if (user === 'true') throw new CourierError('usage', '--claude-settings needs a file.');
  const out = args.get('out');
  if (out === 'true') throw new CourierError('usage', '--out needs a file.');
  if (out === undefined && user === undefined) {
    await writeOut(`${JSON.stringify(guardSettings({ argv, home, entry }), null, 2)}\n`);
    return;
  }
  const file = writeGuardSettings({ argv, home, entry, ...(user !== undefined ? { userSettings: user } : {}) });
  if (out !== undefined) fs.copyFileSync(file, path.resolve(out));
  await writeOut(`${path.resolve(out ?? file)}\n`);
}
