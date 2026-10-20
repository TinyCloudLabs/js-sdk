import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/guard/policy.js';
import { decide } from '../dist/guard/hook.js';
const env = { cwd: '/repo', readFile: () => ({ state: 'absent' }), git: () => ({ ok: false, out: '' }), getenv: () => undefined };
for (const [finding, commands] of Object.entries({
  B6: ['gh pr edit 5 -R a/b --base main', 'gh pr review 5 --approve', 'gh repo edit a/b --default-branch x', 'gh workflow enable x -R a/b'],
  B7: ['wrangler versions upload', 'npm deprecate x old', 'npm owner add user x', 'npm access set status=public x', 'npm token create', 'vercel --prod', 'netlify deploy --prod', 'fly deploy', 'docker push x/y'],
  R1: ['cat /home/u/?tinycloud/profiles/default.json', 'node /usr/lib/node_modules/@tinycloud/cli/dist/index.js kv list'],
  R2: ['cat /home/u/?config/gh/host?.yml', 'find /home/u -name "host?.yml" -exec cat {} +', 'cat /proc/1234/env*', 'strings /proc/1234/env?ron', 'cat /home/u/.bashrc', `python3 -c "import os; os.system('sudo -n true')"`],
})) test(finding + ': review regressions refuse', () => {
  for (const command of commands) assert.ok(analyze(command, env).length, command);
});
test('R2: real owner startup files and process environment globs refuse through file tools', async () => {
  for (const file of ['/home/u/.bashrc', '/proc/1234/env*', '/home/u/?config/gh/host?.yml']) for (const tool_name of ['Read', 'Grep', 'Glob']) {
    assert.equal((await decide({ tool_name, tool_input: { path: file }, cwd: '/repo' }, { env, protectedSet: { roots: [], homes: ['/home/u'], realHome: '/home/u' } })).kind, 'deny', tool_name + ' ' + file);
  }
});
