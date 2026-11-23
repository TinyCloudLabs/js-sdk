import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { attemptNeverPublished, releaseScope } from "./check-npm-release-provenance.mjs";

const major = fileURLToPath(new URL("./check-major-release-signoff.mjs", import.meta.url));
const env = { ...process.env, GITHUB_ACTIONS: "", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), "release-cutover-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "commit.gpgsign", "false");
  const commit = (message, files = {}) => {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), source);
    }
    git("add", "--all");
    git("commit", "--quiet", "--allow-empty", "-m", message);
  };
  return { commit, release: () => spawnSync(process.execPath, [major, "release"], { cwd: dir, env, encoding: "utf8" }) };
}

test("release mode: a pending major changeset needs a sign-off after it was added, and only for that package", (t) => {
  const repo = repository(t);
  repo.commit("start", { ".changeset/config.json": "{}\n", ".changeset/patch.md": '---\n"a": patch\n---\n\nFix.\n' });
  assert.equal(repo.release().status, 0);
  repo.commit("big change", { ".changeset/big.md": '---\n"a": major\n---\n\nBreak.\n' });
  const refused = repo.release();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /No sign-off for a major release: a/);
  repo.commit("approve-major-release: b");
  assert.equal(repo.release().status, 1);
  repo.commit("approve-major-release: a");
  assert.equal(repo.release().status, 0);
});

test("scoped provenance judges only listed packages whose version the release commit changed", () => {
  const manifests = { "packages/a/package.json": '{"name":"a","version":"1.0.0"}', "packages/b/package.json": '{"name":"b","version":"2.0.0"}' };
  const repo = { revParse: () => "head", parent: () => "parent", show: (rev, path) => (rev === "parent" ? manifests[path] : undefined) };
  const dir = mkdtempSync(join(tmpdir(), "release-scope-"));
  const scopeFile = join(dir, "scope.json");
  writeFileSync(scopeFile, '{"packages":["a","b","c"]}');
  process.env.RELEASE_SCOPE_FILE = scopeFile;
  try {
    const inScope = releaseScope(repo);
    assert.equal(inScope({ name: "a", dir: "packages/a", version: "1.0.1" }), true, "bumped and listed");
    assert.equal(inScope({ name: "b", dir: "packages/b", version: "2.0.0" }), false, "listed but unchanged: already staged");
    assert.equal(inScope({ name: "d", dir: "packages/d", version: "1.0.0" }), false, "not listed");
  } finally {
    delete process.env.RELEASE_SCOPE_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(releaseScope(repo), undefined);
});

// The Release job of the stable-only workflow, step by step, as GitHub lists them for a cancelled attempt.
const RELEASE_STEPS = [
  "Set up job", "Run actions/checkout@v4", "Run oven-sh/setup-bun@v1", "Run dtolnay/rust-toolchain@stable", "Install wasm-pack",
  "Run bun install --frozen-lockfile", "Check for pending changesets", "Install release deploy key", "Require sign-off for major bumps",
  "List the release scope and pending changesets", "Refuse to run while a release is unfinished", "Version and build", "Verify node release pin",
  "Check internal dependency pins", "Commit release version bumps", "Setup Node for npm publish", "Check npm before publishing",
  "Push release version bumps", "Publish stable to npm", "Record whether this run published versions", "Keep the publish log for github-releases",
  "Confirm npm has every released version", "Remove release deploy key", "Post Setup Node for npm publish", "Post Run oven-sh/setup-bun@v1",
  "Post Run actions/checkout@v4", "Complete job",
];
const NEVER_RAN = ["Push release version bumps", "Publish stable to npm", "Keep the publish log for github-releases", "Confirm npm has every released version"];
const attempt = (started = []) => {
  const step = (name) => {
    const ran = !NEVER_RAN.includes(name) || started.includes(name);
    return { name, status: "completed", conclusion: ran ? "success" : "skipped", started_at: ran ? "2026-11-23T20:00:00Z" : null };
  };
  const jobs = [
    { name: "Release gate", status: "completed", conclusion: "success", steps: [{ name: "Set up job", status: "completed", conclusion: "success" }] },
    { name: "Release", status: "completed", conclusion: "cancelled", steps: RELEASE_STEPS.map(step) },
    { name: "Release resume", status: "completed", conclusion: "skipped", steps: [] },
    { name: "GitHub Releases", status: "completed", conclusion: "skipped", steps: [] },
  ];
  return { total_count: jobs.length, jobs };
};

test("a cancelled stable-only attempt is proven never to have published only while its push and publish steps never ran", () => {
  assert.deepEqual(attemptNeverPublished(attempt()), { ok: true });
  assert.equal(attemptNeverPublished(attempt(["Publish stable to npm"])).ok, false);
  assert.equal(attemptNeverPublished(attempt(["Push release version bumps"])).ok, false);
});
