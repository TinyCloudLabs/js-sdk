#!/usr/bin/env node
// Every changeset a pull request adds or modifies must link its ticket with a
// line that starts `Details: TC-<number>` (several tickets are fine:
// `Details: TC-1, TC-2`). The line is carried into the package CHANGELOG.
//
//   check-changeset-details.mjs <base> <head>
//
// Only the files the PR adds or modifies since the merge base are read.
// `.changeset/README.md`, `config.json` and `pre.json` are not changesets.

import { execFileSync } from "node:child_process";

const DETAILS = /^Details: TC-[0-9]+/m;
const EXEMPT = new Set(["README.md", "config.json", "pre.json"]);

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function isChangeset(path) {
  const match = /^\.changeset\/([^/]+\.md)$/.exec(path);
  return match !== null && !EXEMPT.has(match[1]);
}

function missingDetails(base, head) {
  const mergeBase = git("merge-base", base, head).trim();
  const changed = git(
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--diff-filter=AM",
    mergeBase,
    head,
    "--",
    ".changeset",
  )
    .split("\0")
    .filter(Boolean);
  return changed
    .filter(isChangeset)
    .filter((path) => !DETAILS.test(git("show", `${head}:${path}`)));
}

function report(missing) {
  if (missing.length === 0) {
    console.log("Every added or modified changeset has a `Details: TC-N` line.");
    return;
  }
  for (const path of missing) {
    const message = `${path} needs a \`Details: TC-N\` line`;
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(`::error file=${path},title=Changeset needs a ticket::${message}`);
    }
    console.error(`${message} (several tickets: \`Details: TC-1, TC-2\`).`);
  }
  process.exitCode = 1;
}

const [base, head] = process.argv.slice(2);
if (base && head) report(missingDetails(base, head));
else {
  console.error("usage: check-changeset-details.mjs <base> <head>");
  process.exitCode = 2;
}
