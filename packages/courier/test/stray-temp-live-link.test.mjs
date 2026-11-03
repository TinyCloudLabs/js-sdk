import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homeFile, scenario } from './support/approval-fixture.mjs';
import { DEAD_PID, snapshot } from './support/review-fixture.mjs';
import { writeTempIdentity } from './support/lock-identity.mjs';

// TC-2383: a stray temp file that is not a plain single-link file of this user is refused whether or not the process that named it is
// running. The liveness skip must not hide the refusal: a live pid (pids are small numbers and are reused) and a hard link or symlink to
// another file together still stop `init`, and nothing is touched.

// Liveness is injected for the "running" holder and a pid that really exited is used for the "gone" holder: no pid number is assumed.
const LIVE = 4_999_994;
const HEX = '0a1b2c3d4e5f';

/** `process.kill(LIVE, 0)` answers as for a running process; every other call is the real one. */
function liveProcess(t) {
  const real = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => (signal === 0 && pid === LIVE ? true : real.call(process, pid, signal)));
}

const HOLDERS = { 'running': LIVE, 'gone': DEAD_PID };
const LINKS = {
  'a hard link': (victim, temp) => fs.linkSync(victim, temp),
  'a symlink': (victim, temp) => fs.symlinkSync(victim, temp),
};

for (const [holder, pid] of Object.entries(HOLDERS)) {
  for (const file of ['key.json', 'rotation.json', 'approval-pending.json']) {
    for (const [kind, link] of Object.entries(LINKS)) {
      scenario(`a ${file} temp that is ${kind} to another file is refused when its holder is ${holder}, and nothing is touched`, async (ctx) => {
        liveProcess(ctx.t);
        await ctx.request();
        const victim = homeFile('victim.json');
        fs.writeFileSync(victim, JSON.stringify({ keep: 'this content' }), { mode: 0o600 });
        const name = `${file}.${pid}.${HEX}.tmp`;
        link(victim, homeFile(name));
        writeTempIdentity(homeFile(name), pid, HEX);
        const before = snapshot();
        const linkTarget = kind === 'a symlink' ? fs.readlinkSync(homeFile(name)) : undefined;
        ctx.errors.length = 0;
        const run = await ctx.courier('--request');
        assert.equal(run.code, 1, run.stderr);
        assert.match(run.stderr, /\[stray-temp\]/);
        assert.ok(run.stderr.includes(name), run.stderr);
        assert.deepEqual(snapshot(), before, 'no file was zeroed, replaced or removed');
        if (linkTarget !== undefined) assert.equal(fs.readlinkSync(homeFile(name)), linkTarget);
      });
    }
  }
}
