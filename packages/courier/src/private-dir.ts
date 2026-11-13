import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { profileDir } from './profile.js';

/**
 * Courier's local caches (`read-cache/`, `watch-cache/`) live in checked private directories under COURIER_HOME.
 *
 * - COURIER_HOME must be a real directory of this user (not a symlink), and every ancestor up to `/` must be owned
 *   by root or this user and not writable by group or others. One exception: a sticky world-writable directory
 *   (`/tmp`, `/var/tmp`) is allowed if the component directly beneath it is this user's and owner-only. This is the
 *   rule ssh's StrictModes uses: only root or this user can then swap a component, which is out of scope.
 * - Each directory below COURIER_HOME is opened without following a symlink, checked through that descriptor (a
 *   directory, this user's), and only then tightened to 0700 through the same descriptor. Its device and inode are
 *   kept, and the whole chain is checked again right before each read, write or delete.
 * - If any check fails, the cache is not used: nothing is read, written, changed or deleted there.
 */
export interface PrivateDir {
  path: string;
  chain: Array<{ path: string; dev: number; ino: number }>;
}

const me = () => process.getuid?.();

/** True if every ancestor of `dir` (a real path) passes the StrictModes rule above. */
function safeAncestors(dir: string): boolean {
  const parts = dir.split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const ancestor = path.sep + parts.slice(0, i).join(path.sep);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(ancestor); } catch { return false; }
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== me())) return false;
    if ((stat.mode & 0o022) === 0) continue;
    if ((stat.mode & 0o1000) === 0) return false; // group/other-writable and not sticky
    let beneath: fs.Stats;
    try { beneath = fs.lstatSync(path.join(ancestor, parts[i])); } catch { return false; }
    if (!beneath.isDirectory() || beneath.uid !== me() || (beneath.mode & 0o077) !== 0) return false;
  }
  return true;
}

/** Opens a directory without following a symlink; undefined unless it is a directory of this user. The caller closes it. */
function openDir(dir: string): { fd: number; stat: fs.Stats } | undefined {
  let fd: number;
  try { fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); } catch { return undefined; }
  const stat = fs.fstatSync(fd);
  if (stat.isDirectory() && stat.uid === me()) return { fd, stat };
  fs.closeSync(fd);
  return undefined;
}

/** Appends `dir` to a verified chain: opened no-follow, the chain re-checked, and only then tightened through the fd. */
function extend(chain: PrivateDir['chain'], dir: string): PrivateDir['chain'] | undefined {
  const opened = openDir(dir);
  if (!opened) return undefined;
  try {
    const next = [...chain, { path: dir, dev: opened.stat.dev, ino: opened.stat.ino }];
    if (!stillPrivate({ path: dir, chain: next })) return undefined;
    if ((opened.stat.mode & 0o077) !== 0) fs.fchmodSync(opened.fd, 0o700);
    return next;
  } finally { fs.closeSync(opened.fd); }
}

/** COURIER_HOME as the first link of a chain, or undefined if it or an ancestor fails the rule above. */
function home(create: boolean): PrivateDir['chain'] | undefined {
  const configured = path.resolve(profileDir());
  let parent: string;
  try { parent = fs.realpathSync(path.dirname(configured)); } catch { return undefined; }
  const dir = path.join(parent, path.basename(configured));
  if (!safeAncestors(dir)) return undefined;
  if (create) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined; }
  }
  return extend([], dir);
}

const SAFE_NAME = /^[0-9A-Za-z_.-]{1,128}$/;
const safeName = (name: string) => SAFE_NAME.test(name) && name !== '.' && name !== '..';

/** `<COURIER_HOME>/<parts…>` as a checked private directory, created 0700 where missing when `create` is set. */
export function privateDir(parts: readonly string[], create: boolean): PrivateDir | undefined {
  let chain = home(create);
  if (!chain) return undefined;
  for (const part of parts) {
    if (!safeName(part)) return undefined;
    const dir = path.join(chain[chain.length - 1].path, part);
    if (create) {
      if (!stillPrivate({ path: dir, chain })) return undefined;
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined; }
    }
    chain = extend(chain, dir);
    if (!chain) return undefined;
  }
  return { path: chain[chain.length - 1].path, chain };
}

/** True if every component is still the same directory (device and inode), this user's, and not a symlink. */
export function stillPrivate(dir: PrivateDir): boolean {
  return dir.chain.every(({ path: component, dev, ino }) => {
    try {
      const stat = fs.lstatSync(component);
      return stat.isDirectory() && stat.dev === dev && stat.ino === ino && stat.uid === me();
    } catch { return false; }
  });
}

/** A child directory of a checked private directory, checked the same way; undefined if it is not one. */
export function privateChild(dir: PrivateDir, name: string): PrivateDir | undefined {
  if (!safeName(name) || !stillPrivate(dir)) return undefined;
  const chain = extend(dir.chain, path.join(dir.path, name));
  return chain ? { path: chain[chain.length - 1].path, chain } : undefined;
}

/** Reads a regular file of this user in a checked directory, never through a symlink; undefined otherwise. */
export function readPrivateFile(dir: PrivateDir, name: string): string | undefined {
  if (!safeName(name) || !stillPrivate(dir)) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(dir.path, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== me() || !stillPrivate(dir)) return undefined;
    return fs.readFileSync(fd, 'utf8');
  } catch { return undefined; } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Writes pretty JSON and a newline atomically (a create-only, no-follow temp file, then a rename) in a checked directory. */
export function writePrivateFile(dir: PrivateDir, name: string, value: unknown): boolean {
  if (!safeName(name) || !stillPrivate(dir)) return false;
  const temp = path.join(dir.path, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let created = false;
  try {
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
      fs.fchmodSync(fd, 0o600);
    } finally { fs.closeSync(fd); }
    if (!stillPrivate(dir)) return false;
    fs.renameSync(temp, path.join(dir.path, name));
    created = false;
    return true;
  } catch { return false; } finally {
    if (created) try { fs.unlinkSync(temp); } catch { /* already gone */ }
  }
}

/** Unlinks a file of this user in a checked directory, after checking the chain and the entry again just before. */
export function unlinkPrivateFile(dir: PrivateDir, name: string): boolean {
  if (!safeName(name) || !stillPrivate(dir)) return false;
  const file = path.join(dir.path, name);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory() || stat.uid !== me() || !stillPrivate(dir)) return false;
    fs.unlinkSync(file);
    return true;
  } catch { return false; }
}

/** Deletes a checked private directory and everything in it, each step after re-checking the chain. */
function removeTree(dir: PrivateDir): void {
  for (const name of fs.readdirSync(dir.path)) {
    if (!stillPrivate(dir)) return;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(path.join(dir.path, name)); } catch { continue; }
    if (stat.isDirectory()) {
      const child = privateChild(dir, name);
      if (child) removeTree(child);
    } else unlinkPrivateFile(dir, name);
  }
  if (!stillPrivate(dir) || dir.chain.length < 2) return;
  try { fs.rmdirSync(dir.path); } catch { /* not empty: something was refused */ }
}

/**
 * Deletes `<COURIER_HOME>/<name>`: a checked private directory tree, or, if `<name>` is a symlink or a file, only that
 * entry (never what a link points at).
 */
export function removePrivate(name: string): void {
  if (!safeName(name)) return;
  const chain = home(false);
  if (!chain) return;
  const base: PrivateDir = { path: chain[0].path, chain };
  let stat: fs.Stats;
  try { stat = fs.lstatSync(path.join(base.path, name)); } catch { return; }
  if (!stat.isDirectory()) { unlinkPrivateFile(base, name); return; }
  const dir = privateChild(base, name);
  if (dir) removeTree(dir);
}
