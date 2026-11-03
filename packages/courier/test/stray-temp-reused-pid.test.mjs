import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { once } from 'node:events';
import { homeFile, scenario } from './support/approval-fixture.mjs';

// TC-2383: a key-bearing temp file whose pid is running is kept. That pid may be a Courier process still writing it, or an unrelated process
// that was given the pid after Courier died. Courier cannot tell which, so it never deletes or zeroes the file, never reuses its name, and
// says so by name in the recovery line. When the process is gone the next init scrubs it.

const HEX = '0b1c2d3e4f5a';
const BODY = '{"v":1,"jwk":{"d":"reused-pid-secret-0123456789abcdef"}}\n';

async function unrelatedProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await once(child, 'spawn');
  return child;
}

for (const file of ['key.json', 'rotation.json', 'approval-pending.json']) {
  scenario(`a ${file} temp file whose pid belongs to an unrelated running process is kept, named, and reported as possibly reused`, async (ctx) => {
    const child = await unrelatedProcess(ctx.t);
    await ctx.request();
    const name = `${file}.${child.pid}.${HEX}.tmp`;
    fs.writeFileSync(homeFile(name), BODY, { mode: 0o600 });
    for (const argv of [['--request'], ['--wait', '--timeout', '1s'], ['--request']]) {
      ctx.errors.length = 0;
      const run = await ctx.courier(...argv);
      assert.equal(fs.readFileSync(homeFile(name), 'utf8'), BODY, `kept, not zeroed, by init ${argv.join(' ')}`);
      assert.equal(fs.statSync(homeFile(name)).mode & 0o777, 0o600);
      assert.ok(run.stderr.includes(name), `the file is named: ${run.stderr}`);
      assert.match(run.stderr, new RegExp(`[Pp]rocess ${child.pid}\\b`));
      assert.match(run.stderr, /kept/);
      assert.match(run.stderr, /reuse/i);
      assert.match(run.stderr, /private-key material/);
      assert.ok(run.stderr.includes(`rm -- '${homeFile(name)}'`), `the exact cleanup command is given: ${run.stderr}`);
      assert.ok(run.stderr.includes(`ps -p ${child.pid}`), 'and how to check the process first');
    }
    child.kill('SIGKILL');
    await once(child, 'exit');
    const run = await ctx.courier('--request');
    assert.equal(run.code, 0, run.stderr);
    assert.equal(fs.existsSync(homeFile(name)), false, 'once the process is gone the temp file is scrubbed');
  });
}

scenario('a kept temp file is never what a later write uses: writes go to a fresh random name and leave it as it is', async (ctx) => {
  const child = await unrelatedProcess(ctx.t);
  await ctx.request();
  const name = `key.json.${child.pid}.${HEX}.tmp`;
  fs.writeFileSync(homeFile(name), BODY, { mode: 0o600 });
  const run = await ctx.courier('--rotate-key', '--request');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(fs.readFileSync(homeFile(name), 'utf8'), BODY);
  assert.deepEqual(fs.readdirSync(process.env.COURIER_HOME).filter((n) => n.endsWith('.tmp')), [name]);
});
