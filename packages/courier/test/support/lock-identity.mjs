// What a lock record says about the machine it was written on, so a test can write a record Courier is allowed to judge locally.
import fs from 'node:fs';
import os from 'node:os';

const first = (...files) => { for (const file of files) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* next */ } } return undefined; };

export const LOCAL = {
  host: os.hostname(),
  pidns: fs.readlinkSync('/proc/self/ns/pid'),
  machine: first('/etc/machine-id', '/var/lib/dbus/machine-id'),
  boot: first('/proc/sys/kernel/random/boot_id'),
};
