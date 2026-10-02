// Validates that the npm tarball ships the complete tc-cli skill: every
// required file, every relative link resolvable inside the tarball, and
// frontmatter/release metadata that the cross-agent installer can read.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const SKILL_DIR = "skills/tc-cli";
const REQUIRED = ["SKILL.md", "AUTH.md", "INSTALL.md", "REFERENCE.md", "SDK.md", "release.json"];

const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const files = new Set(pack.files.map((file) => file.path));
for (const file of REQUIRED) assert.ok(files.has(`${SKILL_DIR}/${file}`), `npm tarball must contain ${SKILL_DIR}/${file}`);

for (const file of [...files].filter((path) => path.startsWith(`${SKILL_DIR}/`) && path.endsWith(".md"))) {
  const text = readFileSync(file, "utf8");
  for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue;
    const resolved = normalize(join(dirname(file), target));
    assert.ok(files.has(resolved), `${file} links to ${target}, which the tarball does not contain`);
  }
}

const skill = readFileSync(`${SKILL_DIR}/SKILL.md`, "utf8");
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
assert.ok(frontmatter, "SKILL.md must start with YAML frontmatter");
const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
assert.equal(name, "tc-cli", "SKILL.md frontmatter name must be tc-cli");
assert.ok(description && description.length <= 1024, "SKILL.md needs a description of at most 1024 characters");

const release = JSON.parse(readFileSync(`${SKILL_DIR}/release.json`, "utf8"));
assert.equal(release.name, name, "release.json name must match the skill name");
for (const field of ["cli", "node"]) assert.equal(typeof release[field], "string", `release.json needs a ${field} range`);

console.log(`Skill packaging passed: ${pack.name}@${pack.version}, ${files.size} files`);
