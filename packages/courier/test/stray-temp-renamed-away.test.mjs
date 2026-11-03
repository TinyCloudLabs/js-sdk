import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homeFile, scenario } from './support/approval-fixture.mjs';
import { writeTempIdentity } from './support/lock-identity.mjs';

// TC-2383: a writer that is still running renames its temp file into place when it finishes. If that happens between the listing of the
// temp files and the check of this one, the file has simply moved: it is skipped, not reported as an error.

const LIVE = 4_999_995;
const NAME = `key.json.${LIVE}.0a1b2c3d4e5f.tmp`;

scenario('a live writer\'s temp file renamed into place after it was listed is skipped, not a raw ENOENT', async (ctx) => {
  const realKill = process.kill;
  ctx.t.mock.method(process, 'kill', (pid, signal) => (signal === 0 && pid === LIVE ? true : realKill.call(process, pid, signal)));
  await ctx.request();
  fs.writeFileSync(homeFile(NAME), '{"v":1}\n', { mode: 0o600 });
  writeTempIdentity(homeFile(NAME), LIVE, '0a1b2c3d4e5f');
  // The writer's rename lands exactly between the listing and the check of the file.
  const realLstat = fs.lstatSync;
  let moved = false;
  ctx.t.mock.method(fs, 'lstatSync', (target, ...rest) => {
    if (!moved && String(target) === homeFile(NAME)) {
      moved = true;
      fs.renameSync(homeFile(NAME), homeFile('moved-into-place.json'));
      fs.unlinkSync(homeFile(`${NAME}.identity`));
    }
    return realLstat.call(fs, target, ...rest);
  });
  ctx.errors.length = 0;
  const run = await ctx.courier('--request');
  assert.equal(moved, true, 'the race was exercised');
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /ENOENT/);
  assert.equal(run.stderr.includes(NAME), false, 'a file that is gone is not reported as kept');
  assert.equal(fs.existsSync(homeFile('moved-into-place.json')), true, 'the writer\'s file is untouched');
});
