// Child of profile-concurrency.test.mjs: waits for a start file, then loads the profile, adds one paired peer and saves.
import fs from 'node:fs';
import { loadProfile, saveProfile } from '../dist/profile.js';

const [startFile, handle] = process.argv.slice(2);
const profile = loadProfile();
process.send?.('ready');
while (!fs.existsSync(startFile)) { /* spin: all children release together */ }
profile.peers[handle] = { handle, ownerDid: 'did:pkh:eip155:1:0x0000000000000000000000000000000000000001', courierDid: `did:key:z${handle}`, spaceId: 's', outbound: [], status: 'paired', pairedAt: new Date().toISOString() };
saveProfile(profile);
