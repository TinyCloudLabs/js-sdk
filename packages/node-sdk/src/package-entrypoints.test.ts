import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { expect, test } from "bun:test";

const execFile = promisify(execFileCallback);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "..");
const nodeBinary = process.env.NODE_BINARY ?? "node";

async function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await execFile(command, [...arguments_], {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}

test("packed node-sdk CJS and ESM entrypoints expose and can call activation", async () => {
  const smokeDirectory = await mkdtemp(
    join(packageDirectory, ".entrypoint-smoke-"),
  );
  try {
    await run(process.execPath, ["run", "build"], packageDirectory);
    const packed = JSON.parse(
      await run(
        "npm",
        ["pack", "--json", "--pack-destination", smokeDirectory],
        packageDirectory,
      ),
    ) as Array<{ filename: string }>;
    expect(packed).toHaveLength(1);

    await installWorkspaceDependencies(smokeDirectory);
    const installedPackage = join(
      smokeDirectory,
      "node_modules",
      "@tinycloud",
      "node-sdk",
    );
    await mkdir(installedPackage, { recursive: true });
    await run(
      "tar",
      [
        "-xzf",
        join(smokeDirectory, packed[0]!.filename),
        "-C",
        installedPackage,
        "--strip-components=1",
      ],
      packageDirectory,
    );

    await run(
      nodeBinary,
      [
        "-e",
        `void (async () => { const sdk = require('@tinycloud/node-sdk'); if (typeof sdk.activateValidatedRuntimeDelegation !== 'function') throw new Error('missing activation export'); let rejected = false; try { await sdk.activateValidatedRuntimeDelegation({}, {}); } catch { rejected = true; } if (!rejected) throw new Error('invalid delegation unexpectedly activated'); })();`,
      ],
      smokeDirectory,
    );
    await run(
      nodeBinary,
      [
        "--input-type=module",
        "-e",
        `const sdk = await import('@tinycloud/node-sdk'); if (typeof sdk.activateValidatedRuntimeDelegation !== 'function') throw new Error('missing activation export'); let rejected = false; try { await sdk.activateValidatedRuntimeDelegation({}, {}); } catch { rejected = true; } if (!rejected) throw new Error('invalid delegation unexpectedly activated');`,
      ],
      smokeDirectory,
    );
  } finally {
    await rm(smokeDirectory, { recursive: true, force: true });
  }
}, 30_000);

async function installWorkspaceDependencies(
  smokeDirectory: string,
): Promise<void> {
  const workspaceNodeModules = resolve(packageDirectory, "../../node_modules");
  const smokeNodeModules = join(smokeDirectory, "node_modules");
  await mkdir(smokeNodeModules, { recursive: true });
  for (const entry of await readdir(workspaceNodeModules)) {
    if (entry === "@tinycloud") continue;
    await symlink(
      join(workspaceNodeModules, entry),
      join(smokeNodeModules, entry),
      "dir",
    );
  }
  const workspaceTinyCloud = join(workspaceNodeModules, "@tinycloud");
  const smokeTinyCloud = join(smokeNodeModules, "@tinycloud");
  await mkdir(smokeTinyCloud, { recursive: true });
  for (const name of [
    "bootstrap",
    "node-sdk-wasm",
    "sdk-core",
    "sdk-services",
  ]) {
    await symlink(
      join(workspaceTinyCloud, name),
      join(smokeTinyCloud, name),
      "dir",
    );
  }
}
