import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-file-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

import { MODEL_LOGIN_FILES, homeFileRefusal, prepareCleanHome } from '../dist/guard/cleanhome.js';
import { agentHome } from '../dist/guard/install.js';
import { createWaker } from '../dist/wake.js';
import { wakeConfig } from '../dist/watch-cmd.js';
import { parseArgs } from '../dist/args.js';

const SUPPORTED = ['codex', 'omp', 'opencode', 'gemini', 'cursor-agent', 'amp', 'aider', 'goose'];
const WITH_FILE = SUPPORTED.filter((cli) => MODEL_LOGIN_FILES[cli].length > 0);
const watch = (exec, ...argv) => wakeConfig(parseArgs(['watch', '--exec', exec, '--unguarded', '--agent-cli', ...argv]), 'sam');

test('every supported agent CLI has an entry, and no listed login file is one the deny rules cover', () => {
  assert.deepEqual(Object.keys(MODEL_LOGIN_FILES).sort(), [...SUPPORTED].sort());
  for (const cli of SUPPORTED) {
    for (const file of MODEL_LOGIN_FILES[cli]) assert.equal(homeFileRefusal(file, { adapter: 'exec', agentCli: cli }), undefined, `${cli} ${file}`);
  }
});

test('--home-file accepts the known login file of the agent CLI the command starts', () => {
  for (const cli of WITH_FILE) {
    for (const file of MODEL_LOGIN_FILES[cli]) assert.deepEqual(watch(`${cli} run hi`, '--home-file', file).homeFiles, [file], `${cli} ${file}`);
  }
});

test("another CLI's login file is refused for this CLI, with the CLI named", () => {
  for (const cli of WITH_FILE) {
    for (const other of WITH_FILE.filter((name) => name !== cli)) {
      for (const file of MODEL_LOGIN_FILES[other]) {
        assert.throws(() => watch(`${cli} run hi`, '--home-file', file), new RegExp(`--home-file .* is not a model-login file of ${cli}`), `${cli} ${file}`);
      }
    }
  }
});

test('omp and cursor-agent cannot take a login through --home-file: every file is refused and the message says why', () => {
  for (const file of ['.omp/agent/agent.db', '.omp/agent/config.yml', '.cursor/cli-config.json', '.config/cursor/auth.json', '.codex/auth.json']) {
    assert.throws(() => watch('omp -p hi', '--home-file', file), /--home-file/, `omp ${file}`);
    assert.throws(() => watch('cursor-agent -p hi', '--home-file', file), /--home-file/, `cursor-agent ${file}`);
  }
  assert.throws(() => watch('cursor-agent -p hi', '--home-file', '.cursor/cli-config.json'), /cursor-agent cannot take a login through --home-file .*--env-pass/);
  assert.throws(() => watch('omp -p hi', '--home-file', '.config/cursor/auth.json'), /omp cannot take a login through --home-file/);
});

test('settings, owner tool state and every other file are refused for every command, naming the denied roots', () => {
  const refused = [
    '.codex/config.toml', '.gemini/settings.json', '.config/goose/config.yaml', '.aider.conf.yml', '.local/share/opencode/opencode.db',
    '.omp/agent/agent.db', '.omp/agent/auth.json', '.tinycloud/profiles/default.json', '.gnupg/private-keys-v1.d/key.key', '.docker/config.json',
    '.kube/config', '.config/gcloud/credentials.db', '.paseo/state.json', 'Documents/notes.txt',
  ];
  for (const exec of ['codex exec hi', 'omp -p hi', 'agent.sh']) {
    for (const file of refused) assert.throws(() => watch(exec, '--home-file', file), /--home-file/, `${exec} ${file}`);
  }
  for (const file of ['.omp/agent/agent.db', '.tinycloud/x', '.gnupg/x', '.docker/config.json', '.kube/config', '.config/gcloud/x', '.paseo/x']) {
    assert.match(homeFileRefusal(file, { adapter: 'exec', agentCli: 'codex' }), /owner tool state or a credential store \(\.omp, \.tinycloud, \.gnupg, \.docker, \.kube, \.config\/gcloud, \.paseo\)/, file);
  }
});

test('a command that starts no known agent CLI may name any supported CLI login file, and nothing else', () => {
  for (const cli of WITH_FILE) assert.doesNotThrow(() => watch('agent.sh', '--home-file', MODEL_LOGIN_FILES[cli][0]), cli);
  assert.throws(() => watch('agent.sh', '--home-file', '.codex/config.toml'), /not a model-login file of a supported agent CLI/);
});

test('--wake claude takes no --home-file: its login is copied automatically', () => {
  assert.throws(
    () => wakeConfig(parseArgs(['watch', '--wake', 'claude', '--home-file', '.codex/auth.json']), 'sam'),
    /not needed with --wake claude/,
  );
});

function ownerHome(name) {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  return home;
}
const everyFile = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
const clean = (name) => path.join(root, `${name}-agent-home`);
const prepare = (realHome, name, files, agentCli = 'codex') => prepareCleanHome({ realHome, cleanHome: clean(name), files, claude: false, agentCli });
const SECRET = 'owner-secret-value';

test('a regular login file is copied owner-only (control for the link tests)', () => {
  const home = ownerHome('control');
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"login":"x"}');
  prepare(home, 'control', ['.codex/auth.json']);
  const copied = path.join(clean('control'), '.codex', 'auth.json');
  assert.equal(fs.readFileSync(copied, 'utf8'), '{"login":"x"}');
  assert.equal(fs.statSync(copied).mode & 0o777, 0o600);
});

test('a symbolic link at the file is refused and its target is never copied, even when the link points at a denied file', () => {
  const home = ownerHome('link-file');
  fs.mkdirSync(path.join(home, '.codex'));
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), SECRET);
  fs.symlinkSync(path.join(home, '.ssh', 'id_ed25519'), path.join(home, '.codex', 'auth.json'));
  assert.throws(() => prepare(home, 'link-file', ['.codex/auth.json']), /symbolic link or sits behind one/);
  for (const file of everyFile(clean('link-file'))) assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), `${file} holds the linked file`);
  assert.equal(fs.existsSync(path.join(clean('link-file'), '.codex', 'auth.json')), false);
});

test('a link in a directory above the file is refused too (a dotfile link into denied owner state)', () => {
  const home = ownerHome('link-dir');
  fs.mkdirSync(path.join(home, '.omp', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(home, '.omp', 'agent', 'auth.json'), SECRET);
  fs.symlinkSync(path.join(home, '.omp', 'agent'), path.join(home, '.codex'));
  assert.throws(() => prepare(home, 'link-dir', ['.codex/auth.json']), /symbolic link or sits behind one/);
  for (const file of everyFile(clean('link-dir'))) assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), file);
});

test('a link to the real file under another name inside HOME is refused as well', () => {
  const home = ownerHome('link-alias');
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, 'dotfiles-auth.json'), '{"login":"x"}');
  fs.symlinkSync(path.join(home, 'dotfiles-auth.json'), path.join(home, '.codex', 'auth.json'));
  assert.throws(() => prepare(home, 'link-alias', ['.codex/auth.json']), /symbolic link or sits behind one/);
});

test('the check runs on every wake: a login replaced by a link after start-up is refused at the next wake and nothing runs', async () => {
  const home = ownerHome('link-later');
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"login":"x"}');
  fs.writeFileSync(path.join(home, 'stolen.json'), SECRET);
  let ran = 0;
  const waker = createWaker({
    adapter: 'exec', cwd: root, owner: 'sam', home: path.join(root, 'courier-later'), realHome: home, exec: 'codex exec hi',
    unguarded: true, agentCli: true, homeFiles: ['.codex/auth.json'], timeoutMs: 1000,
    paseo: { bin: 'paseo', provider: 'claude' }, claude: { bin: 'claude', settings: '/x', allow: [] },
  }, {
    sessions: { get: () => undefined, set() {} }, env: { PATH: '/bin' }, notice() {},
    run: async () => { ran++; return { code: 0, stdout: '', stderr: '' }; },
  });
  const request = { peer: 'hunter', threadId: '01M5C9EDF03QMRZS2DJXGN5A4C', subject: 's', messages: [{ messageId: '01M5C9EDF0417FAM64RPKT5WP5', intent: 'request', sentAt: '' }] };
  await waker(request);
  assert.equal(ran, 1);
  fs.rmSync(path.join(home, '.codex', 'auth.json'));
  fs.symlinkSync(path.join(home, 'stolen.json'), path.join(home, '.codex', 'auth.json'));
  await assert.rejects(waker(request), /symbolic link or sits behind one/);
  assert.equal(ran, 1, 'the second wake never started the agent');
  const held = agentHome(path.join(root, 'courier-later'));
  for (const file of everyFile(held)) assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), `${file} holds the linked file`);
});
