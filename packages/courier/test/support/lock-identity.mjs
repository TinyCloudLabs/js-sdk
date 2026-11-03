// What a lock record says about the machine it was written on, so a test can write a record Courier is allowed to judge locally.
import fs from 'node:fs';
import os from 'node:os';
import { machineIdentity } from '../../dist/file-lock.js';

const pidns = (() => { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return undefined; } })();

export const LOCAL = { host: os.hostname(), ...(pidns === undefined ? {} : { pidns }), ...machineIdentity() };

/** The recovery command a refusal must name on this platform (an independent statement of the quoting rules, not the implementation's). */
export const removalCommand = (file) => (process.platform === 'win32'
  ? `Remove-Item -LiteralPath '${file.replace(/['\u2018-\u201B]/g, (quote) => quote + quote)}' -Force`
  : `rm -f -- '${file.replace(/'/g, `'\\''`)}'`);
