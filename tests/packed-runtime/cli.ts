import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "bun:test";

import {
  packPackage,
  run,
  withPackedTinyCloudPackages,
} from "./tinycloud-entrypoints.ts";

const packageDirectory = join(import.meta.dir, "../../packages/cli");
const cliNodeBinary = process.env.CLI_NODE_BINARY ?? "node";

export async function verifyPackedCliRuntime(): Promise<void> {
  await withPackedTinyCloudPackages(async (smokeDirectory) => {
    const packedCli = await packPackage(packageDirectory, smokeDirectory);
    const cliDirectory = packedCli.packageDirectory;
    const entrypoint = join(cliDirectory, "dist/index.js");
    const built = await readFile(entrypoint, "utf8");

    for (const match of built.matchAll(
      /(?:from|import\s*\()["'](\.[^"']+)["']/g,
    )) {
      const specifier = match[1]!;
      const base = join(cliDirectory, "dist", specifier);
      const candidates = [
        base,
        `${base}.js`,
        `${base}.cjs`,
        join(base, "index.js"),
      ];
      let exists = false;
      for (const candidate of candidates) {
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
  });
}
