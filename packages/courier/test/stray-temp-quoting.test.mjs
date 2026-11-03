import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homeFile, scenario } from './support/approval-fixture.mjs';

// TC-2383: the `rm` command in the recovery line is meant to be pasted into a shell, so a path with an apostrophe (or other shell
// characters) is quoted so that it removes exactly that file.

const LIVE = 4_999_996;

scenario('the rm command for a kept temp file quotes a path with an apostrophe and removes exactly that file when run', async (ctx) => {
  const realKill = process.kill;
  ctx.t.mock.method(process, 'kill', (pid, signal) => (signal === 0 && pid === LIVE ? true : realKill.call(process, pid, signal)));
  const quoted = path.join(path.dirname(path.dirname(process.env.COURIER_HOME)), "it's a $HOME `dir`", 'courier');
  const before = process.env.COURIER_HOME;
  fs.mkdirSync(quoted, { recursive: true, mode: 0o700 });
  process.env.COURIER_HOME = quoted;
  ctx.t.after(() => { process.env.COURIER_HOME = before; });
  await ctx.request();
  const name = `key.json.${LIVE}.0a1b2c3d4e5f.tmp`;
  fs.writeFileSync(homeFile(name), '{"v":1}\n', { mode: 0o600 });
  const bystander = homeFile('key.json');
  ctx.errors.length = 0;
  const run = await ctx.courier('--request');
  assert.equal(run.code, 0, run.stderr);
  const command = /with `(rm -- .+?)`\.\s/s.exec(run.stderr)?.[1];
  assert.ok(command, run.stderr);
  const ran = spawnSync('sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(fs.existsSync(homeFile(name)), false, 'the temp file is removed by the printed command');
  assert.equal(fs.existsSync(bystander), true, 'nothing else is');
});
