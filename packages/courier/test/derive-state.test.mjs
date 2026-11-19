import assert from 'node:assert/strict';
import { DEAD_PID } from './support/review-fixture.mjs';
import { writeTempIdentity } from './support/lock-identity.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classifyState, deriveState } from '../dist/state.js';

// TC-2383: one deriveState() over profile.status, spacePending, grant.json, key.json, pending-grant.json,
// approval-pending.json and the key-rotation journal rotation.json. The table below is the expected recovery for EVERY
// combination of those inputs (first matching row wins; `*` matches anything). Rows are written from the code paths
// that write these files, not from deriveState's own rules.
//
// A stray rotation.json.<pid>.<hex>.tmp (0600, holds the new key) is what a death before the journal's rename leaves; its `.identity` sidecar lets recovery establish which writer created it.
// Crash-reachable writers (each file is replaced atomically, so a death leaves a prefix of these sequences):
//   fresh init:      key.json -> profile.json(awaiting-grant) -> [approval-pending.json | pending-grant.json | grant.json]
//   install:         grant.json -> profile.json(awaiting-space [+spacePending] | ready)
//   approval:        approval-pending.json (open -> held -> committed) interleaved with the install above
//   rotation:        rotation.json -> key.json -> profile.json(awaiting-grant) -> remove grant.json -> remove rotation.json

const PROFILES = ['absent', 'unreadable', 'awaiting-grant', 'awaiting-space', 'ready'];
const APPROVALS = ['none', 'open', 'held', 'committed', 'unreadable', 'corrupt'];
const LIVE = ['open', 'held', 'committed', 'unreadable'];
const HELD = ['held', 'committed'];

/** [inputs pattern (a value may be a list of alternatives), expected]. `cleanTemp` is expected to equal `rotationTemp` in every row. */
const TABLE = [
  // rotation journal present: finished before anything else, whatever else is on disk
  [{ rotation: true }, { state: 'rotation-interrupted', action: 'finish-rotation' }],
  // a profile.json that exists and cannot be read is its own state, never an absent profile
  [{ profile: 'unreadable' }, { state: 'profile-unreadable', action: 'fix-profile' }],
  // a saved approval whose profile or key is missing is never dropped: refused with advice, files untouched
  [{ profile: 'absent', approval: LIVE }, { state: 'approval-orphaned', action: 'refuse' }],
  [{ key: false, approval: LIVE }, { state: 'approval-orphaned', action: 'refuse' }],
  // no profile: a death between key.json and profile.json leaves a key only
  [{ profile: 'absent', key: false }, { state: 'new', action: 'init' }],
  [{ profile: 'absent', key: true }, { state: 'key-only', action: 'init' }],
  // a profile without its key cannot be resumed
  [{ key: false }, { state: 'key-missing', action: 'rotate-key' }],
  // awaiting-grant: a grant saved and not installed is installed first (`--resume`); a held approval beside it stays on disk
  [{ profile: 'awaiting-grant', pendingGrant: true }, { state: 'saved-delegation', action: 'resume' }],
  [{ profile: 'awaiting-grant', grant: true }, { state: 'saved-grant', action: 'resume' }],
  // awaiting-grant with nothing saved to install: an approval the owner gave is collected by `--wait`
  [{ profile: 'awaiting-grant', approval: HELD }, { state: 'approval-held', action: 'wait' }],
  [{ profile: 'awaiting-grant', approval: 'open' }, { state: 'approval-open', action: 'wait' }],
  [{ profile: 'awaiting-grant', approval: 'unreadable' }, { state: 'approval-unreadable', action: 'fix-approval' }],
  [{ profile: 'awaiting-grant' }, { state: 'awaiting-grant', action: 'request' }],
  // awaiting-space: a saved grant is finished by `--resume` with any approval kept; without a grant a held approval is collected
  [{ profile: 'awaiting-space', grant: false, approval: HELD }, { state: 'approval-held', action: 'wait' }],
  [{ profile: 'awaiting-space', grant: false }, { state: 'grant-missing', action: 'request' }],
  [{ profile: 'awaiting-space', spacePending: true }, { state: 'space-pending', action: 'resume' }],
  [{ profile: 'awaiting-space' }, { state: 'space-missing', action: 'resume' }],
  // ready: a held renewal is collected by `--wait`
  [{ profile: 'ready', approval: HELD }, { state: 'ready-approval', action: 'wait' }],
  // ready
  [{ profile: 'ready', approval: 'unreadable' }, { state: 'approval-unreadable', action: 'fix-approval' }],
  [{ profile: 'ready', grant: false }, { state: 'grant-missing', action: 'request' }],
  [{ profile: 'ready', approval: 'open' }, { state: 'ready-approval', action: 'wait' }],
  [{ profile: 'ready' }, { state: 'ready', action: 'none' }],
];

function* combinations() {
  for (const profile of PROFILES) for (const spacePending of [false, true]) for (const grant of [false, true]) for (const key of [false, true])
    for (const pendingGrant of [false, true]) for (const approval of APPROVALS) for (const rotation of [false, true]) for (const rotationTemp of [false, true]) {
      yield { profile, spacePending, grant, key, pendingGrant, approval, rotation, rotationTemp };
    }
}

const matches = (pattern, inputs) => Object.entries(pattern).every(([name, value]) => (Array.isArray(value) ? value.includes(inputs[name]) : inputs[name] === value));
function expected(inputs) {
  const row = TABLE.find(([pattern]) => matches(pattern, inputs));
  assert.ok(row, `no table row for ${JSON.stringify(inputs)}`);
  return { ...row[1], cleanTemp: inputs.rotationTemp };
}
const outcome = ({ state, action, cleanTemp }) => ({ state, action, cleanTemp });
/** Every combination whose recovery differs from the table, for a classifier. */
const disagreements = (classify) => [...combinations()].filter((inputs) => {
  try { assert.deepEqual(outcome(classify(inputs)), expected(inputs)); return false; } catch { return true; }
});

test('the table covers every combination of the inputs', () => {
  for (const inputs of combinations()) expected(inputs);
});

test('classifyState gives the table recovery for every combination', () => {
  assert.deepEqual(disagreements(classifyState), []);
});

// ---- mutation check: a change to any input or rule must be caught by the table ----

const MUTANTS = {
  'ignores the rotation journal': (i) => classifyState({ ...i, rotation: false }),
  'ignores a stray rotation temp file': (i) => ({ ...classifyState(i), cleanTemp: false }),
  'ignores profile.status': (i) => classifyState({ ...i, profile: i.profile === 'absent' ? 'absent' : 'ready' }),
  'ignores spacePending': (i) => classifyState({ ...i, spacePending: false }),
  'ignores grant.json': (i) => classifyState({ ...i, grant: true }),
  'ignores key.json': (i) => classifyState({ ...i, key: true }),
  'ignores pending-grant.json': (i) => classifyState({ ...i, pendingGrant: false }),
  'ignores approval-pending.json': (i) => classifyState({ ...i, approval: 'none' }),
  'treats a held approval as open': (i) => classifyState({ ...i, approval: i.approval === 'held' ? 'open' : i.approval }),
  'treats a held approval as open while awaiting-space': (i) => classifyState({ ...i, approval: i.approval === 'held' && i.profile === 'awaiting-space' ? 'open' : i.approval }),
  'treats a held approval as open on a ready profile': (i) => classifyState({ ...i, approval: i.approval === 'held' && i.profile === 'ready' ? 'open' : i.approval }),
  'treats a committed approval as none': (i) => classifyState({ ...i, approval: i.approval === 'committed' ? 'none' : i.approval }),
  'lets a held approval outrank a saved delegation': (i) => classifyState(i.approval === 'held' && i.profile === 'awaiting-grant' && i.pendingGrant ? { ...i, pendingGrant: false, grant: false } : i),
  'lets a held approval outrank a saved grant': (i) => classifyState(i.approval === 'held' && i.profile === 'awaiting-grant' && i.grant ? { ...i, pendingGrant: false, grant: false } : i),
  'lets a held approval outrank a saved grant while awaiting-space': (i) => classifyState(i.approval === 'held' && i.profile === 'awaiting-space' && i.grant ? { ...i, grant: false } : i),
  'lets a saved grant outrank a held approval with nothing saved to install': (i) => classifyState(i.approval === 'held' && i.profile === 'awaiting-grant' && !i.grant && !i.pendingGrant ? { ...i, approval: 'none' } : i),
  'lets a missing grant outrank a held approval': (i) => classifyState(i.approval === 'held' && i.profile === 'ready' && !i.grant ? { ...i, approval: 'none' } : i),
  'treats an unreadable approval as none': (i) => classifyState({ ...i, approval: i.approval === 'unreadable' ? 'none' : i.approval }),
  'drops an approval whose key is missing': (i) => classifyState(!i.key && LIVE.includes(i.approval) ? { ...i, approval: 'none' } : i),
  'drops an approval whose profile is missing': (i) => classifyState(i.profile === 'absent' && LIVE.includes(i.approval) ? { ...i, approval: 'none' } : i),
};

for (const [name, mutant] of Object.entries(MUTANTS)) {
  test(`mutation check: a classifier that ${name} is caught by the table`, () => {
    assert.notDeepEqual(disagreements(mutant), []);
  });
}

// ---- `init --wait`: collect a saved approval (go on) or advise another command ----
// An approval the owner gave (a retryable result reference, the saved encrypted result or a commit) is always collected, even beside a
// grant saved and not installed. An OPEN request beside a saved grant makes `--wait` advise `--resume`, except while the space is being set up.

const WAIT_TABLE = [
  [{ rotation: true }, false],
  [{ profile: 'unreadable' }, false],
  [{ profile: 'absent', approval: LIVE }, false],
  [{ key: false, approval: LIVE }, false],
  [{ profile: 'absent' }, true],
  [{ key: false }, false],
  [{ approval: HELD }, true],
  [{ profile: 'awaiting-space', approval: 'open' }, true],
  [{ profile: 'awaiting-grant', pendingGrant: true }, false],
  [{ profile: 'awaiting-grant', grant: true }, false],
  [{ profile: 'awaiting-grant', approval: 'unreadable' }, false],
  [{ profile: 'awaiting-grant' }, true],
  [{ profile: 'awaiting-space' }, false],
  [{ profile: 'ready', approval: 'unreadable' }, false],
  [{ profile: 'ready', approval: 'open' }, true],
  [{ profile: 'ready' }, false],
];
const waitExpected = (inputs) => {
  const row = WAIT_TABLE.find(([pattern]) => matches(pattern, inputs));
  assert.ok(row, `no wait row for ${JSON.stringify(inputs)}`);
  return row[1];
};
const waitDisagreements = (classify) => [...combinations()].filter((inputs) => classify(inputs).wait !== waitExpected(inputs));

test('classifyState says when --wait goes on for every combination', () => {
  assert.deepEqual(waitDisagreements(classifyState), []);
});

const WAIT_MUTANTS = {
  'advises --resume for a held result beside a saved grant': (i) => classifyState(HELD.includes(i.approval) && (i.grant || i.pendingGrant) ? { ...i, approval: 'open' } : i),
  'treats a result reference alone like an open request': (i) => classifyState(i.approval === 'held' ? { ...i, approval: 'open' } : i),
  'advises --resume for an open request while the space is being set up': (i) => classifyState(i.approval === 'open' && i.profile === 'awaiting-space' ? { ...i, approval: 'none' } : i),
  'goes on for an open request beside a saved grant': (i) => ({ ...classifyState(i), wait: i.approval === 'open' && (i.grant || i.pendingGrant) ? true : classifyState(i).wait }),
  'goes on while a rotation is interrupted': (i) => ({ ...classifyState(i), wait: i.rotation ? true : classifyState(i).wait }),
  'goes on for an orphaned approval': (i) => ({ ...classifyState(i), wait: classifyState(i).state === 'approval-orphaned' ? true : classifyState(i).wait }),
};
for (const [name, mutant] of Object.entries(WAIT_MUTANTS)) {
  test(`mutation check: a classifier that ${name} is caught by the wait table`, () => {
    assert.notDeepEqual(waitDisagreements(mutant), []);
  });
}

// ---- deriveState reads the files ----

const home = () => process.env.COURIER_HOME;
const put = (name, value, mode = 0o600) => {
  const file = path.join(home(), name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
  fs.chmodSync(file, mode);
  const temp = /^(?:rotation|key|approval-pending)\.json\.(\d+)\.([0-9a-f]{12})\.tmp$/.exec(name);
  if (temp) writeTempIdentity(file, Number(temp[1]), temp[2]);
};

const APPROVAL = {
  version: 1, request: {}, requestId: 'r', bodyCid: 'b', approvalUrl: 'https://x.test/a', requestExpiresAt: '2999-01-01T00:00:00.000Z',
  record: {}, apiOrigin: 'https://x.test', linkApiOrigin: 'https://x.test', openkeyOrigin: 'https://x.test', relayPrivateKey: 'k', ackId: 'a',
};

function arrange(inputs) {
  fs.rmSync(home(), { recursive: true, force: true });
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.chmodSync(home(), 0o700);
  if (inputs.profile !== 'absent') {
    // `unreadable` is a profile.json that exists and cannot be read (mode 0644 here), whatever status it holds.
    put('profile.json', {
      version: 3, host: 'https://node.test', openkeyHost: 'https://openkey.test', label: 'l', courierDid: 'did:key:z',
      status: inputs.profile === 'unreadable' ? 'ready' : inputs.profile,
      ...(inputs.spacePending ? { spacePending: true } : {}), peers: {},
    }, inputs.profile === 'unreadable' ? 0o644 : 0o600);
  }
  if (inputs.key) put('key.json', { v: 1, jwk: {}, did: 'did:key:z6Mk', createdAt: '2026-01-01T00:00:00.000Z' });
  if (inputs.grant) put('grant.json', { v: 1, delegationHeader: { Authorization: 'a' }, delegationCid: 'c', spaceId: 's', siwe: 'x' });
  if (inputs.pendingGrant) {
    put('pending-grant.json', { v: 1, records: [{ codeHash: 'h', expiresAt: '2999-01-01T00:00:00.000Z', savedAt: 'now', delegation: { delegationCid: 'c' } }] });
  }
  if (inputs.rotationTemp) put(`rotation.json.${DEAD_PID}.0a1b2c3d4e5f.tmp`, { v: 1, key: { v: 1, jwk: {}, did: 'did:key:z6Mn', createdAt: 'now' }, profile: {} });
  if (inputs.rotation) put('rotation.json', { v: 1, key: { v: 1, jwk: {}, did: 'did:key:z6Mn', createdAt: 'now' }, profile: {} });
  switch (inputs.approval) {
    case 'open': put('approval-pending.json', APPROVAL); break;
    case 'held': put('approval-pending.json', { ...APPROVAL, resultRef: 'ref', resultExpiresAt: '2999-01-01T00:00:00.000Z' }); break;
    case 'committed': put('approval-pending.json', { ...APPROVAL, resultEnvelope: {}, committed: true }); break;
    case 'unreadable': put('approval-pending.json', APPROVAL, 0o644); break;
    case 'corrupt': put('approval-pending.json', '{not json'); break;
    default: break;
  }
}

const snapshot = () => Object.fromEntries(fs.readdirSync(home()).sort().map((name) => [name, fs.readFileSync(path.join(home(), name), 'utf8')]));

test('deriveState reads every combination from the files, matches the table, and never changes a file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-state-'));
  const previous = process.env.COURIER_HOME;
  process.env.COURIER_HOME = path.join(root, 'courier');
  try {
    for (const inputs of combinations()) {
      // A profile that is absent has no spacePending, and a ready profile never has one: those are not on-disk states.
      if (inputs.spacePending && inputs.profile !== 'awaiting-space') continue;
      arrange(inputs);
      const before = snapshot();
      const derived = deriveState();
      assert.deepEqual(outcome(derived), expected(inputs), JSON.stringify(inputs));
      assert.deepEqual(derived.inputs, inputs);
      assert.deepEqual(snapshot(), before, `deriveState changed a file for ${JSON.stringify(inputs)}`);
    }
  } finally {
    if (previous === undefined) delete process.env.COURIER_HOME; else process.env.COURIER_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deriveState leaves an expired or corrupt pending-grant.json alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-state-'));
  const previous = process.env.COURIER_HOME;
  process.env.COURIER_HOME = path.join(root, 'courier');
  try {
    for (const content of ['{not json', JSON.stringify({ v: 1, records: [{ codeHash: 'h', expiresAt: '2000-01-01T00:00:00.000Z', savedAt: 'x', delegation: {} }] })]) {
      arrange({ profile: 'awaiting-grant', spacePending: false, grant: false, key: true, pendingGrant: false, approval: 'none', rotation: false, rotationTemp: false });
      put('pending-grant.json', content);
      const derived = deriveState();
      assert.equal(derived.inputs.pendingGrant, false);
      assert.equal(fs.readFileSync(path.join(home(), 'pending-grant.json'), 'utf8'), content);
    }
  } finally {
    if (previous === undefined) delete process.env.COURIER_HOME; else process.env.COURIER_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
