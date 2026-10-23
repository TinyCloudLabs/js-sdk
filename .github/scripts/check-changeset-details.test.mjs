import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-changeset-details.mjs", import.meta.url));
const env = {
  ...process.env,
  GITHUB_ACTIONS: "",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const changeset = (...body) => `---\n"@x/a": minor\n---\n\n${body.join("\n")}\n`;

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), "changeset-details-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
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
  const check = (...args) =>
    spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: "utf8" });
  return { git, commit, check };
}

// A base commit that already holds changesets and release files without a ticket line.
function prRepository(t) {
  const repo = repository(t);
  const base = repo.commit("base", {
    ".changeset/README.md": "# Changesets\n",
    ".changeset/config.json": "{}\n",
    ".changeset/pre.json": '{"mode":"pre"}\n',
    ".changeset/old.md": changeset("Old change with no ticket."),
  });
  repo.git("checkout", "--quiet", "-b", "feature");
  return { ...repo, base };
}

test("a new changeset with a ticket line passes", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("feat", {
    ".changeset/new.md": changeset("Add a thing.", "", "Details: TC-848"),
  });
  const result = repo.check(repo.base, head);
  assert.equal(result.status, 0, result.stderr);
});

test("several tickets on one line pass", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("feat", {
    ".changeset/new.md": changeset("Add a thing.", "", "Details: TC-1, TC-2"),
  });
  assert.equal(repo.check(repo.base, head).status, 0);
});

test("a new changeset without a ticket line fails and names the file", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("feat", { ".changeset/new.md": changeset("Add a thing.") });
  const result = repo.check(repo.base, head);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.changeset\/new\.md needs a `Details: TC-N` line/);
});

test("a malformed ticket line fails", (t) => {
  for (const line of ["Details: TC-", "Details: ABC-12", "details: TC-12", "  Details: TC-12", "See Details: TC-12"]) {
    const repo = prRepository(t);
    const head = repo.commit("feat", { ".changeset/new.md": changeset("Add a thing.", "", line) });
    assert.equal(repo.check(repo.base, head).status, 1, line);
  }
});

test("modifying an existing changeset without a ticket line fails", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("edit", { ".changeset/old.md": changeset("Old change, reworded.") });
  const result = repo.check(repo.base, head);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.changeset\/old\.md needs a `Details: TC-N` line/);
});

test("changesets the PR does not touch are not read", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("unrelated", { "packages/a/src/index.ts": "export {};\n" });
  assert.equal(repo.check(repo.base, head).status, 0);
});

test("README.md, config.json and pre.json are exempt", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("housekeeping", {
    ".changeset/README.md": "# Changesets\n\nEdited.\n",
    ".changeset/config.json": '{"access":"public"}\n',
    ".changeset/pre.json": '{"mode":"pre","changesets":["new"]}\n',
  });
  assert.equal(repo.check(repo.base, head).status, 0);
});

test("a generated dependabot changeset without a ticket line is exempt", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("deps", {
    ".changeset/dependabot-npm-and-yarn-vite-5-4-9.md": changeset("Bump vite from 5.4.8 to 5.4.9"),
  });
  const result = repo.check(repo.base, head);
  assert.equal(result.status, 0, result.stderr);
});

test("only the generated dependabot file name is exempt", (t) => {
  for (const name of ["dependabot.md", "dependabot-.md", "my-dependabot-bump.md", "dependabot-a_b.md", `dependabot-${"a".repeat(51)}.md`]) {
    const repo = prRepository(t);
    const head = repo.commit("feat", { [`.changeset/${name}`]: changeset("Add a thing.") });
    const result = repo.check(repo.base, head);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /needs a `Details: TC-N` line/, name);
  }
});

test("every offending file is reported", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("feat", {
    ".changeset/one.md": changeset("One."),
    ".changeset/two.md": changeset("Two.", "", "Details: TC-2"),
    ".changeset/three.md": changeset("Three."),
  });
  const result = repo.check(repo.base, head);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.changeset\/one\.md needs/);
  assert.match(result.stderr, /\.changeset\/three\.md needs/);
  assert.doesNotMatch(result.stderr, /two\.md/);
});

test("only the PR's own changes count when the base has moved on", (t) => {
  const repo = prRepository(t);
  const head = repo.commit("feat", {
    ".changeset/new.md": changeset("Add a thing.", "", "Details: TC-848"),
  });
  repo.git("checkout", "--quiet", repo.base);
  const moved = repo.commit("master moves on", { ".changeset/other.md": changeset("No ticket.") });
  const result = repo.check(moved, head);
  assert.equal(result.status, 0, result.stderr);
});

test("missing arguments are a usage error", (t) => {
  const repo = prRepository(t);
  assert.equal(repo.check().status, 2);
});
