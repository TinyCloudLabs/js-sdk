// TC-2917 (Bobbie P2): the read-cache directories are tightened to 0700 on first use, and thread files left at the cache
// root by the version before per-agent caches are deleted once. Runs in its own process, so first use is this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { diskThreadCache } from '../dist/thread.js';
import { profileDir } from '../dist/profile.js';

test('existing looser cache directories become 0700 and pre-upgrade root-level thread files are pruned', () => {
  const root = path.join(profileDir(), 'read-cache');
  const agentDir = path.join(root, 'z6MkAgentA');
  const otherAgent = path.join(root, 'z6MkAgentB');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(otherAgent, { recursive: true });
  for (const dir of [root, agentDir, otherAgent]) fs.chmodSync(dir, 0o755);
  const legacy = path.join(root, `${ulid()}.json`);
  fs.writeFileSync(legacy, '{"self:x":{"old":true}}', { mode: 0o644 });
  const kept = path.join(agentDir, `${ulid()}.json`);
  fs.writeFileSync(kept, '{}', { mode: 0o600 });

  diskThreadCache('did:key:z6MkAgentA', ulid());
  assert.equal(fs.existsSync(legacy), false, 'the root-level thread file is gone');
  assert.ok(fs.existsSync(kept), 'per-agent files are untouched');
  for (const dir of [root, agentDir, otherAgent]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700, `${path.basename(dir)} is 0700`);

  // Only once per process: a file appearing later at the root is not the pre-upgrade layout and is left to its owner.
  const later = path.join(root, 'later.json');
  fs.writeFileSync(later, '{}');
  diskThreadCache('did:key:z6MkAgentA', ulid());
  assert.ok(fs.existsSync(later));
});
