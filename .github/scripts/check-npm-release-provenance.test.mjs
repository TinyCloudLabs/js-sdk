import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { check, failureMessage, gitRepo } from "./check-npm-release-provenance.mjs";

// Real git in a temporary repository; npm is always the injected `view`.
const script = fileURLToPath(new URL("./check-npm-release-provenance.mjs", import.meta.url));
const env = {
  ...process.env,
  GITHUB_ACTIONS: "",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const manifest = (name, version, extra = {}) =>
  `${JSON.stringify({ name, version, ...extra }, null, 2)}\n`;
const root = `${JSON.stringify({ name: "root", private: true, workspaces: ["packages/a", "packages/b", "apps/*"] }, null, 2)}\n`;

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), "release-provenance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=master");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  const commit = (message, files = {}) => {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), source);
    }
    git("add", "--all");
    git("commit", "--quiet", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const base = commit("base", {
    "package.json": root,
    "packages/a/package.json": manifest("@x/a", "1.0.0-beta.0", { dependencies: { "@x/b": "2.0.0-beta.0" } }),
    "packages/a/src/index.js": "export const a = 1;\n",
    "packages/a/CHANGELOG.md": "# @x/a\n",
    "packages/b/package.json": manifest("@x/b", "2.0.0-beta.0"),
    "packages/b/src/index.js": "export const b = 1;\n",
    "apps/demo/package.json": manifest("@x/demo", "0.0.1", { private: true }),
    "fixtures/pkg/package.json": manifest("@x/fixture", "9.9.9"),
  });
  return { dir, git, commit, base, repo: gitRepo(dir) };
}

// `npm view` stand-in: { "name@version": gitHead | null } (null = no gitHead).
function registry(entries) {
  const calls = [];
  const view = (name, version) => {
    const id = `${name}@${version}`;
    calls.push(id);
    if (!(id in entries)) return { published: false };
    const value = entries[id];
    return typeof value === "function" ? value() : { published: true, gitHead: value ?? undefined };
  };
  return { view, calls };
}

const quiet = () => {};
const noSleep = () => {
  throw new Error("pre-publish must not wait");
};

// Version commit for @x/a only, with the edits `changeset version` makes.
const bumpA = (version, extra = {}) => ({
  "packages/a/package.json": manifest("@x/a", version, { dependencies: { "@x/b": "2.0.0-beta.0" }, ...extra }),
  "packages/a/CHANGELOG.md": `# @x/a\n\n## ${version}\n`,
});

test("pre-publish: a bumped version npm does not have yet passes", async (t) => {
  const r = repository(t);
  r.commit("version", bumpA("1.0.0-beta.1"));
  const npm = registry({});
  const failures = await check({ mode: "pre-publish", base: r.base, repo: r.repo, view: npm.view, sleep: noSleep, log: quiet });
  assert.deepEqual(failures, []);
  assert.deepEqual(npm.calls, ["@x/a@1.0.0-beta.1"]);
});

test("pre-publish: only packages bumped in this run are checked", async (t) => {
  const r = repository(t);
  // b, the private app and the fixture all exist on npm from unrelated commits.
  r.commit("feat: change b without a changeset", { "packages/b/src/index.js": "export const b = 2;\n" });
  const npm = registry({ "@x/b@2.0.0-beta.0": "f".repeat(40), "@x/fixture@9.9.9": null });
  const failures = await check({ mode: "pre-publish", base: r.base, repo: r.repo, view: npm.view, sleep: noSleep, log: quiet });
  assert.deepEqual(failures, []);
  assert.deepEqual(npm.calls, []);
});

test("pre-publish: the 2026-10-14 scenario fails loudly", async (t) => {
  const r = repository(t);
  // A cancelled run published @x/a@1.0.0-beta.1 from `published`, and its
  // version commit never landed. Another PR then changed a, and this run's
  // version commit computed the same number.
  const published = r.git("rev-parse", "HEAD");
  const trigger = r.commit("fix(a): later PR", { "packages/a/src/index.js": "export const a = 2;\n" });
  const head = r.commit("version", bumpA("1.0.0-beta.1"));
  const npm = registry({ "@x/a@1.0.0-beta.1": published });
  const failures = await check({ mode: "pre-publish", base: trigger, repo: r.repo, view: npm.view, sleep: noSleep, log: quiet });
  assert.equal(failures.length, 1);
  assert.deepEqual(
    { name: failures[0].name, version: failures[0].version, gitHead: failures[0].gitHead, head: failures[0].head },
    { name: "@x/a", version: "1.0.0-beta.1", gitHead: published, head },
  );
  assert.match(failures[0].reason, /packages\/a changed since npm's gitHead: packages\/a\/src\/index\.js/);

  const message = failureMessage(failures, "pre-publish");
  assert.match(message, /@x\/a@1\.0\.0-beta\.1/);
  assert.match(message, new RegExp(`npm gitHead: ${published}`));
  assert.match(message, new RegExp(`HEAD: +${head}`));
  assert.match(message, /Nothing was published/);
});

test("pre-publish: a gitHead that is not an ancestor of HEAD fails", async (t) => {
  const r = repository(t);
  r.git("checkout", "--quiet", "-b", "abandoned");
  const abandoned = r.commit("version on a branch that never landed", bumpA("1.0.0-beta.1"));
  r.git("checkout", "--quiet", "master");
  r.commit("version", bumpA("1.0.0-beta.1"));
  for (const gitHead of [abandoned, "0123456789abcdef0123456789abcdef01234567"]) {
    const npm = registry({ "@x/a@1.0.0-beta.1": gitHead });
    const failures = await check({ mode: "pre-publish", base: r.base, repo: r.repo, view: npm.view, sleep: noSleep, log: quiet });
    assert.equal(failures.length, 1, gitHead);
    assert.equal(failures[0].reason, "npm's gitHead is not an ancestor of HEAD");
  }
});

test("pre-publish: unchanged since an ancestor gitHead allows the skip", async (t) => {
  const r = repository(t);
  // Old ordering: npm's copy came from the trigger commit, built with the
  // bumped versions in an uncommitted tree. Only CHANGELOG.md and version
  // numbers (own and internal dependencies) differ.
  r.commit("unrelated change outside a", { "README.md": "hi\n" });
  const published = r.git("rev-parse", "HEAD");
  r.commit("version", {
    ...bumpA("1.0.0-beta.1", { dependencies: { "@x/b": "2.0.0-beta.1" } }),
    "packages/b/package.json": manifest("@x/b", "2.0.0-beta.1"),
  });
  const logs = [];
  const npm = registry({ "@x/a@1.0.0-beta.1": published });
  const failures = await check({
    mode: "pre-publish",
    base: published,
    repo: r.repo,
    view: npm.view,
    sleep: noSleep,
    log: (line) => logs.push(line),
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(npm.calls.sort(), ["@x/a@1.0.0-beta.1", "@x/b@2.0.0-beta.1"]);
  assert.ok(logs.includes(`@x/a@1.0.0-beta.1: on npm, unchanged since npm's gitHead ${published}.`), logs.join("\n"));
});

test("pre-publish: a package.json change beyond version numbers fails", async (t) => {
  const r = repository(t);
  r.commit("feat(a): new dependency", {
    "packages/a/package.json": manifest("@x/a", "1.0.0-beta.0", {
      dependencies: { "@x/b": "2.0.0-beta.0", "left-pad": "^1.0.0" },
    }),
  });
  r.commit("version", bumpA("1.0.0-beta.1", { dependencies: { "@x/b": "2.0.0-beta.0", "left-pad": "^1.0.0" } }));
  const npm = registry({ "@x/a@1.0.0-beta.1": r.base });
  const failures = await check({ mode: "pre-publish", base: "HEAD^", repo: r.repo, view: npm.view, sleep: noSleep, log: quiet });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "packages/a/package.json changed since npm's gitHead beyond version numbers");
});

test("pre-publish: a published version with no gitHead fails", async (t) => {
  const r = repository(t);
  r.commit("version", bumpA("1.0.0-beta.1"));
  const npm = registry({ "@x/a@1.0.0-beta.1": null });
  const failures = await check({ mode: "pre-publish", base: r.base, repo: r.repo, view: npm.view, sleep: noSleep, log: quiet });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "npm records no gitHead for this version");
  assert.match(failureMessage(failures, "pre-publish"), /npm gitHead: \(none\)/);
});

test("pre-publish: no version change means nothing to check", async (t) => {
  const r = repository(t);
  const npm = registry({});
  const failures = await check({ mode: "pre-publish", base: "HEAD", repo: r.repo, view: npm.view, sleep: noSleep, log: quiet });
  assert.deepEqual(failures, []);
  assert.deepEqual(npm.calls, []);
});

test("post-publish: versions published from HEAD pass", async (t) => {
  const r = repository(t);
  const head = r.commit("version", bumpA("1.0.0-beta.1"));
  const npm = registry({ "@x/a@1.0.0-beta.1": head });
  const failures = await check({ mode: "post-publish", base: r.base, repo: r.repo, view: npm.view, sleep: noSleep, log: quiet });
  assert.deepEqual(failures, []);
});

test("post-publish: waits out registry lag with bounded retries", async (t) => {
  const r = repository(t);
  const head = r.commit("version", bumpA("1.0.0-beta.1"));
  let views = 0;
  const npm = registry({
    "@x/a@1.0.0-beta.1": () => (++views < 3 ? { published: false } : { published: true, gitHead: head }),
  });
  const waits = [];
  const failures = await check({
    mode: "post-publish",
    base: r.base,
    repo: r.repo,
    view: npm.view,
    sleep: async (ms) => waits.push(ms),
    attempts: 4,
    retryMs: 5,
    log: quiet,
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(waits, [5, 5]);
});

test("post-publish: a version that never appears fails after the last attempt", async (t) => {
  const r = repository(t);
  const head = r.commit("version", bumpA("1.0.0-beta.1"));
  const npm = registry({});
  const waits = [];
  const failures = await check({
    mode: "post-publish",
    base: r.base,
    repo: r.repo,
    view: npm.view,
    sleep: async (ms) => waits.push(ms),
    attempts: 3,
    retryMs: 5,
    log: quiet,
  });
  assert.equal(npm.calls.length, 3);
  assert.deepEqual(waits, [5, 5]);
  assert.deepEqual(failures, [
    { name: "@x/a", version: "1.0.0-beta.1", dir: "packages/a", gitHead: undefined, head, reason: "not on npm after publish" },
  ]);
});

test("post-publish: a version npm holds from other code fails", async (t) => {
  const r = repository(t);
  const published = r.git("rev-parse", "HEAD");
  r.commit("fix(a)", { "packages/a/src/index.js": "export const a = 3;\n" });
  r.commit("version", bumpA("1.0.0-beta.1"));
  const npm = registry({ "@x/a@1.0.0-beta.1": published });
  const failures = await check({ mode: "post-publish", base: "HEAD^", repo: r.repo, view: npm.view, sleep: noSleep, log: quiet });
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /changed since npm's gitHead/);
});

test("cli: rejects an unknown mode or missing base", () => {
  for (const args of [[], ["pre-publish"], ["publish", "HEAD"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: check-npm-release-provenance\.mjs/);
  }
});
