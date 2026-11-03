// What a lock record says about the machine it was written on, so a test can write a record Courier is allowed to judge locally.
import fs from 'node:fs';
import os from 'node:os';
import { machineIdentity } from '../../dist/file-lock.js';

const pidns = (() => { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return undefined; } })();

export const LOCAL = { host: os.hostname(), ...(pidns === undefined ? {} : { pidns }), ...machineIdentity() };
