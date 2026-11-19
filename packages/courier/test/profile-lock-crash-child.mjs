// Child of profile-lock.test.mjs: starts a save and is killed (SIGKILL) at the moment it would replace profile.json, holding the lock.
import fs from 'node:fs';
import { loadProfile, saveProfile } from '../dist/profile.js';

const profile = loadProfile();
profile.peers.doomed = { handle: 'doomed', ownerDid: 'did:pkh:eip155:1:0x0000000000000000000000000000000000000001', courierDid: 'did:key:zdoomed', spaceId: 's', outbound: [], status: 'paired', pairedAt: new Date().toISOString() };
const rename = fs.renameSync;
fs.renameSync = (from, to) => { if (String(to).endsWith('profile.json')) process.kill(process.pid, 'SIGKILL'); return rename(from, to); };
saveProfile(profile);
