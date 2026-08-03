import { readdir } from "node:fs/promises";
import { join } from "node:path";

const testFiles = (await collectTestFiles(join(process.cwd(), "src"))).sort();
if (testFiles.length === 0) {
  throw new Error("Operations test runner found no test files.");
}

for (const testFile of testFiles) {
  // The operations fixtures intentionally bind TC_HOME to a per-test
  // temporary state root. Keep tests within one file serial so Bun cannot
  // race those process-global fixture hooks and make the release gate flaky.
  const child = Bun.spawn([process.execPath, "test", "--max-concurrency=1", testFile], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

async function collectTestFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}
