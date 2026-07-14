import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(scriptDirectory, '../generated/operations.json');
const catalog = `${JSON.stringify({ operations: [] }, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existingCatalog = await readFile(catalogPath, 'utf8').catch(() => '');
  if (existingCatalog !== catalog) {
    console.error('Generated operations catalog is out of date. Run bun run generate.');
    process.exitCode = 1;
  }
} else {
  await writeFile(catalogPath, catalog);
}
