import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homeFile } from './support/approval-fixture.mjs';
import { scenario } from './support/approval-fixture.mjs';
import { readyProfile, snapshot } from './support/review-fixture.mjs';

// TC-2383: a saved approval that cannot be read may hold an approval bound to the OLD key. Any `init --rotate-key`, not only with
// --request or --wait, stops before the journal or any other file is written, naming the file and the chmod that fixes it.

for (const mode of [0o644, 0o000]) {
  scenario(`init --rotate-key over an approval at mode ${mode.toString(8).padStart(3, '0')} refuses with chmod advice and changes nothing`, async (ctx) => {
    const grant = await readyProfile(ctx);
    await ctx.request();
    // The grant file is only there so a rotation that wrongly went on would have something to consume.
    fs.writeFileSync(homeFile('another-grant.json'), JSON.stringify(grant), { mode: 0o600 });
    const before = snapshot();
    fs.chmodSync(homeFile('approval-pending.json'), mode);
    ctx.errors.length = 0;
    const run = await ctx.courier('--rotate-key', '--grant-file', homeFile('another-grant.json'));
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, /\[approval-unreadable\]/);
    assert.match(run.stderr, /approval-pending\.json/);
    assert.match(run.stderr, /chmod 600/);
    assert.equal(fs.existsSync(homeFile('rotation.json')), false, 'no journal was written');
    fs.chmodSync(homeFile('approval-pending.json'), 0o600);
    assert.deepEqual(snapshot(), before, 'key, profile, grant and approval are byte-identical');
  });
}
