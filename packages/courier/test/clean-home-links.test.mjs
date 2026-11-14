import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clean-home-links-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

import { prepareAgentProfile, prepareCleanHome } from '../dist/guard/cleanhome.js';
import { agentHome } from '../dist/guard/install.js';
import { createWaker } from '../dist/wake.js';

const VICTIM = 'victim-content-must-survive';

/** An owner HOME with a Claude login, a Codex login and a git identity. */
function ownerHome(name) {
  const home = path.join(root, `${name}-owner`);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"login":"claude"}');
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"login":"codex"}');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Sam\n\temail = sam@example.com\n');
  return home;
}

/** A directory outside the clean HOME with files the agent's links would aim at. */
function elsewhere(name, files) {
  const dir = path.join(root, `${name}-elsewhere`);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => {
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    return [path.relative(dir, file), fs.readFileSync(file, 'utf8')];
  }));
const isRealDir = (target) => fs.lstatSync(target).isDirectory();
const isRealFile = (target) => fs.lstatSync(target).isFile();

test('--wake claude: a link planted for .claude or .config is removed, the login is copied into a real directory, and the targets are left alone', () => {
  const owner = ownerHome('claude-dirs');
  const clean = path.join(root, 'claude-dirs-clean');
  const away = elsewhere('claude-dirs', { 'claude/.credentials.json': VICTIM, 'claude/keep.txt': VICTIM, 'config/gh/hosts.yml': VICTIM, 'config/fish/config.fish': VICTIM });
  const before = snapshot(away);
  fs.mkdirSync(clean, { recursive: true });
  fs.symlinkSync(path.join(away, 'claude'), path.join(clean, '.claude'));
  fs.symlinkSync(path.join(away, 'config'), path.join(clean, '.config'));

  const result = prepareCleanHome({ realHome: owner, cleanHome: clean });

  assert.deepEqual(snapshot(away), before, 'nothing outside the clean HOME was written or removed');
  assert.deepEqual([...result.removedLinks].sort(), ['.claude', '.config']);
  for (const dir of ['.claude', '.config']) assert.ok(isRealDir(path.join(clean, dir)), `${dir} is a real directory again`);
  assert.equal(fs.readFileSync(path.join(clean, '.claude', '.credentials.json'), 'utf8'), '{"login":"claude"}');
  assert.deepEqual(result.exposed.sort(), ['.claude/.credentials.json', '.gitconfig (user.name, user.email)']);
});

test('--exec with --home-file: a link planted for the directory the login is copied into is removed, and the target is left alone', () => {
  const owner = ownerHome('exec-dirs');
  const clean = path.join(root, 'exec-dirs-clean');
  const away = elsewhere('exec-dirs', { 'codex/auth.json': VICTIM, 'codex/keep.txt': VICTIM });
  const before = snapshot(away);
  fs.mkdirSync(clean, { recursive: true });
  fs.symlinkSync(path.join(away, 'codex'), path.join(clean, '.codex'));

  const result = prepareCleanHome({ realHome: owner, cleanHome: clean, claude: false, files: ['.codex/auth.json'] });

  assert.deepEqual(snapshot(away), before);
  assert.deepEqual(result.removedLinks, ['.codex']);
  assert.ok(isRealDir(path.join(clean, '.codex')));
  assert.equal(fs.readFileSync(path.join(clean, '.codex', 'auth.json'), 'utf8'), '{"login":"codex"}');
});

test('a link at a file Courier writes (.gitconfig, the Claude login, a --home-file) is replaced by a regular file; the file it pointed at is untouched', () => {
  const owner = ownerHome('files');
  const away = elsewhere('files', { 'gitconfig': VICTIM, 'login': VICTIM, 'codex-auth': VICTIM });
  const before = snapshot(away);

  const claudeClean = path.join(root, 'files-claude-clean');
  fs.mkdirSync(path.join(claudeClean, '.claude'), { recursive: true });
  fs.symlinkSync(path.join(away, 'gitconfig'), path.join(claudeClean, '.gitconfig'));
  fs.symlinkSync(path.join(away, 'login'), path.join(claudeClean, '.claude', '.credentials.json'));
  prepareCleanHome({ realHome: owner, cleanHome: claudeClean });
  for (const file of ['.gitconfig', '.claude/.credentials.json']) assert.ok(isRealFile(path.join(claudeClean, file)), `${file} is a regular file`);
  assert.match(fs.readFileSync(path.join(claudeClean, '.gitconfig'), 'utf8'), /sam@example\.com/);
  assert.equal(fs.readFileSync(path.join(claudeClean, '.claude', '.credentials.json'), 'utf8'), '{"login":"claude"}');

  const execClean = path.join(root, 'files-exec-clean');
  fs.mkdirSync(path.join(execClean, '.codex'), { recursive: true });
  fs.symlinkSync(path.join(away, 'codex-auth'), path.join(execClean, '.codex', 'auth.json'));
  prepareCleanHome({ realHome: owner, cleanHome: execClean, claude: false, files: ['.codex/auth.json'] });
  assert.ok(isRealFile(path.join(execClean, '.codex', 'auth.json')));
  assert.equal(fs.readFileSync(path.join(execClean, '.codex', 'auth.json'), 'utf8'), '{"login":"codex"}');

  assert.deepEqual(snapshot(away), before);
});

test('a link at a path Courier only removes (a scrubbed directory, a shell start-up file) is removed as a link, never followed', () => {
  const owner = ownerHome('scrub');
  const clean = path.join(root, 'scrub-clean');
  const away = elsewhere('scrub', { 'ssh/id_ed25519': VICTIM, 'bashrc': VICTIM, 'cfg/fish/config.fish': VICTIM, 'cfg/gh/hosts.yml': VICTIM });
  const before = snapshot(away);
  fs.mkdirSync(path.join(clean, '.config'), { recursive: true });
  fs.symlinkSync(path.join(away, 'ssh'), path.join(clean, '.ssh'));
  fs.symlinkSync(path.join(away, 'bashrc'), path.join(clean, '.bashrc'));
  fs.symlinkSync(path.join(away, 'cfg', 'fish'), path.join(clean, '.config', 'fish'));
  fs.symlinkSync(path.join(away, 'cfg', 'gh'), path.join(clean, '.config', 'gh'));

  const result = prepareCleanHome({ realHome: owner, cleanHome: clean });

  assert.deepEqual(snapshot(away), before);
  assert.deepEqual([...result.removedLinks].sort(), ['.bashrc', '.config/fish', '.config/gh', '.ssh']);
  for (const gone of ['.ssh', '.bashrc', '.config/fish', '.config/gh']) assert.equal(fs.existsSync(path.join(clean, gone)), false, `${gone} is gone`);
});

test('a clean HOME that is itself a link is refused, and nothing is written through it', () => {
  const owner = ownerHome('root');
  const away = elsewhere('root', { 'keep.txt': VICTIM });
  const before = snapshot(away);
  const clean = path.join(root, 'root-clean');
  fs.symlinkSync(away, clean);
  assert.throws(() => prepareCleanHome({ realHome: owner, cleanHome: clean }), /clean HOME .* is a symbolic link/);
  assert.deepEqual(snapshot(away), before);
});

test('a plain clean HOME reports no removed links', () => {
  const result = prepareCleanHome({ realHome: ownerHome('plain'), cleanHome: path.join(root, 'plain-clean') });
  assert.deepEqual(result.removedLinks, []);
});

test('the agent identity files are written without following a link planted at .courier, .courier-agent.json, tmp or no-owner-profile', () => {
  const courierHome = path.join(root, 'profile-courier');
  fs.mkdirSync(courierHome, { recursive: true });
  fs.writeFileSync(path.join(courierHome, 'profile.json'), '{"id":"p"}');
  const home = agentHome(courierHome);
  const away = elsewhere('profile', { 'courier/profile.json': VICTIM, 'marker.json': VICTIM, 'tmp/keep.txt': VICTIM, 'noowner/keep.txt': VICTIM });
  const before = snapshot(away);
  fs.mkdirSync(home, { recursive: true });
  fs.symlinkSync(path.join(away, 'courier'), path.join(home, '.courier'));
  fs.symlinkSync(path.join(away, 'marker.json'), path.join(home, '.courier-agent.json'));
  fs.symlinkSync(path.join(away, 'tmp'), path.join(home, 'tmp'));
  fs.symlinkSync(path.join(away, 'noowner'), path.join(home, 'no-owner-profile'));

  const removed = prepareAgentProfile(courierHome);

  assert.deepEqual(snapshot(away), before);
  assert.deepEqual([...removed].sort(), ['.courier', '.courier-agent.json', 'no-owner-profile', 'tmp']);
  assert.equal(fs.readFileSync(path.join(home, '.courier', 'profile.json'), 'utf8'), '{"id":"p"}');
  assert.ok(isRealFile(path.join(home, '.courier-agent.json')));
});

test('a wake says which planted links it removed, and the agent still runs from a real clean HOME', async () => {
  const owner = ownerHome('wake');
  const courierHome = path.join(root, 'wake-courier');
  const away = elsewhere('wake', { 'claude/.credentials.json': VICTIM });
  const before = snapshot(away);
  fs.mkdirSync(agentHome(courierHome), { recursive: true });
  fs.symlinkSync(path.join(away, 'claude'), path.join(agentHome(courierHome), '.claude'));
  const notices = [];
  let ran = 0;
  const waker = createWaker({
    adapter: 'exec', cwd: root, owner: 'sam', home: courierHome, realHome: owner, exec: 'echo hi', unguarded: true, timeoutMs: 1000,
    paseo: { bin: 'paseo', provider: 'claude' }, claude: { bin: 'claude', settings: '/x', allow: [] },
  }, {
    sessions: { get: () => undefined, set() {} }, env: { PATH: '/bin' }, notice: (line) => notices.push(line),
    run: async () => { ran++; return { code: 0, stdout: '', stderr: '' }; },
  });
  await waker({ peer: 'hunter', threadId: '01M5C9EDF03QMRZS2DJXGN5A4C', subject: 's', messages: [{ messageId: '01M5C9EDF0417FAM64RPKT5WP5', intent: 'request', sentAt: '' }] });
  assert.equal(ran, 1);
  assert.ok(notices.some((line) => /removed a symbolic link the agent left in its clean HOME: \.claude/.test(line)), notices.join('\n'));
  assert.deepEqual(snapshot(away), before);
  assert.ok(isRealDir(path.join(agentHome(courierHome), '.claude')));
});
