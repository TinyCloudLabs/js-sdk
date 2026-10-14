import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { check, failureMessage, gitRepo, unfinishedStableRelease } from "./check-npm-release-provenance.mjs";

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

const BETA = "chore: beta version packages [skip ci]";
const STABLE = "chore: release stable packages [skip ci]";

const manifest = (name, version, extra = {}) =>
  `${JSON.stringify({ name, version, ...extra }, null, 2)}\n`;
const root = `${JSON.stringify({ name: "root", private: true, workspaces: ["packages/*", "apps/*"] }, null, 2)}\n`;
const a = (version, deps = { "@x/b": "2.0.0" }) => ({
  "packages/a/package.json": manifest("@x/a", version, { dependencies: deps }),
});
const b = (version) => ({ "packages/b/package.json": manifest("@x/b", version) });

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
  // The commit that set a@1.0.0 and b@2.0.0.
  const released = commit("initial release", {
    "package.json": root,
    ...a("1.0.0"),
    "packages/a/src/index.js": "export const a = 1;\n",
    ...b("2.0.0"),
    "packages/b/src/index.js": "export const b = 1;\n",
    "apps/demo/package.json": manifest("@x/demo", "0.0.1", { private: true }),
    "fixtures/pkg/package.json": manifest("@x/fixture", "9.9.9"),
  });
  return { dir, git, commit, released, repo: gitRepo(dir) };
}

// `npm view` stand-in: { "name@version": gitHead | null | { gitHead, requires } }
// (null = no gitHead; `requires` = the published [name, range] dependencies).
// Versions not listed are unpublished; a package exists on npm if any of its
// versions is listed.
function registry(entries) {
  const calls = [];
  const view = (name, version) => {
    const id = `${name}@${version}`;
    calls.push(id);
    if (!(id in entries)) return { published: false };
    const value = entries[id];
    if (typeof value === "function") return value();
    if (value && typeof value === "object") return { published: true, requires: [], ...value };
    return { published: true, gitHead: value ?? undefined, requires: [] };
  };
  const packageExists = (name) => Object.keys(entries).some((id) => id.startsWith(`${name}@`));
  return { view, packageExists, calls, entries };
}

const quiet = () => {};
const noSleep = () => {
  throw new Error("only post-publish waits");
};
const run = (r, mode, npm, options = {}) =>
  check({ mode, repo: r.repo, view: npm.view, packageExists: npm.packageExists, sleep: noSleep, log: quiet, ...options });

test("pre-publish: checks every public workspace package, publishes what npm lacks", async (t) => {
  const r = repository(t);
  r.commit(BETA, { ...a("1.0.1-beta.0") });
  const npm = registry({ "@x/b@2.0.0": r.released });
  assert.deepEqual(await run(r, "pre-publish", npm), []);
  // Private workspaces and package.json files outside the workspaces are skipped.
  assert.deepEqual(npm.calls.sort(), ["@x/a@1.0.1-beta.0", "@x/b@2.0.0"]);
});

test("pre-publish: npm's copy from the version commit, or a later commit, passes", async (t) => {
  const r = repository(t);
  const version = r.commit(BETA, a("1.0.1-beta.0"));
  // Code merged without a changeset, and a package.json edit that keeps the
  // version, neither move the version commit nor fail the check.
  const later = r.commit("feat(a): no changeset", { "packages/a/src/index.js": "export const a = 2;\n" });
  r.commit("chore(a): add a script", a("1.0.1-beta.0", { "@x/b": "2.0.0", "left-pad": "^1.0.0" }));
  for (const gitHead of [version, later]) {
    const npm = registry({ "@x/a@1.0.1-beta.0": gitHead, "@x/b@2.0.0": r.released });
    assert.deepEqual(await run(r, "pre-publish", npm), [], gitHead);
  }
});

test("pre-publish: the old workflow's publish from the version commit's parent passes", async (t) => {
  const r = repository(t);
  const trigger = r.commit("fix(a)", { "packages/a/src/index.js": "export const a = 2;\n" });
  r.commit(BETA, a("1.0.1-beta.0"));
  const logs = [];
  const npm = registry({ "@x/a@1.0.1-beta.0": trigger, "@x/b@2.0.0": r.released });
  assert.deepEqual(await run(r, "pre-publish", npm, { log: (line) => logs.push(line) }), []);
  assert.ok(
    logs.includes(`@x/a@1.0.1-beta.0: published by the pre-TC-1095 workflow from its version commit's parent (gitHead ${trigger}).`),
    logs.join("\n"),
  );
});

test("pre-publish: the parent rule applies only to release-workflow version commits", async (t) => {
  const r = repository(t);
  const before = r.commit("fix(a)", { "packages/a/src/index.js": "export const a = 2;\n" });
  r.commit("feat(a): bump the version by hand", a("1.0.1"));
  const npm = registry({ "@x/a@1.0.1": before, "@x/b@2.0.0": r.released });
  const failures = await run(r, "pre-publish", npm);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "published from a commit before its version commit landed");
});

test("pre-publish: the 2026-10-14 scenario fails loudly", async (t) => {
  const r = repository(t);
  // A cancelled run published a@1.0.1-beta.0 from `published`; its version
  // commit never landed. Another PR changed a, and the next version commit
  // computed the same number.
  const published = r.git("rev-parse", "HEAD");
  r.commit("fix(a): later PR", { "packages/a/src/index.js": "export const a = 2;\n" });
  const version = r.commit(BETA, a("1.0.1-beta.0"));
  const npm = registry({ "@x/a@1.0.1-beta.0": published, "@x/b@2.0.0": r.released });
  const failures = await run(r, "pre-publish", npm);
  assert.equal(failures.length, 1);
  assert.deepEqual(
    { ...failures[0] },
    {
      name: "@x/a",
      version: "1.0.1-beta.0",
      dir: "packages/a",
      head: version,
      gitHead: published,
      versionCommit: version,
      reason: "published from a commit before its version commit landed",
    },
  );
  const message = failureMessage(failures, "pre-publish");
  assert.match(message, /@x\/a@1\.0\.1-beta\.0: published from a commit before its version commit landed/);
  assert.match(message, new RegExp(`npm gitHead: +${published}`));
  assert.match(message, new RegExp(`version commit: +${version}`));
  assert.match(message, new RegExp(`HEAD: +${version}`));
  assert.match(message, /Nothing was published\. Add a changeset/);
});

test("pre-publish: a rejected version stays rejected on the next run that bumps nothing", async (t) => {
  const r = repository(t);
  const published = r.git("rev-parse", "HEAD");
  r.commit("fix(a)", { "packages/a/src/index.js": "export const a = 2;\n" });
  r.commit(BETA, a("1.0.1-beta.0"));
  const npm = registry({ "@x/a@1.0.1-beta.0": published, "@x/b@2.0.0": r.released });
  assert.equal((await run(r, "pre-publish", npm)).length, 1);

  // Next push: an unrelated change, no version commit.
  r.commit("docs: readme", { "README.md": "hi\n" });
  const next = registry({ "@x/a@1.0.1-beta.0": published, "@x/b@2.0.0": r.released });
  assert.equal((await run(r, "pre-publish", next)).length, 1);
  assert.equal((await run(r, "post-publish", next)).length, 1);
  assert.ok(next.calls.includes("@x/a@1.0.1-beta.0"));
});

test("pre-publish: an internal dependency change alone is not treated as equivalent", async (t) => {
  const r = repository(t);
  // npm's a@1.0.1-beta.0 was built while a still required b@2.0.0; the
  // version commit requires b@2.0.1-beta.0. a's own files are unchanged.
  r.commit("docs: readme", { "README.md": "hi\n" });
  r.commit(BETA, { ...a("1.0.1-beta.0", { "@x/b": "2.0.1-beta.0" }), ...b("2.0.1-beta.0") });
  const npm = registry({ "@x/a@1.0.1-beta.0": r.released });
  const failures = await run(r, "pre-publish", npm);
  assert.deepEqual(failures.map((failure) => failure.name), ["@x/a"]);
});

test("pre-publish: a change only in bundled sibling source is not treated as equivalent", async (t) => {
  const r = repository(t);
  // a bundles b's source (like operations bundling sdk-core). Only b/src changed.
  const published = r.git("rev-parse", "HEAD");
  r.commit("fix(b): bundled into a", { "packages/b/src/index.js": "export const b = 2;\n" });
  r.commit(BETA, a("1.0.1-beta.0"));
  const npm = registry({ "@x/a@1.0.1-beta.0": published, "@x/b@2.0.0": r.released });
  const failures = await run(r, "pre-publish", npm);
  assert.deepEqual(failures.map((failure) => failure.name), ["@x/a"]);
});

test("pre-publish: a gitHead outside HEAD's history fails", async (t) => {
  const r = repository(t);
  r.git("checkout", "--quiet", "-b", "abandoned");
  const abandoned = r.commit(BETA, { ...a("1.0.1-beta.0"), "packages/a/src/index.js": "export const a = 3;\n" });
  r.git("checkout", "--quiet", "master");
  r.commit(BETA, a("1.0.1-beta.0"));
  for (const gitHead of [abandoned, "0123456789abcdef0123456789abcdef01234567"]) {
    const npm = registry({ "@x/a@1.0.1-beta.0": gitHead, "@x/b@2.0.0": r.released });
    const failures = await run(r, "pre-publish", npm);
    assert.equal(failures.length, 1, gitHead);
    assert.equal(failures[0].reason, "npm's gitHead is not in HEAD's history");
  }
});

test("pre-publish: a published version with no gitHead fails", async (t) => {
  const r = repository(t);
  const npm = registry({ "@x/a@1.0.0": null, "@x/b@2.0.0": r.released });
  const failures = await run(r, "pre-publish", npm);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, "npm records no gitHead for this version");
  assert.match(failureMessage(failures, "pre-publish"), /npm gitHead: +\(none\)/);
});

test("pre-publish: the version commit is found through merge commits on the first-parent line", async (t) => {
  const r = repository(t);
  r.git("checkout", "--quiet", "-b", "feature");
  r.commit("feat(a)", { "packages/a/src/index.js": "export const a = 2;\n" });
  r.git("checkout", "--quiet", "master");
  const version = r.commit(BETA, a("1.0.1-beta.0"));
  r.git("merge", "--quiet", "--no-ff", "--no-edit", "feature");
  const npm = registry({ "@x/a@1.0.1-beta.0": version, "@x/b@2.0.0": r.released });
  assert.deepEqual(await run(r, "pre-publish", npm), []);
});

test("unpublished-stable: a stable release that pushed but did not publish blocks the next beta", async (t) => {
  const r = repository(t);
  // Stable release graduates a to 1.0.1 and re-enters pre mode; npm never got
  // a@1.0.1. An unrelated beta for b is then versioned.
  r.commit(STABLE, a("1.0.1"));
  r.commit("chore: enter beta pre-release mode [skip ci]", { ".changeset/pre.json": "{}\n" });
  r.commit(BETA, b("2.0.1-beta.0"));
  const npm = registry({ "@x/a@1.0.0": r.released, "@x/b@2.0.0": r.released });
  const failures = await run(r, "unpublished-stable", npm);
  assert.deepEqual(
    failures.map(({ name, version, reason }) => ({ name, version, reason })),
    [{ name: "@x/a", version: "1.0.1", reason: "stable version not on npm; in pre mode `changeset publish` would tag it beta" }],
  );
  assert.match(
    failureMessage(failures, "unpublished-stable"),
    /Dispatch the Stable Release: it publishes exactly these versions from their release commit/,
  );
});

test("unpublished-stable: published stable versions and unpublished betas pass", async (t) => {
  const r = repository(t);
  r.commit(BETA, a("1.0.1-beta.0"));
  const npm = registry({ "@x/b@2.0.0": r.released });
  assert.deepEqual(await run(r, "unpublished-stable", npm), []);
});

test("unpublished-stable: a new package npm has never seen is left to beta versioning", async (t) => {
  const r = repository(t);
  // New public package at a stable-shaped version with a pending changeset;
  // `changeset version` will give it 0.1.1-beta.0.
  r.commit("feat: new package", {
    "packages/c/package.json": manifest("@x/c", "0.1.0"),
    ".changeset/new-c.md": '---\n"@x/c": patch\n---\n\nNew.\n',
  });
  const npm = registry({ "@x/a@1.0.0": r.released, "@x/b@2.0.0": r.released });
  assert.deepEqual(await run(r, "unpublished-stable", npm), []);
  assert.ok(npm.calls.includes("@x/c@0.1.0"));
});

// A stable release that adds brand-new c@0.1.1, required exactly by a@1.0.1.
// npm gets a@1.0.1 but never any version of c.
function newPackageInStableRelease(t) {
  const r = repository(t);
  const release = r.commit(STABLE, {
    ...a("1.0.1", { "@x/b": "2.0.0", "@x/c": "0.1.1" }),
    "packages/c/package.json": manifest("@x/c", "0.1.1"),
  });
  r.commit("chore: enter beta pre-release mode [skip ci]", { ".changeset/pre.json": '{ "mode": "pre" }\n' });
  const npm = registry({
    "@x/a@1.0.0": r.released,
    "@x/a@1.0.1": { gitHead: release, requires: [["@x/b", "2.0.0"], ["@x/c", "0.1.1"]] },
    "@x/b@2.0.0": r.released,
  });
  return { r, release, npm };
}

test("unpublished-stable: a never-published package a stable release set still blocks an unrelated beta", async (t) => {
  const { r, release, npm } = newPackageInStableRelease(t);
  r.commit("fix(b)", { ".changeset/fix-b.md": '---\n"@x/b": patch\n---\n\nFix.\n' });
  const failures = await run(r, "unpublished-stable", npm);
  assert.deepEqual(failures.map(({ name, version, versionCommit }) => ({ name, version, versionCommit })), [
    { name: "@x/c", version: "0.1.1", versionCommit: release },
  ]);
});

test("unfinished-stable: a never-published package with a new changeset is finished at its released version", async (t) => {
  const { r, release, npm } = newPackageInStableRelease(t);
  r.commit("fix(c)", { ".changeset/fix-c.md": '---\n"@x/c": patch\n---\n\nFix.\n' });
  const unfinished = unfinishedStableRelease({ repo: r.repo, view: npm.view, packageExists: npm.packageExists });
  assert.equal(unfinished.releaseCommit, release);
  assert.deepEqual(unfinished.missing.map(({ name, version }) => `${name}@${version}`), ["@x/c@0.1.1"]);

  r.git("checkout", "--quiet", "--detach", release);
  const logs = [];
  assert.deepEqual(await run(r, "pre-publish", npm, { log: (line) => logs.push(line) }), []);
  assert.deepEqual(logs.filter((line) => line.includes("will publish")), ["@x/c@0.1.1: not on npm; will publish from HEAD."]);
  const finished = registry({ ...npm.entries, "@x/c@0.1.1": release });
  assert.deepEqual(await run(r, "post-publish", finished), []);
});

test("pre-publish: a version on npm that requires an internal version nobody publishes fails", async (t) => {
  const { r, npm } = newPackageInStableRelease(t);
  // Suppose c had been versioned past 0.1.1 anyway: a@1.0.1 on npm still
  // requires c@0.1.1, which this run does not publish.
  r.commit(BETA, { "packages/c/package.json": manifest("@x/c", "0.1.2-beta.0") });
  const failures = await run(r, "pre-publish", npm);
  assert.deepEqual(failures.map(({ name, version, reason }) => ({ name, version, reason })), [
    { name: "@x/a", version: "1.0.1", reason: "requires @x/c@0.1.1, which is not on npm and not published by this run" },
  ]);
});

test("pre/post-publish: internal dependencies may be in this run's publish set, and must be on npm afterwards", async (t) => {
  const r = repository(t);
  const head = r.commit(BETA, { ...a("1.0.1-beta.0", { "@x/b": "workspace:*" }), ...b("2.0.1-beta.0") });
  const npm = registry({ "@x/a@1.0.0": r.released, "@x/b@2.0.0": r.released });
  assert.deepEqual(await run(r, "pre-publish", npm), []);

  // After publishing, a made it but b did not.
  const partial = registry({
    ...npm.entries,
    "@x/a@1.0.1-beta.0": { gitHead: head, requires: [["@x/b", "2.0.1-beta.0"]] },
  });
  const failures = await run(r, "post-publish", partial, { sleep: async () => {}, waitMs: 1, firstRetryMs: 1 });
  assert.deepEqual(failures.map(({ name, reason }) => `${name}: ${reason}`), [
    "@x/b: not on npm after publish",
    "@x/a: requires @x/b@2.0.1-beta.0, which is not on npm",
  ]);
});

test("unfinished-stable: a partial stable release is finished from its release commit before anything else", async (t) => {
  const r = repository(t);
  // The stable release sets a@1.0.1 (requiring exactly b@2.0.1) and b@2.0.1,
  // pushes, and re-enters pre mode. Only a@1.0.1 reaches npm.
  const release = r.commit(STABLE, { ...a("1.0.1", { "@x/b": "2.0.1" }), ...b("2.0.1") });
  r.commit("chore: enter beta pre-release mode [skip ci]", { ".changeset/pre.json": '{ "mode": "pre" }\n' });
  // A changeset for b merges before anyone notices.
  r.commit("fix(b)", {
    "packages/b/src/index.js": "export const b = 2;\n",
    ".changeset/fix-b.md": '---\n"@x/b": patch\n---\n\nFix.\n',
  });
  const npm = registry({ "@x/a@1.0.0": r.released, "@x/a@1.0.1": release, "@x/b@2.0.0": r.released });

  // The beta run stops before versioning, naming the release commit.
  const blocked = await run(r, "unpublished-stable", npm);
  assert.deepEqual(blocked.map(({ name, version, versionCommit }) => ({ name, version, versionCommit })), [
    { name: "@x/b", version: "2.0.1", versionCommit: release },
  ]);

  // The stable dispatch finds that release commit instead of versioning master.
  const unfinished = unfinishedStableRelease({ repo: r.repo, view: npm.view, packageExists: npm.packageExists });
  assert.equal(unfinished.releaseCommit, release);
  assert.deepEqual(unfinished.problems, []);

  // From the release commit, exactly b@2.0.1 is left to publish.
  r.git("checkout", "--quiet", "--detach", release);
  const logs = [];
  assert.deepEqual(await run(r, "pre-publish", npm, { log: (line) => logs.push(line) }), []);
  assert.deepEqual(logs.filter((line) => line.includes("will publish")), ["@x/b@2.0.1: not on npm; will publish from HEAD."]);

  // After publishing it, the release is complete and betas resume on master.
  const finished = registry({ ...npm.entries, "@x/b@2.0.1": release });
  assert.deepEqual(await run(r, "post-publish", finished), []);
  r.git("checkout", "--quiet", "master");
  assert.deepEqual(await run(r, "unpublished-stable", finished), []);
  assert.equal(unfinishedStableRelease({ repo: r.repo, view: finished.view, packageExists: finished.packageExists }).releaseCommit, undefined);
});

test("unfinished-stable: missing versions without one stable release commit need a maintainer", async (t) => {
  const cases = {
    "bumped by hand": (r) => r.commit("feat(a): bump by hand", a("1.0.1")),
    "two commits": (r) => {
      r.commit(STABLE, a("1.0.1"));
      r.commit(STABLE, b("2.0.1"));
    },
    "pre mode": (r) => r.commit(STABLE, { ...a("1.0.1"), ".changeset/pre.json": '{ "mode": "pre" }\n' }),
  };
  for (const [name, setup] of Object.entries(cases)) {
    const r = repository(t);
    setup(r);
    const npm = registry({ "@x/a@1.0.0": r.released, "@x/b@2.0.0": r.released });
    const { missing, problems, releaseCommit } = unfinishedStableRelease({
      repo: r.repo,
      view: npm.view,
      packageExists: npm.packageExists,
    });
    assert.ok(missing.length > 0, name);
    assert.equal(releaseCommit, undefined, name);
    assert.equal(problems.length, 1, `${name}: ${problems.join("; ")}`);
    assert.match(failureMessage(missing.map((pkg) => ({ ...pkg, reason: "stable version not on npm" })), "unfinished-stable", problems), /A maintainer must check out/);
  }
});

test("unfinished-stable: nothing missing means a normal stable release", async (t) => {
  const r = repository(t);
  const npm = registry({ "@x/a@1.0.0": r.released, "@x/b@2.0.0": r.released });
  const result = unfinishedStableRelease({ repo: r.repo, view: npm.view, packageExists: npm.packageExists });
  assert.deepEqual(result, { missing: [], problems: [] });
});

test("post-publish: versions published from HEAD pass", async (t) => {
  const r = repository(t);
  const head = r.commit(BETA, a("1.0.1-beta.0"));
  const npm = registry({ "@x/a@1.0.1-beta.0": head, "@x/b@2.0.0": r.released });
  assert.deepEqual(await run(r, "post-publish", npm), []);
});

test("post-publish: waits out registry lag with backoff", async (t) => {
  const r = repository(t);
  const head = r.commit(BETA, a("1.0.1-beta.0"));
  let views = 0;
  const npm = registry({
    "@x/a@1.0.1-beta.0": () => (++views < 4 ? { published: false } : { published: true, gitHead: head }),
    "@x/b@2.0.0": r.released,
  });
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  assert.deepEqual(await run(r, "post-publish", npm, { sleep, waitMs: 1000, firstRetryMs: 5, maxRetryMs: 15 }), []);
  assert.deepEqual(waits, [5, 10, 15]);
});

test("post-publish: a version that never appears fails once the shared budget is spent", async (t) => {
  const r = repository(t);
  const head = r.commit(BETA, { ...a("1.0.1-beta.0"), ...b("2.0.1-beta.0") });
  const npm = registry({ "@x/a@1.0.0": r.released, "@x/b@2.0.0": r.released });
  const waits = [];
  const sleep = async (ms) => waits.push(ms);
  const failures = await run(r, "post-publish", npm, { sleep, waitMs: 40, firstRetryMs: 10, maxRetryMs: 20 });
  // One budget for the run: a uses all 40 (10 + 20 + 10), so b gets a single look and no further wait.
  assert.deepEqual(waits, [10, 20, 10]);
  assert.equal(npm.calls.filter((id) => id === "@x/b@2.0.1-beta.0").length, 1);
  assert.deepEqual(failures.map(({ name, reason }) => `${name}: ${reason}`), [
    "@x/a: not on npm after publish",
    "@x/b: not on npm after publish",
  ]);
  assert.equal(failures[0].head, head);
});

test("cli: rejects an unknown mode or extra arguments", () => {
  for (const args of [[], ["publish"], ["pre-publish", "HEAD"], ["unfinished-stable", "out", "extra"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: check-npm-release-provenance\.mjs unpublished-stable\|unfinished-stable\|pre-publish\|post-publish/);
  }
});
