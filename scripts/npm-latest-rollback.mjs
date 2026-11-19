#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const SPEC = /^(@tinycloud\/[a-z0-9][a-z0-9._-]*)@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function requireConfirmation(confirm) {
  if (confirm !== "rollback") throw new Error("Type rollback in the confirmation field to continue.");
}

export function parsePackages(input) {
  const entries = input.trim().split(/[\s]+/).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !SPEC.test(entry))) {
    throw new Error("Invalid package spec; expected @tinycloud/<name>@<exact-semver>.");
  }
  const names = entries.map((spec) => spec.slice(0, spec.lastIndexOf("@")));
  if (new Set(names).size !== names.length) throw new Error("Duplicate package; each package must appear only once.");
  return entries.map((spec) => {
    const at = spec.lastIndexOf("@");
    return { spec, name: spec.slice(0, at), version: spec.slice(at + 1) };
  });
}

function npm(args) {
  return execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

export function rollback(input, confirm, runNpm = npm) {
  const moved = [];
  try {
    requireConfirmation(confirm);
    const packages = parsePackages(input);
    for (const { spec, version } of packages) {
      if (runNpm(["view", spec, "version"]) !== version) throw new Error(`npm does not report ${spec} as an existing version.`);
    }
    for (const { spec, name } of packages) {
      runNpm(["dist-tag", "add", spec, "latest"]);
      moved.push(spec);
      console.log(`Moved ${spec} to latest.`);
      console.log(`Dist-tags for ${name}: ${runNpm(["view", name, "dist-tags"])}`);
    }
  } catch (error) {
    console.error(`Completed moves: ${moved.length ? moved.join(", ") : "none"}`);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    rollback(process.env.PACKAGES ?? "", process.env.CONFIRM);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
