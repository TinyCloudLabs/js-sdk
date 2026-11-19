import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Separate watcher processes: shutdown is permanent and must never be reset for a retry.
for (const signal of ['SIGINT', 'SIGTERM']) {
  for (const scenario of ['paseo-send', 'paseo-run', 'claude-retry']) {
    test(`${signal} during exit grace prevents ${scenario} and any later spawn`, { skip: process.platform === 'win32' }, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courier-stop-'));
      const ready = path.join(dir, 'exited');
      const second = path.join(dir, 'second');
      const bin = path.join(dir, 'fake');
      fs.writeFileSync(bin, `#!/bin/sh
case "$1" in
ls|-p)
  if [ "$1" = '-p' ]; then printf '%s\\n' '{"is_error":true,"result":"No conversation found"}';
  else printf '%s\\n' '${scenario === 'paseo-send' ? JSON.stringify([{id:'fake-agent',provider:'claude',cwd:dir}]) : '[]'}'; fi
  sleep 60 &
  touch '${ready}'
  exit 0;;
*) touch '${second}'; sleep 60;;
esac
`, { mode: 0o700 });
      const script = `
        import {createWaker, spawnRunner, killAllRunners} from ${JSON.stringify(new URL('../dist/wake.js', import.meta.url).href)};
        for (const signal of ['SIGINT','SIGTERM']) process.once(signal, killAllRunners);
        const config = {adapter:${JSON.stringify(scenario.startsWith('paseo') ? 'paseo' : 'claude')}, cwd:${JSON.stringify(dir)}, home:${JSON.stringify(path.join(dir, 'courier'))}, owner:'test', timeoutMs:10000,
          paseo:{bin:${JSON.stringify(bin)},provider:'claude'}, claude:{bin:${JSON.stringify(bin)},settings:'fake-settings',allow:[]}};
        const wake = createWaker(config,{run:spawnRunner,prepareGuard(){},env:{PATH:process.env.PATH,HOME:config.home},sessions:{get:()=> 'old-session',set(){}}});
        try {await wake({peer:'test', threadId:'01M5C9EDF03QMRZS2DJXGN5A4C', subject:'test',messages:[]}); process.exitCode=2;}
        catch(e) {if (!/shutting down/.test(e.message)) throw e;}
        const after = await spawnRunner(${JSON.stringify(bin)},['after'],{timeoutMs:10000});
        if (after.code !== null || !/shutting down/.test(after.stderr)) process.exitCode=3;
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', c => { output += c; });
      child.stderr.on('data', c => { output += c; });
      const done = new Promise(resolve => child.on('close', (code, sig) => resolve({ code, sig })));
      try {
        const end = Date.now() + 5000;
        while (!fs.existsSync(ready) && Date.now() < end) await new Promise(r => setTimeout(r, 10));
        assert.ok(fs.existsSync(ready), output || 'fake first command did not exit');
        await new Promise(r => setTimeout(r, 100)); // within the 300ms exit grace; background job holds stdout
        child.kill(signal);
        let timer;
        const result = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('watcher failed to exit')), 2000); })]).finally(() => clearTimeout(timer));
        assert.deepEqual(result, { code: 0, sig: null }, output);
        assert.equal(fs.existsSync(second), false, 'no send, run, retry or direct spawn after shutdown');
      } finally {
        child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
