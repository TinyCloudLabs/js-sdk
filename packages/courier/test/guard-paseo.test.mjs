import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installProjectGuard, verifyProjectGuard, projectSettingsFile, paseoEnv, isClaudeProvider } from '../dist/guard/paseo.js';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const guard = { argv: [process.execPath, CLI, 'guard'], entry: CLI };

function scratch(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-paseo-'));
  try { return fn(dir, path.join(dir, 'home')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('the project guard merges into an existing settings.local.json, replaces its own old hook, and is idempotent', () => {
  scratch((cwd, home) => {
    const file = projectSettingsFile(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] }, model: 'x', disableAllHooks: true,
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }, { matcher: '*', hooks: [{ type: 'command', command: "COURIER_HOME='/old' '/old/node' '/old/cli.js' 'guard' || exit 2" }] }] },
    }), { mode: 0o640 });
    installProjectGuard(cwd, home, guard);
    const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(merged.disableAllHooks, false);
    assert.equal(merged.model, 'x');
    assert.deepEqual(merged.permissions.allow, ['Bash(ls:*)']);
    for (const rule of ['Bash(rm:*)', 'Bash(courier pair:*)', 'mcp__paseo', 'mcp__paseo__*']) assert.ok(merged.permissions.deny.includes(rule), rule);
    const commands = merged.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    assert.equal(commands.filter((c) => /'guard' \|\| exit 2$/.test(c)).length, 1, 'one guard hook, the old one is gone');
    assert.ok(commands.includes('echo mine'));
    assert.ok(!commands.some((c) => c.includes('/old/')));
    assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'the file keeps its mode');
    const before = fs.statSync(file).mtimeMs;
    const text = fs.readFileSync(file, 'utf8');
    installProjectGuard(cwd, home, guard);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(fs.statSync(file).mtimeMs, before, 'an unchanged file is not rewritten');
  });
});

test('a settings file it cannot merge safely is refused, not overwritten', () => {
  scratch((cwd, home) => {
    const file = projectSettingsFile(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => installProjectGuard(cwd, home, guard), /cannot merge/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
    fs.writeFileSync(file, '[1]');
    assert.throws(() => installProjectGuard(cwd, home, guard), /not a JSON object/);
  });
});

test('verify runs the installed hook for real and accepts only one that refuses', () => {
  scratch((cwd, home) => {
    const file = installProjectGuard(cwd, home, guard);
    verifyProjectGuard(file, cwd);

    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const write = (mutate) => { const copy = structuredClone(settings); mutate(copy); fs.writeFileSync(file, JSON.stringify(copy)); };
    const fails = (re) => assert.throws(() => verifyProjectGuard(file, cwd), re);

    write((s) => { s.disableAllHooks = true; });
    fails(/do not keep hooks enabled/);
    write((s) => { delete s.disableAllHooks; });
    fails(/do not keep hooks enabled/);
    write((s) => { s.hooks.PreToolUse = []; });
    fails(/no courier guard hook/);
    write((s) => { s.hooks.PreToolUse[0].matcher = 'Bash'; });
    fails(/no courier guard hook/);
    // A hook shaped like the guard that allows everything (prints nothing, exits 0) is caught by the probe.
    write((s) => { s.hooks.PreToolUse[0].hooks[0].command = "COURIER_HOME='x' 'true' 'guard' || exit 2"; });
    fails(/did not refuse a probe/);
    // A hook that cannot start must not count as a refusal either way: `|| exit 2` makes a crash a block, which is the safe side.
    write((s) => { s.hooks.PreToolUse[0].hooks[0].command = "COURIER_HOME='x' '/nonexistent/node' 'guard' || exit 2"; });
    verifyProjectGuard(file, cwd);
    fs.writeFileSync(file, '{ nope');
    fails(/unreadable/);
  });
});

test('paseo env drops the caller\'s agent scope and keeps the rest; only Claude providers are covered', () => {
  const env = paseoEnv({ PATH: '/bin', PASEO_AGENT_ID: 'a', PASEO_AGENT_CWD: '/c', PASEO_WORKSPACE_ID: 'w', PASEO_HOME: '/h' });
  assert.deepEqual(env, { PATH: '/bin', PASEO_HOME: '/h' });
  assert.deepEqual(['claude', 'claude/claude-opus-5-5', 'codex', 'omp/x', 'claude-code', ''].map(isClaudeProvider), [true, true, false, false, false, false]);
});
