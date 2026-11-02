import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PREFIX } from '../dist/keys.js';
import { loadProfile } from '../dist/profile.js';
import { fakeTime, homeFile, readHome, readySpace, scenario, signedGrant, stubSpaceProbe } from './support/approval-fixture.mjs';

// TC-2300, from a live Courier run: an agent retyped the ~2.3 KB link and one copy silently widened the hooks scope
// `kv/xyz.tinycloud.courier/` to `kv/xyz.tinycloud.courier/me/state/`, another had a typo. Two defences are pinned here:
// the link is printed on a line of its own so it can be copied verbatim, and a grant whose hooks scope differs from the
// requested one is refused with nothing installed and nothing acknowledged.

const HOOKS_PATH = `kv/${PREFIX}/`;
const lines = (text) => text.split('\n');

scenario('init --request prints the link on a stderr line of its own, equal to openkeyUrl, and keeps the stdout JSON', async ({ request, errors }) => {
  const printed = await request();
  assert.ok(lines(errors.join('\n')).includes(printed.openkeyUrl), 'a stderr line is exactly the openkeyUrl');
  assert.equal(lines(errors.join('\n')).filter((line) => line.includes('openkey.so/a/')).length, 1, 'and the link appears once, on that line');
  assert.match(printed.openkeyUrl, /^https:\/\/openkey\.so\/a\/[a-z2-7]{26}#v=4&k=[A-Za-z0-9_-]+&c=[A-Za-z0-9_-]+$/);
});

scenario('init --wait prints the link on a stderr line of its own, whether it made the request or resumed it', async ({ t, request, courier, errors }) => {
  fakeTime(t);
  const printed = await request();
  const resumed = await courier('--wait', '--timeout', '5s');
  assert.equal(resumed.code, 8);
  assert.ok(lines(resumed.stderr).includes(printed.openkeyUrl));
  assert.equal(JSON.parse(resumed.stdout).pending.approvalUrl, printed.openkeyUrl);
  errors.length = 0;
  fs.rmSync(homeFile('approval-pending.json'));
  const created = await courier('--wait', '--timeout', '5s');
  assert.equal(created.code, 8);
  const link = JSON.parse(created.stdout).pending.approvalUrl;
  assert.notEqual(link, printed.openkeyUrl);
  assert.ok(lines(created.stderr).includes(link));
});

for (const [name, hooksPath] of [
  ['widened to me/state/', `${HOOKS_PATH}me/state/`],
  ['retyped with a typo', 'kv/xyz.tinycloud.courer/'],
  ['narrowed to to/', `${HOOKS_PATH}to/`],
]) {
  scenario(`a short-link approval whose hooks scope is ${name} is refused: nothing installed, nothing acknowledged`, async ({ t, fx, request, courier }) => {
    stubSpaceProbe(t, readySpace);
    const printed = await request();
    await fx.approve(printed.openkeyUrl, { grant: { hooksPath } });
    const run = await courier('--wait');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /\[grant-too-broad\]/);
    assert.match(run.stderr, /tinycloud\.hooks/);
    assert.equal(fs.existsSync(homeFile('grant.json')), false);
    assert.equal(loadProfile().status, 'awaiting-grant');
    assert.equal(fx.acks.length, 0);
    assert.equal(fs.existsSync(homeFile('approval-pending.json')), false, 'the refused approval cannot loop; --request makes a new link');
    assert.notEqual((await request()).openkeyUrl, printed.openkeyUrl);
  });

  scenario(`a legacy --grant-file import whose hooks scope is ${name} is refused: nothing installed`, async ({ t, request, courier }) => {
    stubSpaceProbe(t, readySpace);
    await request();
    const grant = await signedGrant(readHome('key.json'), { hooksPath });
    fs.writeFileSync(homeFile('legacy-grant.json'), JSON.stringify(grant));
    const run = await courier('--grant-file', homeFile('legacy-grant.json'));
    assert.equal(run.code, 1);
    assert.match(run.stderr, /\[grant-too-broad\]/);
    assert.equal(fs.existsSync(homeFile('grant.json')), false);
    assert.equal(loadProfile().status, 'awaiting-grant');
  });
}

scenario('the exact requested hooks scope is accepted (the refusals above are about the scope, not the flow)', async ({ t, fx, request, courier }) => {
  stubSpaceProbe(t, readySpace);
  const printed = await request();
  await fx.approve(printed.openkeyUrl, { grant: { hooksPath: HOOKS_PATH } });
  assert.equal((await courier('--wait')).code, 0);
  assert.equal(loadProfile().status, 'ready');
});
