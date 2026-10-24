import { readFileSync } from 'node:fs';

/** Package version from the `package.json` beside `dist/` (npm always ships it). */
export function courierVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version === '') throw new Error('courier package.json has no version');
  return pkg.version;
}
