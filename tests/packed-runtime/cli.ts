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
    async (smokeDirectory, packageDirectories) => {
      const cliDirectory = packageDirectories.get("cli");
      if (!cliDirectory) throw new Error("Packed CLI package was not produced.");
      const selectedNodeMajor = (
        await run(
          cliNodeBinary,
          ["-p", "process.versions.node.split('.')[0]"],
          smokeDirectory,
        )
      ).trim();
      expect(selectedNodeMajor).toBe(process.env.EXPECTED_NODE_MAJOR ?? "20");
      const entrypoint = join(cliDirectory, "dist/index.js");
      const built = await readFile(entrypoint, "utf8");

      await assertNoDanglingRelativeImports(cliDirectory, built);
      expect(built).not.toContain("Dynamic require");
      expect(built).not.toContain("__require2");
      expect(built).toContain("tinycloud.secrets.get");

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

      const operationProfileDirectory = join(home, ".tinycloud/profiles/operation");
      await mkdir(operationProfileDirectory, { recursive: true });
      await writeFile(
        join(operationProfileDirectory, "profile.json"),
        JSON.stringify({
          name: "operation",
          host: "https://node.example",
          chainId: 1,
          spaceName: "secrets",
          did: "did:key:operation",
          createdAt: "2026-07-15T00:00:00.000Z",
          posture: "delegate-session",
          authMethod: "openkey",
        }) + "\n",
      );
      try {
        await run(
          cliNodeBinary,
          [entrypoint, "--quiet", "--profile", "operation", "secrets", "get", "API_KEY", "--json"],
          smokeDirectory,
          { env: { ...process.env, TC_HOME: home, TC_PROFILE: "operation" } },
        );
        throw new Error("Packed canonical secrets get unexpectedly succeeded.");
      } catch (error) {
        const failure = error as { stderr?: string; code?: number };
        expect(failure.code).toBe(3);
        const payload = JSON.parse(failure.stderr ?? "{}") as { error?: { code?: unknown } };
        expect(payload.error?.code).toBe("AUTH_REQUIRED");
      }

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
          expect(failure.code).toBe(1);
          if (!stderr.trimStart().startsWith("{")) throw new Error(stderr);
          const payload = JSON.parse(stderr) as { error?: { code?: unknown } };
          expect(payload.error?.code).toBe("DELEGATION_ARTIFACT_INVALID");
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
    const trackedBuild = await readFile(entrypoint, "utf8");
    expect(trackedBuild).toContain("tinycloud.secrets.get");
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
