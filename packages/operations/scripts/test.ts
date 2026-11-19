import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertPrivateTestEnvironment } from "../test-support/private-home.mjs";

const selectedFiles = process.argv.slice(2);
const testFiles = selectedFiles.length > 0
  ? selectedFiles.map((file) => resolve(file)).sort()
  : (await collectTestFiles(join(process.cwd(), "src"))).sort();
if (testFiles.length === 0) {
  throw new Error("Operations test runner found no test files.");
}

for (const testFile of testFiles) {
  // The operations fixtures intentionally bind TC_HOME to a per-test
  // temporary state root. Keep tests within one file serial so Bun cannot
  // race those process-global fixture hooks and make the release gate flaky.
  const home = await mkdtemp(join(tmpdir(), "tinycloud-operations-runner-"));
  const env = { ...process.env, HOME: home, TC_HOME: home, USERPROFILE: home };
  assertPrivateTestEnvironment(env);
  let exitCode: number;
  try {
    const bootstrap = new URL("../test-support/test-bootstrap.mjs", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "test", "--preload", bootstrap, "--max-concurrency=1", testFile], {
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await child.exited;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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
