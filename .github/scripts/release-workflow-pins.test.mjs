import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/changesets.yml', import.meta.url), 'utf8');
const publishJob = (id) => {
  const body = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|(?![\\s\\S]))`, 'm').exec(workflow)?.[1];
  assert.ok(body, `missing ${id} job`);
  return body;
};

test('cancelled-release provenance labels identify the reviewed action pins', () => {
  const pins = [...publishJob('release').matchAll(/^      - name: (Run [^\n]+)\n        uses: (\S+) # ([^\n]+)$/gm)]
    .map(([, label, action, version]) => [label, action, version]);
  assert.deepEqual(pins, [
    ['Run actions/checkout@v4', 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'v4.4.0'],
    ['Run oven-sh/setup-bun@v1', 'oven-sh/setup-bun@f4d14e03ff726c06358e5557344e1da148b56cf7', 'v1.2.2'],
    ['Run dtolnay/rust-toolchain@stable', 'dtolnay/rust-toolchain@df2a88e9fe4098bad09cb42c3dec7187f15861fc', 'master, 2026-11-15'],
  ]);
});

test('both publish jobs opt in to verifying the active Rust version before wasm-pack', () => {
  for (const job of ['release', 'release-resume']) {
    assert.match(publishJob(job), /^      - name: Install wasm-pack\n        uses: \.\/\.github\/actions\/install-wasm-pack\n        with:\n          rust-version: '1\.100\.0'$/m, job);
  }
});
