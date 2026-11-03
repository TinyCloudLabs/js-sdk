// What a lock record says about the machine it was written on, so a test can write a record Courier is allowed to judge locally.
import fs from 'node:fs';
import os from 'node:os';
import { machineIdentity } from '../../dist/file-lock.js';

const ns = (name) => { try { return fs.readlinkSync(`/proc/self/ns/${name}`); } catch { return undefined; } };
const pidns = ns('pid');
const timens = ns('time');

// Reading /proc/1/ns/pid needs ptrace rights on init, which an ordinary user lacks: there Courier correctly refuses to trust /proc (fail closed).
// Tests that exercise the /proc evidence paths run as if the process may read it, answering with its own pid namespace; the unreadable case has
// its own tests that override this. Where the real read works (root, a container's own init), nothing is patched.
try {
  fs.readlinkSync('/proc/1/ns/pid');
} catch {
  const readlink = fs.readlinkSync;
  fs.readlinkSync = (file, ...rest) => (String(file) === '/proc/1/ns/pid' ? readlink('/proc/self/ns/pid', ...rest) : readlink(file, ...rest));
}

export const LOCAL = { host: os.hostname(), ...(pidns === undefined ? {} : { pidns }), ...(timens === undefined ? {} : { timens }), ...machineIdentity() };

/** The recovery command a refusal must name on this platform (an independent statement of the quoting rules, not the implementation's). */
export const removalCommand = (file) => (process.platform === 'win32'
  ? `Remove-Item -LiteralPath '${file.replace(/['\u2018-\u201B]/g, (quote) => quote + quote)}' -Force`
  : `rm -f -- '${file.replace(/'/g, `'\\''`)}'`);
