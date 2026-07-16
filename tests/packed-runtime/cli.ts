import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "bun:test";

import {
  packPackage,
  run,
  withTrackedRepository,
  withPackedTinyCloudPackages,
} from "./tinycloud-entrypoints.ts";

const cliNodeBinary = process.env.CLI_NODE_BINARY ?? "node";

function relativeImportCandidates(
  cliDirectory: string,
  specifier: string,
): string[] {
  const base = join(cliDirectory, "dist", specifier);
  return [base, `${base}.js`, `${base}.cjs`, join(base, "index.js")];
}

async function assertNoDanglingRelativeImports(
  cliDirectory: string,
  built: string,
): Promise<void> {
  for (const match of built.matchAll(
    /(?:from|import\s*\()["'](\.[^"']+)["']/g,
  )) {
    const specifier = match[1]!;
    let exists = false;
    for (const candidate of relativeImportCandidates(cliDirectory, specifier)) {
      try {
        await readFile(candidate);
        exists = true;
        break;
      } catch {
        // Check the next published relative candidate.
      }
    }
    expect(exists, `missing relative CLI import ${specifier}`).toBe(true);
  }
}

export async function verifyPackedCliRuntime(): Promise<void> {
  await withPackedTinyCloudPackages(
    async (smokeDirectory, _packageDirectories, sourceDirectory) => {
      const packedCli = await packPackage(
        join(sourceDirectory, "packages/cli"),
        smokeDirectory,
      );
      const cliDirectory = packedCli.packageDirectory;
      const entrypoint = join(cliDirectory, "dist/index.js");
      const built = await readFile(entrypoint, "utf8");

      await assertNoDanglingRelativeImports(cliDirectory, built);
      expect(built).not.toContain("Dynamic require");
      expect(built).not.toContain("__require2");

      const home = join(smokeDirectory, "home");
      const profileDirectory = join(home, ".tinycloud/profiles/default");
      await mkdir(profileDirectory, { recursive: true });
      await writeFile(
        join(home, ".tinycloud/config.json"),
        '{"defaultProfile":"default","version":1}\n',
      );
      await writeFile(
        join(profileDirectory, "profile.json"),
        JSON.stringify({
          name: "default",
          host: "https://node.example",
          chainId: 1,
          spaceName: "secrets",
          did: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
          createdAt: "2026-07-15T00:00:00.000Z",
          posture: "owner-openkey",
          authMethod: "openkey",
        }) + "\n",
      );

      const runImport = async (requestId: string, associated: boolean) => {
        await writeFile(
          join(profileDirectory, "auth-requests.json"),
          JSON.stringify(
            associated
              ? [
                  {
                    kind: "tinycloud.auth.request",
                    version: 1,
                    requestId,
                    requested: [],
                  },
                ]
              : [],
          ) + "\n",
        );
        const artifactPath = join(
          smokeDirectory,
          `delegation-${requestId || "empty"}.json`,
        );
        await writeFile(
          artifactPath,
          JSON.stringify({
            kind: "tinycloud.auth.delegation",
            version: 1,
            requestId,
            delegation: {},
          }) + "\n",
        );

        try {
          await run(
            cliNodeBinary,
            [
              entrypoint,
              "--quiet",
              "--profile",
              "default",
              "auth",
              "import",
              artifactPath,
            ],
            smokeDirectory,
            { env: { ...process.env, TC_HOME: home, TC_PROFILE: "default" } },
          );
          throw new Error(
            `CLI import unexpectedly succeeded for ${JSON.stringify(requestId)}.`,
          );
        } catch (error) {
          const failure = error as {
            stdout?: string;
            stderr?: string;
            code?: number;
          };
          const stderr = failure.stderr ?? "";
          expect(failure.code).toBe(associated ? 1 : 2);
          if (!stderr.trimStart().startsWith("{")) throw new Error(stderr);
          const payload = JSON.parse(stderr) as { error?: { code?: unknown } };
          expect(payload.error?.code).toBe(
            associated ? "DELEGATION_ARTIFACT_INVALID" : "INVALID_AUTH_IMPORT",
          );
          expect(failure.stdout ?? "").toBe("");
        }
      };

      await runImport("", true);
      await runImport("request-1", true);
      await runImport("unmatched", false);
    },
  );
}

export async function verifyMissingTrackedCliArtifactCannotBeMasked(): Promise<void> {
  await withTrackedRepository(async (sourceDirectory) => {
    const sourcePackageDirectory = join(sourceDirectory, "packages/cli");
    let packageDirectory = sourcePackageDirectory;
    let isolatedPackageParent: string | undefined;
    if (sourceDirectory === join(import.meta.dir, "../..")) {
      isolatedPackageParent = await mkdtemp(
        join(import.meta.dir, "../../.tracked-cli-test-"),
      );
      packageDirectory = join(isolatedPackageParent, "cli");
      await cp(sourcePackageDirectory, packageDirectory, { recursive: true });
    }
    const entrypoint = join(packageDirectory, "dist/index.js");

    // Leave the normal ignored worktree build in place before testing the
    // isolated tracked snapshot. The snapshot must not observe that output.
    await run(
      process.execPath,
      ["run", "build"],
      join(import.meta.dir, "../../packages/cli"),
    );
    await rm(entrypoint);

    const smokeDirectory = await mkdtemp(
      join(import.meta.dir, "../../.packed-cli-missing-"),
    );
    try {
      const packed = await packPackage(packageDirectory, smokeDirectory);
      await expect(
        readFile(join(packed.packageDirectory, "dist/index.js")),
      ).rejects.toThrow();
    } finally {
      await rm(smokeDirectory, { recursive: true, force: true });
      if (isolatedPackageParent)
        await rm(isolatedPackageParent, { recursive: true, force: true });
    }
  });
}
