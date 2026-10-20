import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPeers, tierOf, policyOf } from '../dist/julie/peers.js';

function tempPeers(body, mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc712-peers-'));
  const file = path.join(dir, 'peers.json');
  if (body !== undefined) fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), { mode });
  if (body !== undefined) fs.chmodSync(file, mode);
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('absent peers file means every peer is strict with the default caps', () => {
  const t = tempPeers(undefined);
  try {
    const peers = loadPeers(t.file);
    assert.deepEqual(peers, {});
    assert.equal(tierOf(peers, 'hunter'), 'strict');
    assert.deepEqual(policyOf(peers, 'hunter'), { tier: 'strict', ratePerHour: 100, outPerHour: 100 });
  } finally {
    t.cleanup();
  }
});

test('valid entries keep their tier and caps, absent peers stay strict', () => {
  const t = tempPeers({ alice: { tier: 'trusted', ratePerHour: 50, outPerHour: 5 }, bob: { ratePerHour: 3 } });
  try {
    const peers = loadPeers(t.file);
    assert.equal(tierOf(peers, 'alice'), 'trusted');
    assert.deepEqual(policyOf(peers, 'alice'), { tier: 'trusted', ratePerHour: 50, outPerHour: 5 });
    assert.equal(tierOf(peers, 'bob'), 'strict');
    assert.equal(policyOf(peers, 'bob').ratePerHour, 3);
    assert.equal(policyOf(peers, 'bob').outPerHour, 100);
    assert.equal(tierOf(peers, 'carol'), 'strict');
  } finally {
    t.cleanup();
  }
});

test('invalid entries fail closed to strict with defaults and are logged', () => {
  const events = [];
  const t = tempPeers({
    unknownKey: { tier: 'trusted', extra: true },
    badTier: { tier: 'admin' },
    zeroRate: { tier: 'trusted', ratePerHour: 0 },
    floatRate: { tier: 'trusted', outPerHour: 2.5 },
    hugeRate: { tier: 'trusted', ratePerHour: 1e9 },
    raiseInRate: { tier: 'trusted', ratePerHour: 101 },
    raiseOutRate: { tier: 'trusted', outPerHour: 101 },
    notAnObject: 'trusted',
  });
  try {
    const peers = loadPeers(t.file, (event, fields) => events.push({ event, ...fields }));
    const bad = ['unknownKey', 'badTier', 'zeroRate', 'floatRate', 'hugeRate', 'raiseInRate', 'raiseOutRate', 'notAnObject'];
    for (const peerId of bad) {
      assert.deepEqual(policyOf(peers, peerId), { tier: 'strict', ratePerHour: 100, outPerHour: 100 }, peerId);
    }
    assert.equal(events.length, bad.length);
    assert.ok(events.every((e) => e.event === 'peers-invalid-entry' && e.as === 'strict'));
  } finally {
    t.cleanup();
  }
});

test('invalid JSON or a non-object file is refused', () => {
  const broken = tempPeers('{not json');
  try {
    assert.throws(() => loadPeers(broken.file), SyntaxError);
  } finally {
    broken.cleanup();
  }
  const list = tempPeers([{ tier: 'trusted' }]);
  try {
    assert.throws(() => loadPeers(list.file), (error) => error.code === 'bad-peers');
  } finally {
    list.cleanup();
  }
});

test('a group- or other-writable peers file is refused', () => {
  for (const mode of [0o620, 0o602, 0o666]) {
    const t = tempPeers({ alice: { tier: 'trusted' } }, mode);
    try {
      assert.throws(() => loadPeers(t.file), (error) => error.code === 'insecure-peers', mode.toString(8));
    } finally {
      t.cleanup();
    }
  }
});

test('an owner-only peers file is accepted', () => {
  const t = tempPeers({ alice: { tier: 'trusted' } }, 0o600);
  try {
    assert.equal(tierOf(loadPeers(t.file), 'alice'), 'trusted');
  } finally {
    t.cleanup();
  }
});

test('a present peer without ratePerHour gets the 100 inbound default, absent peers get 100 too', () => {
  const t = tempPeers({ dave: { tier: 'trusted' } });
  try {
    const peers = loadPeers(t.file);
    assert.deepEqual(policyOf(peers, 'dave'), { tier: 'trusted', ratePerHour: 100, outPerHour: 100 });
    assert.equal(policyOf(peers, 'erin').ratePerHour, 100);
  } finally {
    t.cleanup();
  }
});
