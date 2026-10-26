// One probe per field the systemd unit writer emits. Every field gets a hostile value (newline, %, $, quote, backslash) and the unit must contain
// exactly the expected line and no extra directive. Path directives refuse control characters and relative paths instead of writing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { systemdUnitFile } from '../dist/service.js';

const BASE = { argv: [process.execPath, '/x/cli.js', 'watch'], cwd: '/srv/work', env: { COURIER_HOME: '/srv/h' }, logFile: '/srv/w.log' };
const INJECT = 'BogusInjected=1';
// A value with a newline followed by a directive, a specifier, a variable, quotes and a backslash.
const HOSTILE = `/srv/p\n${INJECT} #%h $X "q" \\b`;
// The same without the newline, for the path directives (which refuse a newline).
const HOSTILE_PATH = '/srv/p %h $X "q" \\b';

const unit = (over) => systemdUnitFile({ ...BASE, ...over });
const lines = (text) => text.split('\n');
const noInjection = (text) => assert.equal(lines(text).some((line) => line.startsWith('BogusInjected')), false, 'an injected directive appears as its own line');
const usage = (pattern) => (e) => e.code === 'usage' && pattern.test(e.message);

test('ExecStart= arguments: newline, %, $, quote and backslash are escaped inside one quoted word', () => {
  const text = unit({ argv: [...BASE.argv, HOSTILE] });
  noInjection(text);
  const exec = lines(text).filter((line) => line.startsWith('ExecStart='));
  assert.deepEqual(exec, [`ExecStart="${process.execPath}" "/x/cli.js" "watch" "/srv/p\\n${INJECT} #%%h $$X \\"q\\" \\\\b"`]);
});

test('Environment= values (COURIER_PEERS_FILE and any other): same escaping, $ stays literal', () => {
  const text = unit({ env: { COURIER_HOME: HOSTILE, COURIER_PEERS_FILE: HOSTILE, OTHER: HOSTILE } });
  noInjection(text);
  const expected = (name) => `Environment="${name}=/srv/p\\n${INJECT} #%%h $X \\"q\\" \\\\b"`;
  assert.deepEqual(lines(text).filter((line) => line.startsWith('Environment=')), [expected('COURIER_HOME'), expected('COURIER_PEERS_FILE'), expected('OTHER')]);
});

test('Environment= names must be plain variable names', () => {
  for (const key of [`K\n${INJECT}`, 'A=B', '', '1A', 'A B', 'A"']) {
    assert.throws(() => unit({ env: { [key]: 'v' } }), usage(/environment name/), JSON.stringify(key));
  }
});

test('WorkingDirectory=: a path with %, $, quote and backslash is written as is with % doubled; a newline or relative path is refused', () => {
  const text = unit({ cwd: HOSTILE_PATH });
  noInjection(text);
  assert.deepEqual(lines(text).filter((line) => line.startsWith('WorkingDirectory=')), ['WorkingDirectory=/srv/p %%h $X "q" \\b']);
  assert.throws(() => unit({ cwd: HOSTILE }), usage(/WorkingDirectory must not contain control characters/));
  assert.throws(() => unit({ cwd: 'relative/dir' }), usage(/WorkingDirectory must be an absolute path/));
});

test('StandardOutput=: the same path rules', () => {
  const text = unit({ logFile: HOSTILE_PATH });
  noInjection(text);
  assert.deepEqual(lines(text).filter((line) => line.startsWith('StandardOutput=')), ['StandardOutput=append:/srv/p %%h $X "q" \\b']);
  assert.throws(() => unit({ logFile: HOSTILE }), usage(/must not contain control characters/));
  assert.throws(() => unit({ logFile: 'relative.log' }), usage(/must be an absolute path/));
});

test('StandardError=: the same path rules', () => {
  const text = unit({ logFile: HOSTILE_PATH });
  noInjection(text);
  assert.deepEqual(lines(text).filter((line) => line.startsWith('StandardError=')), ['StandardError=append:/srv/p %%h $X "q" \\b']);
});

test('path directives refuse a trailing backslash (it would continue the line) and trailing whitespace', () => {
  for (const tail of ['\\', ' ', '\\\\', '/dir\\']) {
    assert.throws(() => unit({ cwd: `/srv/work${tail}` }), usage(/WorkingDirectory must not end with a backslash or whitespace/), JSON.stringify(tail));
    assert.throws(() => unit({ logFile: `/srv/w.log${tail}` }), usage(/StandardOutput must not end with a backslash or whitespace/), JSON.stringify(tail));
  }
  // A backslash or space inside the path is still written as is.
  assert.deepEqual(lines(unit({ cwd: '/srv/a\\b c/d' })).filter((line) => line.startsWith('WorkingDirectory=')), ['WorkingDirectory=/srv/a\\b c/d']);
});

test('a hostile value in any field never produces a line that is not a known directive', () => {
  const known = /^(\[(Unit|Service|Install)\]|(Description|After|Wants|Type|WorkingDirectory|Environment|ExecStart|KillMode|SendSIGKILL|TimeoutStopSec|Restart|RestartSec|StandardOutput|StandardError|WantedBy)=.*|)$/;
  const text = unit({ argv: [...BASE.argv, HOSTILE], env: { COURIER_PEERS_FILE: HOSTILE, COURIER_HOME: '/srv/h' }, cwd: HOSTILE_PATH, logFile: HOSTILE_PATH });
  for (const line of lines(text)) assert.match(line, known);
});

// systemd-analyze reads the unit offline: it installs, enables and starts nothing. An injected line with an unknown key is reported as a warning.
const analyze = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
test('systemd-analyze --user verify loads the hostile unit without a warning', { skip: analyze.status !== 0 ? 'systemd-analyze is not available' : false }, () => {
  const dir = fs.mkdtempSync(path.join('/var/tmp', 'courier-unit-verify-'));
  try {
    const run = (text) => {
      const file = path.join(dir, 'courier-probe.service');
      fs.writeFileSync(file, text);
      return spawnSync('systemd-analyze', ['--user', 'verify', file], { encoding: 'utf8' });
    };
    const good = run(unit({ argv: [...BASE.argv, HOSTILE], env: { COURIER_PEERS_FILE: HOSTILE, COURIER_HOME: '/srv/h' }, cwd: HOSTILE_PATH, logFile: HOSTILE_PATH }));
    assert.equal(good.stdout + good.stderr, '');
    assert.equal(good.status, 0);
    // Control: the same unit with the newline written raw is flagged, so the check can tell.
    const raw = unit({}).replace('Type=simple', `Type=simple\nExecStartPre=/bin/true\n${INJECT}`);
    assert.match(run(raw).stderr, /Unknown key name 'BogusInjected'/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
