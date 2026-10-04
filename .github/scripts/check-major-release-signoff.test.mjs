import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-major-release-signoff.mjs", import.meta.url));
const env = {
  ...process.env,
  GITHUB_ACTIONS: "",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const changeset = (bumps) =>
  `---\n${Object.entries(bumps)
    .map(([name, bump]) => `"${name}": ${bump}`)
    .join("\n")}\n---\n\nChange.\n`;
const pkg = (name, version, extra = {}) =>
  `${JSON.stringify({ name, version, ...extra }, null, 2)}\n`;
const pre = (initialVersions, changesets = []) =>
  `${JSON.stringify({ mode: "pre", tag: "beta", initialVersions, changesets }, null, 2)}\n`;

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), "major-signoff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  const commit = (message, files = {}, removed = []) => {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), source);
    }
    for (const path of removed) unlinkSync(join(dir, path));
    git("add", "--all");
    git("commit", "--quiet", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const check = (...args) =>
    spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: "utf8" });
  return { git, commit, check };
}

function prRepository(t) {
  const repo = repository(t);
  const base = repo.commit("base", {
    "packages/a/package.json": pkg("@x/a", "1.2.0"),
    "packages/b/package.json": pkg("@x/b", "0.4.0"),
    ".changeset/README.md": "# Changesets\n",
  });
  repo.git("checkout", "--quiet", "-b", "feature");
  return { ...repo, base };
}

test("pr: a major changeset needs a sign-off", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("feat", { ".changeset/big.md": changeset({ "@x/a": "major" }) });
  const result = repo.check("pr", repo.base, head);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No sign-off for a major release: @x\/a/);
  assert.match(result.stderr, /major in \.changeset\/big\.md/);
  assert.match(result.stderr, /git commit --allow-empty -m "approve-major-release: @x\/a"/);
});

test("pr: an empty sign-off commit approves the major", (t) => {
  const repo = prRepository(t);
  repo.commit("feat", { ".changeset/big.md": changeset({ "@x/a": "major" }) });
  const head = repo.commit("approve-major-release: @x/a");
  const result = repo.check("pr", repo.base, head);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /approved by sign-off: @x\/a/);
});

test("pr: a sign-off in a commit that changes files does not count", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("feat\n\napprove-major-release: @x/a", {
    ".changeset/big.md": changeset({ "@x/a": "major" }),
  });
  const result = repo.check("pr", repo.base, head);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No sign-off for a major release: @x\/a/);
});

test("pr: a sign-off only covers the packages it names", (t) => {
  const repo = prRepository(t);
  repo.commit("feat", { ".changeset/big.md": changeset({ "@x/a": "major", "@x/b": "major" }) });
  const head = repo.commit("approve-major-release: @x/a");
  const result = repo.check("pr", repo.base, head);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No sign-off for a major release: @x\/b\n/);
});

test("pr: minor and patch changesets pass", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("feat", {
    ".changeset/small.md": changeset({ "@x/a": "minor", "@x/b": "patch" }),
  });
  const result = repo.check("pr", repo.base, head);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No major version bumps/);
});

test("pr: raising a package's major version needs a sign-off", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("bump", {
    "packages/a/package.json": pkg("@x/a", "2.0.0"),
    "packages/b/package.json": pkg("@x/b", "0.5.0"),
  });
  const result = repo.check("pr", repo.base, head);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@x\/a: packages\/a\/package\.json: 1\.2\.0 -> 2\.0\.0/);
  assert.doesNotMatch(result.stderr, /@x\/b/);
});

test("pr: private packages are not releases", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("bump", {
    "apps/demo/package.json": pkg("demo", "1.0.0", { private: true }),
  });
  repo.commit("bump again", { "apps/demo/package.json": pkg("demo", "2.0.0", { private: true }) });
  assert.equal(repo.check("pr", head, repo.git("rev-parse", "HEAD")).status, 0);
});

test("pr: graduating a new major out of pre mode needs a sign-off", (t) => {
  const repo = repository(t);
  const base = repo.commit("beta", {
    ".changeset/pre.json": pre({ "@x/a": "0.9.0" }),
    "packages/a/package.json": pkg("@x/a", "1.0.0-beta.3"),
  });
  repo.git("checkout", "--quiet", "-b", "release");
  const head = repo.commit(
    "release",
    { "packages/a/package.json": pkg("@x/a", "1.0.0") },
    [".changeset/pre.json"],
  );
  const result = repo.check("pr", base, head);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@x\/a: packages\/a\/package\.json: 0\.9\.0 -> 1\.0\.0/);
});

test("pr: a version PR inherits the sign-off its major changeset was merged with", (t) => {
  const repo = repository(t);
  repo.commit("base", { "packages/a/package.json": pkg("@x/a", "1.2.0") });
  const base = repo.commit("feat (#1)\n\n* feat\n* approve-major-release: @x/a", {
    ".changeset/big.md": changeset({ "@x/a": "major" }),
  });
  repo.git("checkout", "--quiet", "-b", "changeset-release/main");
  const head = repo.commit(
    "Version Packages",
    { "packages/a/package.json": pkg("@x/a", "2.0.0") },
    [".changeset/big.md"],
  );
  const result = repo.check("pr", base, head);
  assert.equal(result.status, 0, result.stderr);
});

test("pr: a version PR for an unapproved major changeset fails", (t) => {
  const repo = repository(t);
  repo.commit("base", { "packages/a/package.json": pkg("@x/a", "1.2.0") });
  const base = repo.commit("feat (#1)", { ".changeset/big.md": changeset({ "@x/a": "major" }) });
  repo.git("checkout", "--quiet", "-b", "changeset-release/main");
  const head = repo.commit(
    "Version Packages",
    { "packages/a/package.json": pkg("@x/a", "2.0.0") },
    [".changeset/big.md"],
  );
  const result = repo.check("pr", base, head);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@x\/a: packages\/a\/package\.json: 1\.2\.0 -> 2\.0\.0/);
});

test("beta: an unadmitted major changeset needs a sign-off in this cycle", (t) => {
  const repo = repository(t);
  repo.commit("approve-major-release: @x/a");
  repo.commit("enter pre", {
    ".changeset/pre.json": pre({ "@x/a": "1.2.0" }, ["old-major"]),
    ".changeset/old-major.md": changeset({ "@x/b": "major" }),
    "packages/a/package.json": pkg("@x/a", "1.2.0"),
  });
  repo.commit("feat", { ".changeset/big.md": changeset({ "@x/a": "major" }) });
  const blocked = repo.check("beta");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /No sign-off for a major release: @x\/a\n/);
  assert.doesNotMatch(blocked.stderr, /@x\/b/);

  repo.commit("Merge sign-off (#2)\n\n* approve-major-release: @x/a");
  const allowed = repo.check("beta");
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("stable: graduating a new major needs a sign-off in this cycle", (t) => {
  const repo = repository(t);
  repo.commit("approve-major-release: @x/a");
  repo.commit("enter pre", {
    ".changeset/pre.json": pre({ "@x/a": "0.9.0", "@x/b": "2.1.0" }),
    "packages/a/package.json": pkg("@x/a", "1.0.0-beta.4"),
    "packages/b/package.json": pkg("@x/b", "2.2.0-beta.1"),
  });
  const blocked = repo.check("stable");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /@x\/a: entered pre mode at 0\.9\.0, graduates to 1\.0\.0/);
  assert.doesNotMatch(blocked.stderr, /@x\/b/);

  repo.commit("approve-major-release: @x/a");
  const allowed = repo.check("stable");
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("stable: nothing to check outside pre mode", (t) => {
  const repo = repository(t);
  repo.commit("base", { "packages/a/package.json": pkg("@x/a", "3.0.0") });
  const result = repo.check("stable");
  assert.equal(result.status, 0, result.stderr);
});
