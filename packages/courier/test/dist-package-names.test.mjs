import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));

test('built Courier code names only runtime dependencies or the enclosing CLI package', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // Courier is bundled into this CLI. Its own package-name literals are not CLI runtime imports.
  const declared = new Set([...Object.keys(manifest.dependencies), '@tinycloud/cli']);
  const walk = dir => fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]);
  for (const file of walk(path.join(root,'dist')).filter(p => /\.(?:c?js)$/.test(p))) {
    const executable = fs.readFileSync(file,'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');
    for (const [name] of executable.matchAll(/@tinycloud\/[a-z0-9-]+/g)) assert.ok(declared.has(name), `${path.relative(root,file)} names undeclared ${name}`);
  }
});
