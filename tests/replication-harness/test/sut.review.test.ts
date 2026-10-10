import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { checkInstalledIntegrity, installedFilesSha256, publishedCachePrefix, verifyInstalledFiles } from "../src/clients/sut";

describe("published SUT integrity", () => {
  test("rejects installed package-lock integrity that differs from the registry", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "tc893-integrity-"));
    try {
      const packageDir = join(prefix, "node_modules", "@tinycloud", "cli");
      await mkdir(packageDir, { recursive: true });
      const packageJson = join(packageDir, "package.json");
      await writeFile(packageJson, JSON.stringify({ name: "@tinycloud/cli", version: "1.1.0-beta.24" }));
      await writeFile(join(prefix, "node_modules", ".package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/@tinycloud/cli": { version: "1.1.0-beta.24", integrity: "sha512-tampered" } },
      }));
      await expect(checkInstalledIntegrity(prefix, packageJson, "@tinycloud/cli", "sha512-registry"))
        .rejects.toMatchObject({ code: "PREFLIGHT_FAILED", detail: { expected: "sha512-registry", locked: "sha512-tampered" } });
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  });
  test("detects a tampered installed CLI entry on cache reuse", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "tc893-installed-files-"));
    try {
      const packageDir = join(prefix, "node_modules", "@tinycloud", "cli");
      await mkdir(join(packageDir, "bin"), { recursive: true });
      const packageJson = join(packageDir, "package.json");
      const entry = join(packageDir, "bin", "tc");
      await writeFile(packageJson, JSON.stringify({ name: "@tinycloud/cli", version: "1.1.0-beta.24" }));
      await writeFile(entry, "#!/usr/bin/env node\n");
      const resolved = await installedFilesSha256(packageJson);
      await writeFile(entry, "#!/usr/bin/env node\n// modified\n");
      await expect(verifyInstalledFiles(packageJson, resolved))
        .rejects.toMatchObject({ code: "PREFLIGHT_FAILED" });
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  });

  test("isolates published install prefixes by harness run", () => {
    const first = publishedCachePrefix("/tmp", "run-a", "1.1.0-beta.24", "3.1.0-beta.15");
    const second = publishedCachePrefix("/tmp", "run-b", "1.1.0-beta.24", "3.1.0-beta.15");
    expect(first).not.toBe(second);
  });
});
