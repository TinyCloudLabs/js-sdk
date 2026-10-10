import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { checkInstalledIntegrity } from "../src/clients/sut";

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
});
