// TC-2917 follow-up (Bobbie's conditions on #944): the one-time cache tidy-up deletes only pre-upgrade thread files
// (`read-cache/<ULID>.json`) and never changes the mode of anything a symlink points at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { clearReadCache, diskOwnIndex, diskThreadCache, recordOwnWrite } from '../dist/thread.js';
import { profileDir } from '../dist/profile.js';

test('only thread-named root files are pruned, and a symlinked directory is never chmodded', () => {
  const root = path.join(profileDir(), 'read-cache');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const thread = path.join(root, `${ulid()}.json`);
  const other = path.join(root, 'notes.json');
  const lower = path.join(root, `${ulid().toLowerCase()}.json`);
  for (const file of [thread, other, lower]) fs.writeFileSync(file, '{}');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tc2917-outside-'));
  fs.chmodSync(outside, 0o755);
  fs.symlinkSync(outside, path.join(root, 'z6MkLinked'));

  diskThreadCache('did:key:z6MkAgentA', ulid());

  assert.equal(fs.existsSync(thread), false, 'the pre-upgrade thread file is gone');
  assert.ok(fs.existsSync(other), 'a root file that is not a thread file stays');
  assert.ok(fs.existsSync(lower), 'neither does a name that is not a ULID');
  assert.equal(fs.statSync(outside).mode & 0o777, 0o755, 'the symlink target keeps its mode');
  fs.rmSync(outside, { recursive: true, force: true });
});

test('nothing is written or trusted through a symlinked directory inside the cache', () => {
  const root = path.join(profileDir(), 'read-cache');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tc2917-outside-'));
  const threadId = ulid();
  // The agent's own-writes directory is a link out of the cache.
  fs.mkdirSync(path.join(root, 'z6MkAgentB'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(outside, path.join(root, 'z6MkAgentB', 'own'));
  recordOwnWrite('did:key:z6MkAgentB', 'space', threadId, `xyz/to/bob/threads/${threadId}/msg/m.json`);
  const own = diskOwnIndex('did:key:z6MkAgentB', 'space', threadId);
  own.listed(`xyz/to/bob/threads/${threadId}`, [`xyz/to/bob/threads/${threadId}/msg/m.json`]);
  assert.equal(own.keys(`xyz/to/bob/threads/${threadId}`), undefined, 'the record is not used: the side is listed');
  // The agent's whole cache directory is a link out of the cache.
  fs.symlinkSync(outside, path.join(root, 'z6MkAgentD'));
  const cache = diskThreadCache('did:key:z6MkAgentD', threadId);
  cache.set('peer:x:key', { v: 1 });
  cache.save();
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the cache');
  fs.rmSync(outside, { recursive: true, force: true });
});

test('a cache root that is a symlink is neither chmodded nor written through', () => {
  clearReadCache(); // the next use prepares the root again
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tc2917-outside-'));
  fs.chmodSync(outside, 0o755);
  fs.symlinkSync(outside, path.join(profileDir(), 'read-cache'));
  const cache = diskThreadCache('did:key:z6MkAgentA', ulid());
  cache.set('peer:x:key', { v: 1 });
  cache.save();
  assert.equal(fs.statSync(outside).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.rmSync(path.join(profileDir(), 'read-cache'));
  fs.rmSync(outside, { recursive: true, force: true });
});
