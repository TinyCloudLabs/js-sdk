import fs from 'node:fs';
import path from 'node:path';
import { mkdirOwnerOnly, profileDir } from './profile.js';

/**
 * A directory under the profile (`<COURIER_HOME>/<parts…>`) whose whole chain, the profile directory included, was
 * checked component by component: each one opened without following a symlink, a directory, this user's, and
 * owner-only. `chain` keeps each component's device and inode so the chain can be checked again right before use.
 */
export interface PrivateDir {
  path: string;
  chain: Array<{ path: string; dev: number; ino: number }>;
}

/** Opens one directory without following a symlink; tightens a looser mode to 0700. Undefined if it is not ours. */
function checkOne(dir: string): { dev: number; ino: number } | undefined {
  let fd: number;
  try { fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); } catch { return undefined; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) return undefined;
    if ((stat.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o700);
    return { dev: stat.dev, ino: stat.ino };
  } finally { fs.closeSync(fd); }
}

/**
 * `<COURIER_HOME>/<parts…>` as a checked private directory, created 0700 where missing when `create` is set.
 * Undefined if it is missing (without `create`) or if any component is a symlink, not a directory or another user's:
 * then nothing is read from or written to it.
 */
export function privateDir(parts: readonly string[], create: boolean): PrivateDir | undefined {
  if (create) mkdirOwnerOnly(profileDir());
  const chain: PrivateDir['chain'] = [];
  let dir = profileDir();
  for (const part of ['', ...parts]) {
    if (part) {
      if (part === '.' || part === '..' || part.includes('/')) return undefined;
      dir = path.join(dir, part);
      if (create) {
        try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined; }
      }
    }
    const id = checkOne(dir);
    if (!id) return undefined;
    chain.push({ path: dir, ...id });
  }
  return { path: dir, chain };
}

/** True if every component is still the same directory (device and inode) and not a symlink: check right before use. */
export function stillPrivate(dir: PrivateDir): boolean {
  return dir.chain.every(({ path: component, dev, ino }) => {
    try {
      const stat = fs.lstatSync(component);
      return stat.isDirectory() && stat.dev === dev && stat.ino === ino && stat.uid === process.getuid?.();
    } catch { return false; }
  });
}

/** A child directory of a checked private directory, checked the same way; undefined if it is not a private directory. */
export function privateChild(dir: PrivateDir, name: string): PrivateDir | undefined {
  if (name === '.' || name === '..' || name.includes('/') || !stillPrivate(dir)) return undefined;
  const child = path.join(dir.path, name);
  const id = checkOne(child);
  if (!id || !stillPrivate(dir)) return undefined;
  return { path: child, chain: [...dir.chain, { path: child, ...id }] };
}
