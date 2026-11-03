import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { homeFile, scenario } from './support/approval-fixture.mjs';
import { removalCommand, writeTempIdentity } from './support/lock-identity.mjs';
// Recovery guidance is asserted as text; this test never executes the command.

const LIVE = 4_999_996;

scenario('the recovery command quotes an unusual path for the current platform', async (ctx) => {
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
  writeTempIdentity(homeFile(name), LIVE, '0a1b2c3d4e5f');
  const bystander = homeFile('key.json');
  ctx.errors.length = 0;
  const run = await ctx.courier('--request');
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.stderr.includes(removalCommand(homeFile(name))), run.stderr);
  assert.equal(fs.existsSync(homeFile(name)), true, 'the formatted guidance is inspected without executing it');
  assert.equal(fs.existsSync(bystander), true, 'the bystander is untouched');
});
