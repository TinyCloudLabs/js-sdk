import fs from 'node:fs';
import path from 'node:path';
import { realpathBest } from './paths.js';

const GATED_BINARIES = ['gh', 'git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pnpx', 'wrangler', 'phala', 'paseo', 'claude', 'codex', 'omp', 'opencode', 'gemini', 'tc', 'tinycloud', 'curl', 'wget', 'nc', 'ncat', 'socat', 'vercel', 'netlify', 'fly', 'flyctl', 'docker'];
const POLICY_PROGRAMS = [...GATED_BINARIES,
  'changeset', 'lerna', 'semantic-release', 'make', 'gmake', 'turbo', 'nx', 'just', 'corepack',
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'csh', 'tcsh', 'fish',
  'python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'perl', 'ruby', 'php', 'lua', 'luajit', 'tsx', 'ts-node', 'osascript',
  'env', 'nohup', 'nice', 'ionice', 'setsid', 'stdbuf', 'timeout', 'unbuffer', 'chronic', 'flock', 'script', 'strace', 'ltrace', 'taskset', 'chrt',
  'watch', 'parallel', 'xargs', 'find', 'caffeinate', 'xvfb-run', 'dbus-run-session', 'xdotool', 'nsjail', 'firejail', 'busybox', 'toybox', 'entr', 'cronic', 'cpulimit',
  'sudo', 'doas', 'su', 'runuser', 'pkexec', 'setpriv', 'unshare', 'nsenter', 'chroot', 'machinectl', 'run0', 'tmux', 'screen', 'byobu', 'zellij', 'crontab', 'at', 'batch', 'systemctl', 'systemd-run', 'launchctl', 'loginctl', 'ssh', 'scp', 'sftp', 'rsync', 'netcat', 'telnet',
  'cursor-agent', 'amp', 'aider', 'goose', 'http', 'https', 'httpie', 'xh', 'xhs', 'aria2c',
  'echo', 'printf', 'pwd', 'test', '[', 'true', 'false', 'ls', 'cat', 'grep', 'rg', 'sed', 'awk', 'head', 'tail', 'sort', 'uniq', 'wc', 'cut', 'tr', 'tee', 'cp', 'mv', 'ln', 'install', 'hardlink', 'mkdir', 'rm', 'rmdir', 'touch', 'sleep', 'date', 'diff', 'which', 'whoami', 'id', 'strings', 'jq', 'dd', 'sponge', 'tsc', 'eslint', 'vitest', 'jest', 'cargo', 'rustc', 'gcc', 'cc', 'go', 'cmake', 'ctest', 'tar', 'gzip', 'unzip', 'zip',
];
export interface BinaryIdentity { name: string; path: string; dev: number; ino: number }

export function discoverBinaries(searchPath: string, cwd: string): BinaryIdentity[] {
  const found: BinaryIdentity[] = [];
  for (const name of new Set(POLICY_PROGRAMS)) for (const dir of searchPath.split(path.delimiter)) {
    const file = path.resolve(cwd, dir || '.', name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      const st = fs.statSync(file);
      if (st.isFile()) { found.push({ name, path: realpathBest(file), dev: st.dev, ino: st.ino }); break; }
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
      const hit = known.find(b => st.isFile() && st.dev === b.dev && st.ino === b.ino);
      if (hit) return hit.name;
      if (!file.includes('/') && st.isFile()) return undefined;
    } catch { /* next PATH entry */ }
  }
  return undefined;
}

/** Directory copies can carry a gated executable too. */
export function gatedSource(file: string, cwd: string, known: readonly BinaryIdentity[]): boolean {
  known = known.filter(b => GATED_BINARIES.includes(b.name) || b.name === 'courier');
  const real = realpathBest(path.resolve(cwd, file));
  if (binaryName(file, cwd, '', known)) return true;
  try { return fs.statSync(real).isDirectory() && known.some(b => b.path.startsWith(`${real}${path.sep}`)); } catch { return false; }
}

/** The installed Courier entry is the sole Courier exemption; arbitrary PATH entries named courier never enroll. */
export function courierBinary(entry: string, argv: readonly string[]): BinaryIdentity[] {
  try {
    const st = fs.statSync(entry);
    return st.isFile() ? [{ name: argv.slice(2).includes('courier') ? 'tc' : 'courier', path: realpathBest(entry), dev: st.dev, ino: st.ino }] : [];
  } catch { return []; }
}

/** Write refusals protect both the pinned pathname and aliases to its inode. This is not an execution exemption. */
export function registeredFile(file: string, cwd: string, known: readonly BinaryIdentity[]): boolean {
  const real = realpathBest(path.resolve(cwd, file));
  return known.some(b => real === b.path) || binaryName(file, cwd, '', known) !== undefined;
}

/** Automatic guard refreshes must not enroll a tool the previous wake placed earlier on PATH. */
export function installBinaryCensus(file: string, entry: string, argv: readonly string[], cwd: string): void {
  if (fs.existsSync(file)) return;
  const census = [...courierBinary(entry, argv), ...discoverBinaries(process.env.PATH ?? '', cwd)];
  try { fs.writeFileSync(file, JSON.stringify(census), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
