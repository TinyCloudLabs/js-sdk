// TC-2917 follow-up: `courier read --full` fetches every entry again (and keeps the fresh copies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from 'ulid';
import { diskThreadCache } from '../dist/thread.js';

const AGENT = 'did:key:z6MkAgentA';

test('a full read starts from an empty cache and replaces what was kept', () => {
  const threadId = ulid();
  const first = diskThreadCache(AGENT, threadId);
  first.set('peer:x:key', { v: 'old' });
  first.save();
  assert.deepEqual(diskThreadCache(AGENT, threadId).get('peer:x:key'), { v: 'old' });
  const full = diskThreadCache(AGENT, threadId, undefined, true);
  assert.equal(full.get('peer:x:key'), undefined, 'nothing served from the cache');
  full.set('peer:x:key', { v: 'new' });
  full.save();
  assert.deepEqual(diskThreadCache(AGENT, threadId).get('peer:x:key'), { v: 'new' });
});
