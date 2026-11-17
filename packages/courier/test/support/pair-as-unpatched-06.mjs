// These tests cover renewal of pairings made by 0.6.x issuers: before TC-3173 a first-time manual pairing signed its peer
// delegations for 30 days, and a current build signs 7. This helper completes A→B→C through the real CLI with the issue
// lifetime of those earlier builds (unpatched-06-hooks.mjs loads dist/pairing.js with 30d), so both sides hold the 30-day
// delegations those pairings carry. The 7-day path itself is covered by pairing-issue-limit.test.mjs.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { courierRegistryFixtureEnv } from './registry-fixture.mjs';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const REGISTER = fileURLToPath(new URL('./unpatched-06-register.mjs', import.meta.url));
// Never execFileSync: the child answers through the test's in-process stub host, which needs this process's event loop free.
const execFileAsync = promisify(execFile);

/** Complete A→B→C against `host`; `a` addresses `b` as `aPeerHandle`, `b` addresses `a` as `callMe`. Returns the parsed artifacts. */
export async function pairAsUnpatched06(host, a, aPeerHandle, b, callMe) {
  const run = async (home, args) => {
    const { stdout } = await execFileAsync(process.execPath, ['--import', REGISTER, CLI, ...args], {
      env: courierRegistryFixtureEnv(home, host),
      encoding: 'utf8',
    });
    return JSON.parse(stdout);
  };
  const artA = await run(a.home, ['pair', 'start', aPeerHandle, '--call-me', callMe]);
  const artB = await run(b.home, ['pair', 'accept', JSON.stringify(artA)]);
  const artC = await run(a.home, ['pair', 'accept', JSON.stringify(artB)]);
  const done = await run(b.home, ['pair', 'accept', JSON.stringify(artC)]);
  return { artA, artB, artC, done };
}
