import { CourierError } from './errors.js';

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string[]>;
  has(name: string): boolean;
  get(name: string): string | undefined;
  all(name: string): string[];
}

/** Minimal parser: `--flag value`, `--flag=value`, `--flag` (boolean), `-h`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const BOOLS: Record<string, true> = { json: true, help: true, force: true, stdin: true, 'code-stdin': true, quiet: true, 'rotate-key': true, paste: true, request: true, peek: true, resume: true, once: true, unguarded: true, 'install-launchd': true, 'install-systemd': true, 'dry-run': true, 'also-ask': true, 'credential-stdin': true };
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq === -1 ? undefined : eq);
      if (eq !== -1) {
        flags.set(name, [...(flags.get(name) ?? []), a.slice(eq + 1)]);
      } else if (BOOLS[name] || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        flags.set(name, [...(flags.get(name) ?? []), 'true']);
      } else {
        flags.set(name, [...(flags.get(name) ?? []), argv[++i]]);
      }
    } else if (a === '-h') {
      flags.set('help', ['true']);
    } else {
      positional.push(a);
    }
  }
  return {
    positional,
    flags,
    has: (n) => flags.has(n),
    get: (n) => flags.get(n)?.[flags.get(n)!.length - 1],
    all: (n) => flags.get(n) ?? [],
  };
}

export function requireFlag(args: ParsedArgs, name: string, usage: string): string {
  const v = args.get(name);
  if (v === undefined || v === 'true') throw new CourierError('usage', `--${name} is required. ${usage}`);
  return v;
}

export function oneOf(args: ParsedArgs, names: string[]): string | undefined {
  const present = names.filter((n) => args.has(n));
  if (present.length > 1) throw new CourierError('usage', `Flags ${present.map((n) => `--${n}`).join(', ')} are mutually exclusive.`);
  return present[0];
}
