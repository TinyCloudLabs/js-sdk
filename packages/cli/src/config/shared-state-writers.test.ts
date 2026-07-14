import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const wrappers = new Set([
  "config/profiles.ts",
  "lib/permissions.ts",
]);
const sharedNames = [
  "session.json",
  "additional-delegations.json",
  "auth-requests.json",
];
const writerNames = "writeJson|writeJsonAtomic|writeFile|appendFile|rm|rename";

test("shared profile stores have no direct CLI writers outside their compatibility wrappers", async () => {
  const sources = await sourceFiles(sourceRoot);
  const violations: string[] = [];

  for (const file of sources) {
    const source = await readFile(file.path, "utf8");
    if (wrappers.has(file.relative)) continue;

    for (const name of sharedNames) {
      const escapedName = escapeRegExp(name);
      const directWrite = new RegExp(
        `(?:${writerNames})\\s*\\(\\s*(?:join\\([^;]*${escapedName}|[^,;)]*${escapedName})`,
        "s",
      );
      if (directWrite.test(source)) {
        violations.push(`${file.relative} writes ${name} directly`);
      }
    }

    for (const helper of ["sessionPath", "additionalDelegationsPath", "permissionRequestsPath"]) {
      const helperWrite = new RegExp(`(?:${writerNames})\\s*\\(\\s*${helper}\\s*\\(`);
      if (helperWrite.test(source)) {
        violations.push(`${file.relative} writes through ${helper}`);
      }
    }
  }

  expect(violations).toEqual([]);
});

test("shared-state compatibility wrappers use operations state primitives", async () => {
  const profiles = await readFile(`${sourceRoot}/config/profiles.ts`, "utf8");
  const permissions = await readFile(`${sourceRoot}/lib/permissions.ts`, "utf8");

  expect(profiles).toContain('from "@tinycloud/operations/state"');
  expect(profiles).toMatch(/readSession/);
  expect(profiles).toMatch(/writeSession/);
  expect(profiles).toMatch(/removeSession/);
  expect(permissions).toContain('from "@tinycloud/operations/state"');
  expect(permissions).toMatch(/upsertProfileRecord/);
  expect(permissions).toMatch(/withProfileLock/);
});

async function sourceFiles(directory: string, prefix = ""): Promise<Array<{
  path: string;
  relative: string;
}>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ path: string; relative: string }> = [];

  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path, relative));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push({ path, relative });
    }
  }

  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
