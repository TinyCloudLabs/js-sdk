import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const files = new Set(pack.files.map(file => file.path));
for (const file of ['skills/tc-cli/SKILL.md', 'skills/tc-cli/REFERENCE.md', 'skills/tc-cli/SDK.md']) {
  assert.ok(files.has(file), `npm tarball must contain ${file}`);
}
const skill = readFileSync('skills/tc-cli/SKILL.md', 'utf8');
for (const [, target] of skill.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
  if (!target.startsWith('http')) assert.ok(files.has(`skills/tc-cli/${target}`), `missing skill reference: ${target}`);
}
console.log(`Skill packaging passed: ${pack.name}@${pack.version}, ${files.size} files`);
