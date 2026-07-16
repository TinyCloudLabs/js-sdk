import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repositoryDirectory = resolve(import.meta.dir, "../..");
const workspaceNodeModules = join(repositoryDirectory, "node_modules");
const nodeBinary = process.env.NODE_BINARY ?? "node";

export const tinycloudPackages = [
  ["bootstrap", join(repositoryDirectory, "packages/bootstrap")],
  ["sdk-services", join(repositoryDirectory, "packages/sdk-services")],
  ["sdk-core", join(repositoryDirectory, "packages/sdk-core")],
  ["node-sdk-wasm", join(repositoryDirectory, "packages/sdk-rs/packages/node")],
  ["node-sdk", join(repositoryDirectory, "packages/node-sdk")],
  ["operations", join(repositoryDirectory, "packages/operations")],
] as const;

export async function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  options: Readonly<{ env?: NodeJS.ProcessEnv }> = {},
): Promise<string> {
  const result = await execFile(command, [...arguments_], {
    cwd,
    env: options.env ?? process.env,
    maxBuffer: 30 * 1024 * 1024,
  });
  return result.stdout;
}

export async function packPackage(
  packageDirectory: string,
  destination: string,
): Promise<{ archive: string; packageDirectory: string }> {
  const packed = JSON.parse(
    await run(
      "npm",
      ["pack", "--json", "--pack-destination", destination],
      packageDirectory,
    ),
  ) as Array<{ filename: string }>;
  if (packed.length !== 1)
    throw new Error(`Expected one tarball for ${packageDirectory}.`);

  const name = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  ) as {
    name?: unknown;
  };
  if (typeof name.name !== "string" || !name.name.startsWith("@tinycloud/")) {
    throw new Error(`Expected a TinyCloud package, got ${String(name.name)}.`);
  }
  const packagePath = join(
    destination,
    "node_modules",
    ...name.name.split("/"),
  );
  await mkdir(packagePath, { recursive: true });
  await run(
    "tar",
    [
      "-xzf",
      join(destination, packed[0]!.filename),
      "-C",
      packagePath,
      "--strip-components=1",
    ],
    repositoryDirectory,
  );
  const extracted = JSON.parse(
    await readFile(join(packagePath, "package.json"), "utf8"),
  ) as {
    name?: unknown;
  };
  if (extracted.name !== name.name) {
    throw new Error(`Extracted package metadata mismatch for ${name.name}.`);
  }
  return {
    archive: join(destination, packed[0]!.filename),
    packageDirectory: packagePath,
  };
}

export async function withPackedTinyCloudPackages<T>(
  callback: (
    smokeDirectory: string,
    packageDirectories: ReadonlyMap<string, string>,
  ) => Promise<T>,
): Promise<T> {
  const smokeDirectory = await mkdtemp(
    join(repositoryDirectory, ".packed-entrypoints-"),
  );
  try {
    // Build the generated WASM input from the clean Rust source before packing
    // the wrapper package. The wrapper's tarball, rather than workspace dist,
    // is the only TinyCloud WASM dependency visible to the probes.
    await run(
      process.execPath,
      ["run", "build:wasm:node"],
      join(repositoryDirectory, "packages/sdk-rs"),
    );
    for (const [, packageDirectory] of tinycloudPackages) {
      await run(process.execPath, ["run", "build"], packageDirectory);
    }

    await installThirdPartyDependencies(smokeDirectory);
    const packageDirectories = new Map<string, string>();
    for (const [name, packageDirectory] of tinycloudPackages) {
      const packed = await packPackage(packageDirectory, smokeDirectory);
      packageDirectories.set(name, packed.packageDirectory);
      if (name === "node-sdk-wasm") {
        const entries = (
          await run("tar", ["-tzf", packed.archive], repositoryDirectory)
        )
          .split("\n")
          .filter(Boolean)
          .map((entry) => entry.replace(/^package\//, ""));
        for (const required of [
          "dist/index.js",
          "dist/index.cjs",
          "dist/index.d.ts",
          "dist/wasm/index.cjs",
          "dist/wasm/index.d.cts",
          "dist/wasm/tinycloud_web_sdk_rs_bg.wasm",
        ]) {
          if (!entries.includes(required))
            throw new Error(`WASM tarball is missing ${required}.`);
        }
      }
    }
    return await callback(smokeDirectory, packageDirectories);
  } finally {
    await rm(smokeDirectory, { recursive: true, force: true });
  }
}

export async function verifyPackedTinyCloudEntrypoints(): Promise<void> {
  await withPackedTinyCloudPackages(async (smokeDirectory) => {
    const cjsProbe = `
      (async () => {
        const core = require("@tinycloud/sdk-core");
        if (typeof core.TinyCloud !== "function") throw new Error("SDK Core CJS export missing");
        const node = require("@tinycloud/node-sdk");
        if (typeof node.activateValidatedRuntimeDelegation !== "function") throw new Error("Node SDK CJS export missing");
        const operations = require("@tinycloud/operations");
        if (Object.keys(operations).join(",") !== "invokeOperation") throw new Error("Unexpected Operations CJS exports");
        const result = await operations.invokeOperation("tinycloud.unknown.get", 1, {}, {});
        if (result.status !== "error" || result.error.code !== "OPERATION_NOT_FOUND") throw new Error(JSON.stringify(result));
      })();
    `;
    await run(nodeBinary, ["-e", cjsProbe], smokeDirectory);

    const esmProbe = `
      const core = await import("@tinycloud/sdk-core");
      if (typeof core.TinyCloud !== "function") throw new Error("SDK Core ESM export missing");
      const node = await import("@tinycloud/node-sdk");
      if (typeof node.activateValidatedRuntimeDelegation !== "function") throw new Error("Node SDK ESM export missing");
      const operations = await import("@tinycloud/operations");
      if (Object.keys(operations).join(",") !== "invokeOperation") throw new Error("Unexpected Operations ESM exports");
      const result = await operations.invokeOperation("tinycloud.unknown.get", 1, {}, {});
      if (result.status !== "error" || result.error.code !== "OPERATION_NOT_FOUND") throw new Error(JSON.stringify(result));
    `;
    await run(
      nodeBinary,
      ["--input-type=module", "-e", esmProbe],
      smokeDirectory,
    );
  });
}

export async function installThirdPartyDependencies(
  smokeDirectory: string,
): Promise<void> {
  const smokeNodeModules = join(smokeDirectory, "node_modules");
  await mkdir(smokeNodeModules, { recursive: true });
  for (const entry of await readdir(workspaceNodeModules)) {
    if (entry === "@tinycloud") continue;
    const source = join(workspaceNodeModules, entry);
    try {
      const metadata = JSON.parse(
        await readFile(join(source, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (
        typeof metadata.name === "string" &&
        metadata.name.startsWith("@tinycloud/")
      ) {
        throw new Error(
          `Third-party dependency unexpectedly names a TinyCloud package: ${metadata.name}.`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const resolved = await realpath(source);
    if (
      resolved.includes("/packages/@tinycloud/") ||
      resolved.includes("/packages/tinycloud/")
    ) {
      throw new Error(
        `Third-party dependency resolves into a TinyCloud workspace package: ${resolved}.`,
      );
    }
    await symlink(source, join(smokeNodeModules, entry), "dir");
  }
  await mkdir(join(smokeNodeModules, "@tinycloud"), { recursive: true });
}
