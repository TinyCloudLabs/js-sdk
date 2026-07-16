import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

const execFile = promisify(execFileCallback);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "..");

test("the packed CLI artifact contains the canonical import route and accepts empty request IDs", async () => {
  const source = await readFile(
    join(sourceDirectory, "commands", "auth.ts"),
    "utf8",
  );
  const built = await readFile(
    join(packageDirectory, "dist", "index.js"),
    "utf8",
  );
  const smokeDirectory = await mkdtemp(
    join(packageDirectory, ".packed-artifact-"),
  );

  try {
    const packed = JSON.parse(
      (
        await execFile(
          "npm",
          ["pack", "--json", "--pack-destination", smokeDirectory],
          {
            cwd: packageDirectory,
            maxBuffer: 10 * 1024 * 1024,
          },
        )
      ).stdout,
    ) as Array<{ filename: string }>;
    expect(packed).toHaveLength(1);

    const archive = join(smokeDirectory, packed[0]!.filename);
    const packedBuilt = (
      await execFile("tar", ["-xOf", archive, "package/dist/index.js"], {
        cwd: packageDirectory,
        maxBuffer: 20 * 1024 * 1024,
      })
    ).stdout;

    for (const artifact of [built, packedBuilt]) {
      expect(artifact).toContain('"tinycloud.auth.import"');
      expect(artifact).toContain('typeof candidate.requestId === "string"');
      expect(artifact).toContain("allowOwnerProfile: true");
    }
    expect(source).toContain('"tinycloud.auth.import"');
    expect(source).toContain('typeof candidate.requestId === "string"');
  } finally {
    await rm(smokeDirectory, { recursive: true, force: true });
  }
});
