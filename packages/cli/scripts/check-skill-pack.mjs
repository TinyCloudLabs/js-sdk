// Validates that the npm tarball ships the complete tinycloud-cli and courier skills:
// every required file, every relative link resolvable inside the tarball, and
// frontmatter/release metadata that the cross-agent installer can read. The
// courier skill is a committed mirror of packages/courier/skills/courier
// (refresh with `bun run sync:courier-skill`) and must match it byte for byte.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const SKILLS = [
  { name: "tinycloud-cli", required: ["SKILL.md", "AUTH.md", "INSTALL.md", "REFERENCE.md", "SDK.md", "release.json"] },
  { name: "courier", required: ["SKILL.md", "release.json"], mirrorOf: "../courier/skills/courier" },
];

const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const files = new Set(pack.files.map((file) => file.path));

for (const { name: skillName, required, mirrorOf } of SKILLS) {
  const SKILL_DIR = `skills/${skillName}`;
  for (const file of required) assert.ok(files.has(`${SKILL_DIR}/${file}`), `npm tarball must contain ${SKILL_DIR}/${file}`);

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
  assert.ok(frontmatter, `${SKILL_DIR}/SKILL.md must start with YAML frontmatter`);
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  assert.equal(name, skillName, `${SKILL_DIR}/SKILL.md frontmatter name must be ${skillName}`);
  assert.ok(description && description.length <= 1024, `${SKILL_DIR}/SKILL.md needs a description of at most 1024 characters`);

  const release = JSON.parse(readFileSync(`${SKILL_DIR}/release.json`, "utf8"));
  assert.equal(release.name, name, `${SKILL_DIR}/release.json name must match the skill name`);
  for (const field of ["cli", "node"]) assert.equal(typeof release[field], "string", `${SKILL_DIR}/release.json needs a ${field} range`);

  if (mirrorOf) {
    const mirrored = readdirSync(SKILL_DIR, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    const canonical = readdirSync(mirrorOf, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    const relative = (entries, root) => entries.map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1)).sort();
    const mirroredFiles = relative(mirrored, SKILL_DIR);
    assert.deepEqual(mirroredFiles, relative(canonical, mirrorOf), `${SKILL_DIR} must have the same files as ${mirrorOf}; run bun run sync:courier-skill`);
    for (const file of mirroredFiles) {
      assert.ok(readFileSync(join(SKILL_DIR, file)).equals(readFileSync(join(mirrorOf, file))), `${SKILL_DIR}/${file} differs from ${mirrorOf}; run bun run sync:courier-skill`);
    }
  }
}

console.log(`Skill packaging passed: ${pack.name}@${pack.version}, ${files.size} files`);
