// Helpers shared by the TC-2383 review-fix tests. Not a test file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadProfile } from '../../dist/profile.js';
import { homeFile, readHome, readySpace, signedGrant, stubSpaceProbe } from './approval-fixture.mjs';

export const OWNER_WALLET = 'a1'.repeat(32);
export const REVOKE = 'https://account.tinycloud.xyz/delegations';

/** A ready profile with its installed grant.json, as left by a finished install. */
export async function readyProfile({ t, request, courier }) {
  stubSpaceProbe(t, readySpace);
  await request();
  const grant = await signedGrant(readHome('key.json'), { wallet: OWNER_WALLET });
  fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
  assert.equal((await courier('--grant-file', homeFile('legacy-grant.json'))).code, 0);
  fs.rmSync(homeFile('legacy-grant.json'));
  fs.rmSync(homeFile('approval-pending.json'), { force: true });
  assert.equal(loadProfile().status, 'ready');
  return grant;
}

/** Every file in the Courier home: bytes and mode. */
export function snapshot() {
  const dir = path.dirname(homeFile('x'));
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, {
    bytes: fs.readFileSync(path.join(dir, name)).toString('base64'),
    mode: fs.statSync(path.join(dir, name)).mode & 0o777,
  }]));
}

/** True when any `size`-character window of `secret` appears in `text`. Returns the first such window, or undefined. */
export function leakedWindow(text, secret, size = 8) {
  for (let i = 0; i + size <= secret.length; i += 1) {
    const window = secret.slice(i, i + size);
    if (text.includes(window)) return window;
  }
  return undefined;
}

export const crashBeforeUnlink = (t, file, Crash) => {
  const original = fs.unlinkSync;
  fs.unlinkSync = (target, ...rest) => {
    if (path.basename(String(target)) === file) throw new Crash(`before removing ${file}`);
    return original(target, ...rest);
  };
  t.after(() => { fs.unlinkSync = original; });
  return { disarm: () => { fs.unlinkSync = original; } };
};

/** The pid of a process that has already exited: no test may assume a fixed pid is (or is not) running. */
export const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid;
