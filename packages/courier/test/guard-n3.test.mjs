import { trustedProgram } from './policy-programs.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/guard/policy.js';
import { decide } from '../dist/guard/hook.js';
const env = { cwd: '/repo', resolveProgram: trustedProgram, readFile: () => ({ state: 'absent' }), git: () => ({ ok: false, out: '' }), getenv: () => undefined };
const hosts = ['127.0.0.1', '127.1', '127.255.4.3', '2130706433', '2130706434', '017700000001', '0x7f000001', '0177.0.0.1', '0.0.0.0', 'localhost', 'localhost.', 'x.localhost', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]'];
test('N3: every loopback address spelling, numeric destination and local daemon port refuses', async () => {
  for (const host of hosts) {
    for (const command of [`curl ${host}:6768`, `wget -qO- http://${host}/`, `curl --resolve public.example:443:${host} https://public.example`]) assert.ok(analyze(command, env).length, command);
    assert.equal((await decide({ tool_name: 'WebFetch', tool_input: { url: `http://${host}:6768` } }, { env, protectedSet: { roots: [], homes: [] } })).kind, 'deny', host);
  }
  for (const command of ['curl public.example:6767', 'curl https://public.example:6768', 'curl -H "Host: localhost" https://public.example', `node -e "require('net').connect(6768,'127.0.0.1')"`, `python3 -c "import urllib.request; urllib.request.urlopen('http://127.1')"`, 'cat /dev/tcp/127.1/80', 'curl http://127.0.0.1.nip.io', 'curl http://0x7f000001.sslip.io']) assert.ok(analyze(command, env).length, command);
  assert.equal(analyze('curl https://github.com/a/b', env).length, 0);
});

test('N3: resolved loopback aliases and DNS lookup failures fail closed in the real hook', async () => {
  for (const resolveHost of [async () => ['127.0.0.2'], async () => ['::ffff:127.0.0.1'], async () => { throw Error('DNS failed'); }]) {
    const deps = { env, protectedSet: { roots: [], homes: [] }, resolveHost };
    for (const input of [{ tool_name: 'WebFetch', tool_input: { url: 'https://alias.example/' } }, { tool_name: 'Bash', tool_input: { command: 'curl https://alias.example/' } }]) assert.equal((await decide(input, deps)).kind, 'deny');
  }
  assert.equal((await decide({ tool_name: 'Bash', tool_input: { command: 'curl https://public.example/' } }, { env, protectedSet: { roots: [], homes: [] }, resolveHost: async () => ['203.0.113.5'] })).kind, 'pass');
});
