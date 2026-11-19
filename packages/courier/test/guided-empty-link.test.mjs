import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PREFIX } from '../dist/keys.js';
import { createGuidedFixture } from './support/guided-fixture.mjs';

const root = process.env.COURIER_TEST_HOME;
assert.ok(root, 'setup-home.mjs must isolate every Courier profile');
const fixture = await createGuidedFixture(path.join(root, 'guided-empty-link'), process.env.COURIER_CLI);
test.after(() => fixture.close());

test('an explicitly empty --link refuses without persisting or activating a fallback session', async () => {
  const agent = await fixture.home('empty-link-flag');
  const prefix = `${agent.profile.spaceId}/${PREFIX}/me/state/sessions/`;
  const sessionsBefore = [...fixture.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  const result = await fixture.launch(agent, ['start', '--link', '', '--new', 'Unrequested fallback session', '--consent']).done;
  assert.notEqual(result.code, 0);
  assert.deepEqual([...fixture.values.keys()].filter((key) => key.startsWith(prefix)).sort(), sessionsBefore);
  assert.equal(fs.existsSync(path.join(agent.home, 'active-session.json')), false);
});

test('an empty positional invitation refuses without replacing an existing active session', async () => {
  const agent = await fixture.home('empty-link-positional');
  await fixture.run(agent, ['start', '--new', 'Intended existing session']);
  const activeFile = path.join(agent.home, 'active-session.json');
  const activeBefore = fs.readFileSync(activeFile);
  const prefix = `${agent.profile.spaceId}/${PREFIX}/me/state/sessions/`;
  const sessionsBefore = [...fixture.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  const result = await fixture.launch(agent, ['start', '', '--new', 'Unrequested fallback session', '--consent']).done;
  assert.notEqual(result.code, 0);
  assert.deepEqual([...fixture.values.keys()].filter((key) => key.startsWith(prefix)).sort(), sessionsBefore);
  assert.deepEqual(fs.readFileSync(activeFile), activeBefore);
});
