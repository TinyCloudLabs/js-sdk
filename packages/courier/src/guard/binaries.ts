import fs from 'node:fs';
import path from 'node:path';
import { realpathBest } from './paths.js';

const GATED_BINARIES = ['gh', 'git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pnpx', 'wrangler', 'phala', 'paseo', 'claude', 'codex', 'omp', 'opencode', 'gemini', 'tc', 'tinycloud', 'curl', 'wget', 'nc', 'ncat', 'socat', 'vercel', 'netlify', 'fly', 'flyctl', 'docker'];
export interface BinaryIdentity { name: string; path: string; dev: number; ino: number }

export function discoverBinaries(searchPath: string, cwd: string): BinaryIdentity[] {
  const found: BinaryIdentity[] = [];
  for (const dir of searchPath.split(path.delimiter)) for (const name of GATED_BINARIES) {
    const file = path.resolve(cwd, dir || '.', name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      const st = fs.statSync(file);
      if (st.isFile()) found.push({ name, path: realpathBest(file), dev: st.dev, ino: st.ino });
    } catch { /* unavailable tool */ }
  }
  return found;
}

/** Realpath catches symlinks; dev/ino also catches hardlinks and a rename since installation. */
export function binaryName(file: string, cwd: string, searchPath: string, known: readonly BinaryIdentity[]): string | undefined {
  const candidates = file.includes('/') ? [path.resolve(cwd, file)] : searchPath.split(path.delimiter).map(dir => path.resolve(cwd, dir || '.', file));
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      const real = realpathBest(candidate);
      const hit = known.find(b => real === b.path || (st.dev === b.dev && st.ino === b.ino));
      if (hit) return hit.name;
      if (!file.includes('/') && st.isFile()) return undefined;
    } catch { /* next PATH entry */ }
  }
  return undefined;
}

/** Directory copies can carry a gated executable too. */
export function gatedSource(file: string, cwd: string, known: readonly BinaryIdentity[]): boolean {
  const real = realpathBest(path.resolve(cwd, file));
  if (binaryName(file, cwd, '', known)) return true;
  try { return fs.statSync(real).isDirectory() && known.some(b => b.path.startsWith(`${real}${path.sep}`)); } catch { return false; }
}

/** Resolve an executable even when its name is not part of the gated census. */
export function executablePath(file: string, cwd: string, searchPath: string): string | undefined {
  const candidates = file.includes('/') ? [path.resolve(cwd, file)] : searchPath.split(path.delimiter).map(dir => path.resolve(cwd, dir || '.', file));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return realpathBest(candidate); } catch { /* next */ }
  }
  return undefined;
}
