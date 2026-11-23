import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "..");
const forbiddenPackages = [
  "commander",
  "@modelcontextprotocol/",
  "incur",
  "chalk",
  "ora",
  "open",
] as const;

async function typeScriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) return typeScriptFiles(entryPath);
      if (!entry.name.endsWith(".ts")) return [];
      return [entryPath];
    }),
  );

  return files.flat();
}

function containsForbiddenImport(source: string, packageName: string): boolean {
  const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const packagePattern = packageName.endsWith("/")
    ? `${escapedPackage}[^"']+`
    : `${escapedPackage}(?:["']|/)`;
  const importPatterns = [
    new RegExp(
      String.raw`\b(?:import|export)\s+(?:type\s+)?[^;"']*?\bfrom\s*(["'])${packagePattern}`,
    ),
    new RegExp(String.raw`\bimport\s*(["'])${packagePattern}`),
    new RegExp(String.raw`\bimport\s*\(\s*(["'])${packagePattern}`),
    new RegExp(String.raw`\brequire\s*\(\s*(["'])${packagePattern}`),
  ];

  return importPatterns.some((pattern) => pattern.test(source));
}

function isForbiddenDependency(dependency: string, forbiddenPackage: string): boolean {
  return forbiddenPackage.endsWith("/")
    ? dependency.startsWith(forbiddenPackage)
    : dependency === forbiddenPackage;
}

test("operations has no projection-framework dependencies or imports", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(packageDirectory, "package.json"), "utf8"),
  ) as Record<string, Record<string, string> | undefined>;
  const dependencyNames = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ];

  for (const forbiddenPackage of forbiddenPackages) {
    expect(
      dependencyNames.some(
        (dependency) => isForbiddenDependency(dependency, forbiddenPackage),
      ),
    ).toBe(false);
  }

  const sourceFiles = [
    ...(await typeScriptFiles(resolve(packageDirectory, "src"))),
    ...(await typeScriptFiles(resolve(packageDirectory, "scripts"))),
  ];
  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, "utf8");
    for (const forbiddenPackage of forbiddenPackages) {
      expect(containsForbiddenImport(source, forbiddenPackage)).toBe(false);
    }
  }
});
