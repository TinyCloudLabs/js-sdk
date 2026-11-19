import { describe, expect, test } from "bun:test";
import path from "node:path";

// The replica workers must not bundle the SQL or DuckDB services. The root
// `@tinycloud/sdk-services` barrel keeps its whole chunk alive (package
// sideEffects), so those services leaked into both worker bundles until the
// workers imported the subpaths they use (TC-1827).
const FORBIDDEN = [/\bSQLService\b/, /\bDuckDbService\b/];

// Bundle in a child process: the in-process bundler inherits state from the
// rest of the test run and fails to read package dist files.
async function bundleEntry(entry: string): Promise<string> {
  const proc = Bun.spawn(
    [process.execPath, "build", entry, "--target", "browser", "--format", "esm"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`bun build failed (${code}): ${stderr}`);
  }
  return stdout;
}

describe("replica worker bundles", () => {
  const entries = {
    "kv-storage worker": path.join(import.meta.dir, "worker.ts"),
    "replica worker": path.join(import.meta.dir, "..", "worker.ts"),
  };

  for (const [name, entry] of Object.entries(entries)) {
    test(`${name} bundle excludes SQL and DuckDB services`, async () => {
      const text = await bundleEntry(entry);
      // Positive control: the bundle really contains the KV service.
      expect(text).toMatch(/\bKVService\b/);
      for (const marker of FORBIDDEN) {
        expect(text).not.toMatch(marker);
      }
    }, 120_000);
  }
});
