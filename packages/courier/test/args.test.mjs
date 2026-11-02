import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from '../dist/args.js';

test('pair renewal flag does not consume task artifact paths', () => {
  const task = parseArgs(['task', 'T1', '--artifact', 'verdict.md']);
  assert.deepEqual(task.positional, ['task', 'T1']);
  assert.equal(task.get('artifact'), 'verdict.md');

  const renewal = parseArgs(['pair', 'renew', 'bob', '--renew-artifact']);
  assert.deepEqual(renewal.positional, ['pair', 'renew', 'bob']);
  assert.equal(renewal.get('renew-artifact'), 'true');
});
