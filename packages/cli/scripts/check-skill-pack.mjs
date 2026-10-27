// Validates that the npm tarball ships the complete tc-cli, courier and tc-apps
// skills: every required file, every relative link resolvable inside the
// tarball, and frontmatter/release metadata that the cross-agent installer can
// read. The courier skill is a committed mirror of packages/courier/skills/courier
// (refresh with `bun run sync:courier-skill`) and must match it byte for byte.
// tc-apps is a mirror of TinyCloudLabs/prompts skills/tc-apps (refresh with
// `bun run sync:tc-apps-skill <prompts checkout>`); `tc setup apps` installs it
// from the tarball, so its SHA256SUMS must list exactly its files and match.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const TC_APPS_FILES = [
  "SKILL.md", "LEGACY.md", "LEGACY-SQL.md", "QUICKSTART.md", "SQL.md", "TINY-APPS.md",
  "announce.sh", "layout.sh", "migrate.sh", "owner-grant.sh", "owner-undo.sh", "tc-wrapper.sh",
];
const SKILLS = [
  { name: "tc-cli", required: ["SKILL.md", "AUTH.md", "INSTALL.md", "REFERENCE.md", "SDK.md", "release.json"] },
  { name: "courier", required: ["SKILL.md", "release.json"], mirrorOf: "../courier/skills/courier" },
  { name: "tc-apps", required: [...TC_APPS_FILES, "SHA256SUMS"], checksums: true },
];

const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const files = new Set(pack.files.map((file) => file.path));

for (const { name: skillName, required, mirrorOf, checksums } of SKILLS) {
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

  if (checksums) {
    // The same list agents.tinycloud.xyz serves as /skills/apps/SHA256SUMS: "<sha256>  <file>", sorted, one per file.
    const shipped = [...files].filter((path) => path.startsWith(`${SKILL_DIR}/`)).map((path) => path.slice(SKILL_DIR.length + 1));
    const listed = readFileSync(`${SKILL_DIR}/SHA256SUMS`, "utf8").trimEnd().split("\n").map((line) => line.split("  "));
    assert.deepEqual(listed.map(([, file]) => file), [...listed.map(([, file]) => file)].sort(), `${SKILL_DIR}/SHA256SUMS must be sorted by file name`);
    assert.deepEqual(listed.map(([, file]) => file).sort(), shipped.filter((file) => file !== "SHA256SUMS").sort(), `${SKILL_DIR}/SHA256SUMS must list exactly the skill's files`);
    for (const [sum, file] of listed) {
      assert.equal(createHash("sha256").update(readFileSync(`${SKILL_DIR}/${file}`)).digest("hex"), sum, `${SKILL_DIR}/${file} does not match SHA256SUMS`);
    }
    continue;
  }

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
