import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../dist/guard/policy.js';
import { courierOnlyEnv, courierEnvOverrides } from '../dist/guard/install.js';
import { wakeConfig } from '../dist/watch-cmd.js';
import { parseArgs } from '../dist/args.js';
const files = {
  '/repo/package.json': JSON.stringify({ name: '@x/pkg', version: '1.2.3', scripts: { test: 'echo safe', pretest: 'gh pr merge 5 -R a/b', build: 'echo safe', postbuild: 'npm publish', lint: 'echo lint', cycle: 'npm run cycle' } }),
  '/repo/other/package.json': JSON.stringify({ name: '@x/other', version: '1.0.0', scripts: { test: 'gh pr merge 5 -R a/b' } }),
  '/repo/Makefile': 'ship:\n\tgh pr merge 5 -R a/b\n',
};
const env = { cwd: '/repo', readFile: file => files[file] ? { state: 'text', text: files[file] } : { state: 'absent' }, getenv: () => undefined, git: (_, args) => args.join(' ') === 'remote get-url origin' ? { ok: true, out: 'https://github.com/a/b.git' } : { ok: false, out: '' } };
const refused = command => assert.ok(analyze(command, env).length, command);

test('package script bodies include pre/post; selectors and task runners are resolved or refused', () => {
  for (const command of ['npm --prefix other run test', 'npm -w @x/other run deploy', 'bun --filter @x/other run deploy', 'pnpm --filter @x/other run deploy', 'npm run deploy:prod', 'bun run release:npm', 'turbo run deploy', 'make ship', 'npx turbo run deploy', 'npm test', 'npm run build', 'npm install', 'npm version patch', 'bun install', 'npm run missing', 'npm -wother run lint', 'npm run cycle']) refused(command);
  assert.deepEqual(analyze('npm run lint', env), []);
});

test('git command-running config and overrides refuse; injected hooksPath is fixed for all adapters', () => {
  for (const command of ["git -c core.fsmonitor='gh pr merge 5 -R a/b' status", "git -c core.pager=x log", 'git --config-env=core.editor=MY_EDITOR commit', 'git config core.hooksPath /tmp/h', 'git config filter.lfs.clean /tmp/x', 'git config remote.origin.pushurl /tmp/x', 'GIT_CONFIG_COUNT=0 git commit -m x']) refused(command);
  for (const build of [courierOnlyEnv, courierEnvOverrides]) {
    const out = build({ GIT_CONFIG_COUNT: '0', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'evil' }, '/private/courier');
    assert.equal(out.GIT_CONFIG_COUNT, '1'); assert.equal(out.GIT_CONFIG_KEY_0, 'core.hooksPath'); assert.equal(out.GIT_CONFIG_VALUE_0, '/dev/null');
  }
  const configured = { ...env, git: (_, args) => args.includes('--get-regexp') ? { ok: true, out: 'core.fsmonitor evil\n' } : { ok: false, out: '' } };
  assert.ok(analyze('git status', configured).length, 'pre-existing local executable config is refused');
});

test('GitHub writes, tags, registries, deploy tools, nested agents and loopback refuse', () => {
  for (const command of ['gh repo sync a/b --branch main', 'gh run rerun 123 -R a/b', 'gh secret set NPM_TOKEN -R a/b', 'gh api -X POST repos/a/b/releases -f tag_name=v1', 'gh api repos/a/b/actions/workflows/deploy.yml/dispatches -f ref=main', 'gh api repos/a/b/dispatches -f event_type=deploy', 'gh api -X PUT repos/a/b/contents/x.txt -f message=m -f content=eA==', 'git push origin v1.2.3', 'git push --tags', 'git push --follow-tags origin feat/x', 'git push origin feat/x', 'npm unpublish @x/pkg@1.2.3', 'npm dist-tag add @x/pkg@1.2.3 latest', 'npx semantic-release', 'wrangler rollback', 'wrangler delete', 'wrangler secret put X', 'phala cvms upgrade app-1', 'npx @anthropic-ai/claude-code -p hi', 'bunx @openai/codex hi', 'curl https://api.github.com/repos/a/b/releases --data-raw x', 'curl -X POST http://127.0.0.1:1234/x', 'curl http://[::1]:1234/x']) refused(command);
  for (const command of ['gh api repos/a/b/pulls/5', 'gh api repos/a/b/issues/5/comments -f body=hi', 'curl -X POST https://api.github.com/repos/a/b/issues/5/comments -d hi', 'gh release list', 'gh release view v1', 'gh release download v1']) assert.deepEqual(analyze(command, env), [], command);
});

test('--unguarded exec cannot start an agent CLI as its first word', () => {
  for (const command of ['claude -p hi', '/bin/codex exec hi', '"omp" -p hi', 'paseo run']) assert.throws(() => wakeConfig(parseArgs(['--wake', 'exec', '--exec', command, '--unguarded']), 'alice'), /agent CLI/);
});
