import { readFileSync } from 'node:fs';

/** Name and version from the `package.json` beside `dist/` (npm always ships it). */
export function courierPackage(): { name: string; version: string } {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name?: unknown; version?: unknown };
  if (typeof pkg.name !== 'string' || pkg.name === '') throw new Error('courier package.json has no name');
  if (typeof pkg.version !== 'string' || pkg.version === '') throw new Error('courier package.json has no version');
  return { name: pkg.name, version: pkg.version };
}

export function courierVersion(): string {
  return courierPackage().version;
}
