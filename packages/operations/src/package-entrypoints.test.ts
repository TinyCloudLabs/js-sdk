import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

const execFile = promisify(execFileCallback);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "..");
const nodeBinary = process.env.NODE_BINARY ?? "node";

async function run(command: string, arguments_: readonly string[], cwd: string): Promise<string> {
  const result = await execFile(command, [...arguments_], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

test("packed operations package loads its real CJS and ESM entrypoints in Node", async () => {
  const smokeDirectory = await mkdtemp(join(packageDirectory, ".entrypoint-smoke-"));
  try {
    await run(process.execPath, ["run", "build"], packageDirectory);

    const packed = JSON.parse(
      await run("npm", ["pack", "--json", "--pack-destination", smokeDirectory], packageDirectory),
    ) as Array<{ filename: string }>;
    expect(packed).toHaveLength(1);

    const installedPackage = join(
      smokeDirectory,
      "node_modules",
      "@tinycloud",
      "operations",
    );
    await mkdir(installedPackage, { recursive: true });
    await run(
      "tar",
      ["-xzf", join(smokeDirectory, packed[0]!.filename), "-C", installedPackage, "--strip-components=1"],
      packageDirectory,
    );

    const assertRootExport = "if (Object.keys(operations).join(',') !== 'invokeOperation') throw new Error(`unexpected root exports: ${Object.keys(operations)}`);";
    await run(nodeBinary, ["-e", `const operations = require('@tinycloud/operations'); ${assertRootExport}`], smokeDirectory);
    await run(
      nodeBinary,
      [
        "--input-type=module",
        "-e",
        `const operations = await import('@tinycloud/operations'); ${assertRootExport}`,
      ],
      smokeDirectory,
    );
  } finally {
    await rm(smokeDirectory, { recursive: true, force: true });
  }
}, 20_000);
