import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { changelogSection, publishedFromLog, publishReleases } from "./github-releases.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "github-releases.mjs");
const fixtures = [];

after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

// A package at packages/<dir> with a changesets-style CHANGELOG.md.
function fixtureRoot(packages) {
  const root = mkdtempSync(join(tmpdir(), "o25-releases-"));
  fixtures.push(root);
  for (const { dir, name, changelog } of packages) {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
    writeFileSync(join(root, "packages", dir, "CHANGELOG.md"), changelog);
  }
  return root;
}

const CLI_CHANGELOG = `# @tinycloud/cli

## 1.5.0-beta.6

### Patch Changes

- Fixes a thing

## 1.5.0-beta.5

- Older
`;

describe("publishedFromLog", () => {
  test("lists the versions under the published header, skipping timestamps, colour codes and the butterfly prefix", () => {
    const log = [
      "2026-10-27T12:00:00.1234567Z \u001b[32m\u{1F98B}  success packages published successfully:\u001b[39m",
      "2026-10-27T12:00:01.0000000Z @tinycloud/cli@1.5.0-beta.6",
      "2026-10-27T12:00:01.0000000Z courier@0.2.0",
      "New tag: @tinycloud/cli@1.5.0-beta.6",
    ].join("\n");
    assert.deepEqual(publishedFromLog(log), [
      { name: "@tinycloud/cli", version: "1.5.0-beta.6" },
      { name: "courier", version: "0.2.0" },
    ]);
  });

  test("ignores the untagged-packages listing that follows the published list", () => {
    const log = [
      "packages published successfully:",
      "@tinycloud/cli@1.5.0",
      "found untagged projects:",
      "@tinycloud/private@9.9.9",
    ].join("\n");
    assert.deepEqual(publishedFromLog(log), [{ name: "@tinycloud/cli", version: "1.5.0" }]);
  });

  test("returns nothing when the run published no versions", () => {
    assert.deepEqual(publishedFromLog("Creating git tags...\nNo unpublished packages to publish\n"), []);
  });
});

describe("changelogSection", () => {
  test("returns the body of the exact version, without its heading", () => {
    assert.equal(changelogSection(CLI_CHANGELOG, "1.5.0-beta.6"), "### Patch Changes\n\n- Fixes a thing");
  });

  test("does not match a version that only shares a prefix", () => {
    assert.equal(changelogSection("## 1.5.0-beta.6\n\n- x\n", "1.5.0"), null);
  });

  test("returns null for an absent or empty section", () => {
    assert.equal(changelogSection(CLI_CHANGELOG, "9.9.9"), null);
    assert.equal(changelogSection("## 2.0.0\n\n## 1.0.0\n\n- y\n", "2.0.0"), null);
  });
});

describe("publishReleases", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  // Stub gh: `views` maps a tag to the view result; creates are recorded.
  function stubGh(views, createResult = { status: 0, stdout: "", stderr: "" }) {
    const calls = [];
    const gh = (args, input) => {
      calls.push({ args, input });
      if (args[0] === "release" && args[1] === "view") {
        return views[args[2]] ?? { status: 1, stdout: "", stderr: "release not found" };
      }
      return createResult;
    };
    return { gh, calls };
  }

  test("skips a version whose release already exists and creates nothing for it", () => {
    const root = fixtureRoot([{ dir: "cli", name: "@tinycloud/cli", changelog: CLI_CHANGELOG }]);
    const { gh, calls } = stubGh({ "@tinycloud/cli@1.5.0-beta.6": { status: 0, stdout: "{}", stderr: "" } });
    const results = publishReleases({
      published: [{ name: "@tinycloud/cli", version: "1.5.0-beta.6" }],
      sha,
      root,
      gh,
    });
    assert.deepEqual(results.map((r) => r.action), ["skipped"]);
    assert.equal(calls.some((c) => c.args[1] === "create"), false);
  });

  test("does not create a second release for web-sdk stable, but does for its betas", () => {
    const root = fixtureRoot([
      { dir: "web", name: "@tinycloud/web-sdk", changelog: "## 3.3.0\n\n- Stable\n\n## 3.3.0-beta.7\n\n- Beta\n" },
    ]);
    const { gh, calls } = stubGh({});
    const results = publishReleases({
      published: [
        { name: "@tinycloud/web-sdk", version: "3.3.0" },
        { name: "@tinycloud/web-sdk", version: "3.3.0-beta.7" },
      ],
      sha,
      root,
      gh,
    });
    assert.deepEqual(results.map((r) => r.action), ["skipped", "created"]);
    assert.equal(calls.some((c) => c.args[2] === "@tinycloud/web-sdk@3.3.0"), false);
    assert.equal(calls.find((c) => c.args[1] === "create").args[2], "@tinycloud/web-sdk@3.3.0-beta.7");
  });

  test("creates a stable release at the release sha with the version's notes on stdin", () => {
    const root = fixtureRoot([{ dir: "cli", name: "@tinycloud/cli", changelog: CLI_CHANGELOG }]);
    const { gh, calls } = stubGh({});
    const results = publishReleases({ published: [{ name: "@tinycloud/cli", version: "1.5.0" }], sha, root, gh });
    assert.deepEqual(results.map((r) => r.action), ["created"]);
    const create = calls.find((c) => c.args[1] === "create");
    assert.deepEqual(create.args, [
      "release", "create", "@tinycloud/cli@1.5.0",
      "--title", "@tinycloud/cli@1.5.0",
      "--notes-file", "-",
      "--target", sha,
    ]);
    assert.equal(create.input, "No CHANGELOG.md section for 1.5.0 in " + join(root, "packages", "cli", "CHANGELOG.md") + ".\n");
  });

  test("marks a prerelease as prerelease and not latest, with that version's notes", () => {
    const root = fixtureRoot([{ dir: "cli", name: "@tinycloud/cli", changelog: CLI_CHANGELOG }]);
    const { gh, calls } = stubGh({});
    publishReleases({ published: [{ name: "@tinycloud/cli", version: "1.5.0-beta.6" }], sha, root, gh });
    const create = calls.find((c) => c.args[1] === "create");
    assert.ok(create.args.includes("--prerelease"));
    assert.ok(create.args.includes("--latest=false"));
    assert.equal(create.input, "### Patch Changes\n\n- Fixes a thing\n");
  });

  test("reports a failed view without attempting a create, and keeps going for the next version", () => {
    const root = fixtureRoot([
      { dir: "cli", name: "@tinycloud/cli", changelog: CLI_CHANGELOG },
      { dir: "other", name: "courier", changelog: "## 0.2.0\n\n- Notes\n" },
    ]);
    const calls = [];
    const gh = (args, input) => {
      calls.push({ args, input });
      if (args[2] === "@tinycloud/cli@1.5.0") return { status: 1, stdout: "", stderr: "HTTP 503" };
      if (args[1] === "view") return { status: 1, stdout: "", stderr: "release not found" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const results = publishReleases({
      published: [
        { name: "@tinycloud/cli", version: "1.5.0" },
        { name: "courier", version: "0.2.0" },
      ],
      sha,
      root,
      gh,
    });
    assert.equal(results[0].action, "failed");
    assert.match(results[0].detail, /HTTP 503/);
    assert.equal(results[1].action, "created");
    assert.equal(calls.filter((c) => c.args[1] === "create").length, 1);
  });

  test("reports a failed create with gh's error", () => {
    const root = fixtureRoot([{ dir: "cli", name: "@tinycloud/cli", changelog: CLI_CHANGELOG }]);
    const { gh } = stubGh({}, { status: 1, stdout: "", stderr: "HTTP 422: tag already exists" });
    const [result] = publishReleases({ published: [{ name: "@tinycloud/cli", version: "1.5.0" }], sha, root, gh });
    assert.equal(result.action, "failed");
    assert.match(result.detail, /HTTP 422/);
  });

  test("dry run calls gh only to view, and describes the create it would make", () => {
    const root = fixtureRoot([{ dir: "cli", name: "@tinycloud/cli", changelog: CLI_CHANGELOG }]);
    const { gh, calls } = stubGh({});
    const [result] = publishReleases({
      published: [{ name: "@tinycloud/cli", version: "1.5.0-beta.6" }],
      sha,
      root,
      gh,
      dryRun: true,
    });
    assert.equal(calls.some((c) => c.args[1] === "create"), false);
    assert.equal(result.action, "created");
    assert.match(result.detail, /^gh release create @tinycloud\/cli@1\.5\.0-beta\.6 /);
    assert.equal(result.notes, "### Patch Changes\n\n- Fixes a thing");
  });
});

describe("github-releases.mjs create (CLI, dry run)", () => {
  // A stub gh on PATH that reports no release exists, so no real gh or network is used.
  function isolatedEnv(root) {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'release not found' >&2\nexit 1\n");
    chmodSync(join(bin, "gh"), 0o755);
    return { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, GH_TOKEN: "", GH_REPO: "" };
  }

  test("prints the planned release for each published version and exits 0", () => {
    const root = fixtureRoot([{ dir: "cli", name: "@tinycloud/cli", changelog: CLI_CHANGELOG }]);
    const log = root + "/publish.log";
    writeFileSync(log, "packages published successfully:\n@tinycloud/cli@1.5.0-beta.6\n");
    const run = spawnSync(process.execPath, [SCRIPT, "create", log, "abc123", "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      env: isolatedEnv(root),
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Would create GitHub release @tinycloud\/cli@1\.5\.0-beta\.6: gh release create @tinycloud\/cli@1\.5\.0-beta\.6 --title/);
    assert.match(run.stdout, /- Fixes a thing/);
  });

  test("with no publish log it reports nothing to release and exits 0", () => {
    const root = fixtureRoot([]);
    const run = spawnSync(process.execPath, [SCRIPT, "create", join(root, "missing.log"), "abc123", "--dry-run"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /nothing to release/);
  });

  test("count prints how many versions the publish log lists, and 0 with no log", () => {
    const root = fixtureRoot([]);
    const log = root + "/publish.log";
    writeFileSync(log, "packages published successfully:\n@tinycloud/cli@1.5.0-beta.6\n@tinycloud/web-sdk@3.3.0-beta.7\n");
    const counted = spawnSync(process.execPath, [SCRIPT, "count", log], { cwd: root, encoding: "utf8", env: isolatedEnv(root) });
    assert.equal(counted.status, 0, counted.stderr);
    assert.equal(counted.stdout.trim(), "2");
    const missing = spawnSync(process.execPath, [SCRIPT, "count", join(root, "missing.log")], { cwd: root, encoding: "utf8", env: isolatedEnv(root) });
    assert.equal(missing.stdout.trim(), "0");
  });
});
