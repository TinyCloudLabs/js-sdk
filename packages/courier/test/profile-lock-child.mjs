// Child of profile-lock.test.mjs: like profile-concurrency-child.mjs, but a save pauses after reading profile.json (so any two savers inside
// the lock at once would lose an update) and reports when it was inside the lock.
import fs from 'node:fs';
import { loadProfile, saveProfile } from '../dist/profile.js';

const [startFile, handle] = process.argv.slice(2);
const profile = loadProfile();
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const read = fs.readFileSync;
let enter;
fs.readFileSync = (file, ...rest) => { const out = read(file, ...rest); if (String(file).endsWith('profile.json')) { enter = Date.now(); pause(30); } return out; };
const replace = fs.renameSync;
fs.renameSync = (from, to) => { replace(from, to); if (String(to).endsWith('profile.json')) process.send?.({ enter, exit: Date.now() }); };
process.send?.('ready');
while (!fs.existsSync(startFile)) { /* spin: all children release together */ }
profile.peers[handle] = { handle, ownerDid: 'did:pkh:eip155:1:0x0000000000000000000000000000000000000001', courierDid: `did:key:z${handle}`, spaceId: 's', outbound: [], status: 'paired', pairedAt: new Date().toISOString() };
saveProfile(profile);
