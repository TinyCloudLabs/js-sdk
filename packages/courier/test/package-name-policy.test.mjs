import { trustedProgram } from './policy-programs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyze } from '../dist/guard/policy.js';
import { decide } from '../dist/guard/hook.js';

export async function packageDecisions() {
  const rows = [];
  for (const name of ['@tinycloud/courier', 'courier', '@tinycloud/other']) {
    const env = {
      cwd: '/repo', resolveProgram: trustedProgram, getenv: () => undefined, git: () => ({ ok: false, out: '' }),
      readFile: file => file === '/repo/package.json' ? {state:'text',text:JSON.stringify({name,version:'1.2.3',scripts:{'deploy:prod':'wrangler deploy --name demo',release:'npm publish',lint:'echo lint'}})} : {state:'absent'},
    };
    for (const command of ['npm publish', 'bun publish', 'npm run deploy:prod', 'npm run release', 'npm run lint', `npx ${name} pause 01M5C9EDF03QMRZS2DJXGN5A4C`, `bunx ${name} deploy`, `npm exec --package ${name} -- courier resume 01M5C9EDF03QMRZS2DJXGN5A4C`]) {
      rows.push({name,command,findings:analyze(command,env),decision:await decide({tool_name:'Bash',tool_input:{command}},{env,protectedSet:{files:[],dirs:[],literals:[]}})});
    }
  }
  return rows;
}

test('registered package publish/deploy/script decisions remain stable; package launchers refuse', async () => {
  const baseline = JSON.parse(fs.readFileSync(new URL('./vectors/package-name-policy.json', import.meta.url)));
  assert.deepEqual(await packageDecisions(),baseline);
});
