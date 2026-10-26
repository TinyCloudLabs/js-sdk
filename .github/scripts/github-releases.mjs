#!/usr/bin/env node
// GitHub Releases for the package versions a Release run published (O25).
//
// `changeset publish` creates a local git tag `<name>@<version>` for each
// package it publishes. The Release workflow pushes only master, so those tags
// never reach GitHub. This script creates one GitHub Release per published
// version: tag `<name>@<version>` created at the release commit (`--target`),
// title = the tag, notes = that version's section of the package CHANGELOG.md.
// A version that already has a release is skipped. A prerelease (version with
// `-`) is marked `--prerelease` and not `Latest`.
//
// Failures never fail the publish: each one is printed as a workflow error
// annotation and the exit status stays 0. npm publishing has already happened
// when this runs.
//
//   node .github/scripts/github-releases.mjs create <publish-log> <sha> [--dry-run]
//   node .github/scripts/github-releases.mjs notes <name@version>

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ANSI = /\x1b\[[0-9;]*m/g;
const TIMESTAMP = /^\S+Z\s+/;
const BUTTERFLY = /^\u{1F98B}\s+/u;
const PUBLISHED_HEADER = /packages published successfully/i;
const PACKAGE_VERSION = /^(@?[^\s@]+)@(\d\S*)$/;

// Versions `changeset publish` reports as published by this run: the lines
// under "packages published successfully:". Other listings (for example
// untagged private packages) and the "New tag:" lines are not npm publishes.
export function publishedFromLog(log) {
  const published = [];
  let listing = false;
  for (const raw of log.split("\n")) {
    const line = raw.replace(ANSI, "").replace(TIMESTAMP, "").replace(BUTTERFLY, "").trim();
    if (PUBLISHED_HEADER.test(line)) {
      listing = true;
      continue;
    }
    const match = listing ? PACKAGE_VERSION.exec(line) : null;
    if (match) published.push({ name: match[1], version: match[2] });
    else listing = false;
  }
  return published;
}

export const releaseTag = (name, version) => `${name}@${version}`;

export const isPrerelease = (version) => version.includes("-");

// The body of `## <version>` in a changesets CHANGELOG.md: the lines up to the
// next `## ` heading, without the heading. Matches the whole version, so
// `1.5.0` never matches `## 1.5.0-beta.6`. Returns null if there is no section
// or the section is empty.
export function changelogSection(markdown, version) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end += 1;
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body === "" ? null : body;
}

// The directory of the public workspace package called `name`, relative to
// `root`. Same package scan as the Release workflow.
export function packageDir(name, root) {
  const files = execFileSync(
    "find",
    ["packages", "-name", "package.json", "-not", "-path", "*/node_modules/*"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  for (const file of files) {
    const pkg = JSON.parse(readFileSync(join(root, file), "utf8"));
    if (pkg.name === name) return dirname(join(root, file));
  }
  return null;
}

// Release notes for one published version. Missing notes do not stop the
// release; the body says so and `found` is false.
export function releaseNotes({ name, version, root }) {
  const dir = packageDir(name, root);
  const changelog = dir ? join(dir, "CHANGELOG.md") : null;
  const section =
    changelog && existsSync(changelog) ? changelogSection(readFileSync(changelog, "utf8"), version) : null;
  if (section !== null) return { body: section, found: true };
  const where = changelog ?? `a package named ${name}`;
  return { body: `No CHANGELOG.md section for ${version} in ${where}.`, found: false };
}

// `gh` run without a shell. Returns { status, stdout, stderr }.
export function runGh(args, input) {
  const result = spawnSync("gh", args, { encoding: "utf8", input, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// web-sdk stable versions already get a v<version> release from the stable
// job's "Create GitHub Release" step, so no second release is created here.
const WEB_SDK = "@tinycloud/web-sdk";

// Creates a release for each published version that has none. Returns one
// result per version: { tag, action: "created" | "skipped" | "failed", detail }.
export function publishReleases({ published, sha, root = process.cwd(), gh = runGh, dryRun = false }) {
  const results = [];
  for (const { name, version } of published) {
    const tag = releaseTag(name, version);
    if (name === WEB_SDK && !isPrerelease(version)) {
      results.push({ tag, action: "skipped", detail: "covered by the v<version> release from the stable job" });
      continue;
    }
    try {
      const view = gh(["release", "view", tag, "--json", "tagName"], undefined);
      if (view.status === 0) {
        results.push({ tag, action: "skipped", detail: "release already exists" });
        continue;
      }
      if (!/release not found/i.test(view.stderr)) {
        throw new Error(`gh release view failed: ${view.stderr.trim()}`);
      }
      const { body, found } = releaseNotes({ name, version, root });
      const prerelease = isPrerelease(version);
      const args = ["release", "create", tag, "--title", tag, "--notes-file", "-", "--target", sha];
      if (prerelease) args.push("--prerelease", "--latest=false");
      if (dryRun) {
        results.push({ tag, action: "created", detail: `gh ${args.join(" ")}`, notes: body, notesFound: found });
        continue;
      }
      const create = gh(args, `${body}\n`);
      if (create.status !== 0) throw new Error(`gh release create failed: ${create.stderr.trim()}`);
      results.push({ tag, action: "created", detail: `at ${sha}${prerelease ? " (prerelease)" : ""}`, notesFound: found });
    } catch (error) {
      results.push({ tag, action: "failed", detail: error.message });
    }
  }
  return results;
}

function annotate(level, title, message) {
  console.log(`::${level} title=${title}::${message.replace(/\r?\n/g, " ")}`);
}

function parseTag(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) throw new Error(`expected <name>@<version>, got "${spec}"`);
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

async function main([mode, ...args]) {
  const root = process.cwd();
  if (mode === "notes" && args.length === 1) {
    const { name, version } = parseTag(args[0]);
    const { body, found } = releaseNotes({ name, version, root });
    if (!found) console.error(body);
    console.log(body);
    return;
  }
  if (mode === "count" && args.length === 1) {
    const [logPath] = args;
    const published = existsSync(logPath) ? publishedFromLog(readFileSync(logPath, "utf8")) : [];
    console.log(published.length);
    return;
  }
  if (mode === "create" && (args.length === 2 || args.length === 3)) {
    const [logPath, sha, flag] = args;
    const dryRun = flag === "--dry-run";
    if (flag !== undefined && !dryRun) throw new Error(`unknown argument ${flag}`);
    if (!existsSync(logPath)) {
      console.log(`No publish log at ${logPath}; nothing to release.`);
      return;
    }
    const published = publishedFromLog(readFileSync(logPath, "utf8"));
    if (published.length === 0) {
      console.log("This run published no package versions; nothing to release.");
      return;
    }
    for (const result of publishReleases({ published, sha, root, dryRun })) {
      if (result.action === "failed") {
        annotate("error", `GitHub release not created: ${result.tag}`, result.detail);
        continue;
      }
      const verb = result.action === "skipped" ? "Skipped" : dryRun ? "Would create" : "Created";
      console.log(`${verb} GitHub release ${result.tag}: ${result.detail}`);
      if (dryRun) console.log(`${result.notes}\n`);
      if (result.notesFound === false) annotate("warning", `No release notes: ${result.tag}`, "CHANGELOG.md has no section for this version.");
    }
    return;
  }
  throw new Error("usage: github-releases.mjs create <publish-log> <sha> [--dry-run] | notes <name@version> | count <publish-log>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // The publish has already happened: report, never fail the job.
    annotate("error", "GitHub releases step", error.message);
  }
}
