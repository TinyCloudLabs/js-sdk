import { test } from 'node:test';
import { concurrentRevokes } from './support/concurrent-revoke.mjs';

test('two concurrent revokes of the same peer both succeed and leave one peer removal', t => concurrentRevokes(t, true));
