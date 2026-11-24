import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { APPROVAL_FILE, LEGACY_APPROVAL_FILE } from '@tinycloud/share-envelope/links';
import { approvalPhase, readApprovalEntry } from '../dist/approval-phase.js';

// TC-2377: the v2 pending-approval file has its own name, `approval-pending.v2.json`. This Courier (until it adopts the requester
// machine) reads only `approval-pending.json`. It must refuse v2 safely: never read, change, set aside or delete it.

const home = process.env.COURIER_HOME;
const v2File = () => path.join(home, APPROVAL_FILE);
const v1File = () => path.join(home, LEGACY_APPROVAL_FILE);
/** A v2 file as a newer reader writes it (the content does not matter to this Courier, only that it is v2). */
const V2_TEXT = `${JSON.stringify({ version: 2, entries: [{ requestId: 'abcdefghijklmnopqrstuvwxyz', keys: { relayPrivateKey: 'secret-relay-key' } }], unrecognized: [] }, null, 2)}\n`;

function setUp() {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.rmSync(v1File(), { force: true });
  fs.rmSync(v2File(), { force: true });
}
const BOTH = { profile: true, key: true };

test('a v2 file under its own name is not seen: no saved request, and the file is untouched', () => {
  setUp();
  fs.writeFileSync(v2File(), V2_TEXT, { mode: 0o600 });
  assert.deepEqual(readApprovalEntry(), { kind: 'none' });
  assert.deepEqual(approvalPhase(readApprovalEntry(), BOTH), { phase: 'none' });
  assert.equal(fs.readFileSync(v2File(), 'utf8'), V2_TEXT);
});

test('v2 content under approval-pending.json is refused as a newer record, kept as it is, never set aside', () => {
  setUp();
  fs.writeFileSync(v1File(), V2_TEXT, { mode: 0o600 });
  const entry = readApprovalEntry();
  assert.equal(entry.kind, 'unreadable');
  assert.match(entry.reason, /newer Courier \(record version 2\)/);
  assert.doesNotMatch(JSON.stringify(entry), /secret-relay-key/);
  assert.equal(approvalPhase(entry, BOTH).phase, 'unreadable');
  assert.equal(fs.readFileSync(v1File(), 'utf8'), V2_TEXT);
  assert.deepEqual(fs.readdirSync(home).filter((name) => name.startsWith(LEGACY_APPROVAL_FILE)), [LEGACY_APPROVAL_FILE]);
});
