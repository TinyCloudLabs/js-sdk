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
const expectedNodeMajor = process.env.EXPECTED_NODE_MAJOR ?? "20";

const publishedPackageNames = {
  bootstrap: "@tinycloud/bootstrap",
  "sdk-services": "@tinycloud/sdk-services",
  "sdk-core": "@tinycloud/sdk-core",
  "node-sdk-wasm": "@tinycloud/node-sdk-wasm",
  "node-sdk": "@tinycloud/node-sdk",
  operations: "@tinycloud/operations",
  cli: "@tinycloud/cli",
} as const;

export function tinycloudPackages(root = repositoryDirectory) {
  return [
    ["bootstrap", join(root, "packages/bootstrap")],
    ["sdk-services", join(root, "packages/sdk-services")],
    ["sdk-core", join(root, "packages/sdk-core")],
    ["node-sdk-wasm", join(root, "packages/sdk-rs/packages/node")],
    ["node-sdk", join(root, "packages/node-sdk")],
    ["operations", join(root, "packages/operations")],
    ["cli", join(root, "packages/cli")],
  ] as const;
}

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

export async function withTrackedRepository<T>(
  callback: (sourceDirectory: string) => Promise<T>,
): Promise<T> {
  let isCheckout = false;
  try {
    isCheckout =
      (
        await run(
          "git",
          ["rev-parse", "--is-inside-work-tree"],
          repositoryDirectory,
        )
      ).trim() === "true";
  } catch {
    // An extracted Git archive is already the tracked input tree.
  }
  if (!isCheckout) return await callback(repositoryDirectory);

  const snapshotParent = await mkdtemp(
    join(repositoryDirectory, ".tracked-archive-"),
  );
  const archive = join(snapshotParent, "repository.tar");
  const sourceDirectory = join(snapshotParent, "source");
  await mkdir(sourceDirectory);
  try {
    await run(
      "git",
      ["archive", "--format=tar", "HEAD", "-o", archive],
      repositoryDirectory,
    );
    await run(
      "tar",
      ["-xf", archive, "-C", sourceDirectory],
      repositoryDirectory,
    );
    return await callback(sourceDirectory);
  } finally {
    await rm(snapshotParent, { recursive: true, force: true });
  }
}

async function hasFiles(
  root: string,
  files: readonly string[],
): Promise<boolean> {
  try {
    await Promise.all(files.map((file) => readFile(join(root, file))));
    return true;
  } catch {
    return false;
  }
}

async function assertPackedNode20Manifest(
  name: keyof typeof publishedPackageNames,
  packageDirectory: string,
): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  ) as {
    name?: unknown;
    engines?: { node?: unknown };
  };
  const expectedName = publishedPackageNames[name];
  if (manifest.name !== expectedName || manifest.engines?.node !== ">=20") {
    throw new Error(
      `Packed ${expectedName} must advertise engines.node >=20; got ${JSON.stringify({
        name: manifest.name,
        node: manifest.engines?.node,
      })}.`,
    );
  }
}

async function linkThirdPartyDependencies(destination: string): Promise<void> {
  const sourceNodeModules = workspaceNodeModules;
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(sourceNodeModules)) {
    if (entry === "@tinycloud") continue;
    const source = join(sourceNodeModules, entry);
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
    if (resolved.includes("/packages/")) {
      throw new Error(
        `Third-party dependency resolves into a workspace package: ${resolved}.`,
      );
    }
    await symlink(source, join(destination, entry), "dir");
  }
}

async function prepareIsolatedBuildTree(
  sourceDirectory: string,
): Promise<void> {
  const sourceNodeModules = join(sourceDirectory, "node_modules");
  if (sourceDirectory !== repositoryDirectory) {
    await linkThirdPartyDependencies(sourceNodeModules);
    const tinycloudNodeModules = join(sourceNodeModules, "@tinycloud");
    await mkdir(tinycloudNodeModules, { recursive: true });
    const packageLinks = [
      ["bootstrap", join(sourceDirectory, "packages/bootstrap")],
      ["sdk-services", join(sourceDirectory, "packages/sdk-services")],
      ["sdk-core", join(sourceDirectory, "packages/sdk-core")],
      ["sdk-rs", join(sourceDirectory, "packages/sdk-rs")],
      ["node-sdk-wasm", join(sourceDirectory, "packages/sdk-rs/packages/node")],
      ["node-sdk", join(sourceDirectory, "packages/node-sdk")],
      ["operations", join(sourceDirectory, "packages/operations")],
      ["cli", join(sourceDirectory, "packages/cli")],
    ] as const;
    for (const [name, packageDirectory] of packageLinks) {
      await symlink(packageDirectory, join(tinycloudNodeModules, name), "dir");
    }
  }
}

async function buildPackedGraph(sourceDirectory: string): Promise<void> {
  await prepareIsolatedBuildTree(sourceDirectory);
  const wasmRoot = join(sourceDirectory, "packages/sdk-rs/node-sdk-wasm");
  if (
    !(await hasFiles(wasmRoot, [
      "tinycloud_web_sdk_rs.js",
      "tinycloud_web_sdk_rs.d.ts",
      "tinycloud_web_sdk_rs_bg.wasm",
    ]))
  ) {
    await run(
      process.execPath,
      ["run", "build:wasm:node"],
      join(sourceDirectory, "packages/sdk-rs"),
    );
  }
  const requiredOutputs = [
    ["bootstrap", ["dist/index.js"]],
    ["sdk-services", ["dist/index.js"]],
    ["sdk-core", ["dist/index.js"]],
    [
      "node-sdk-wasm",
      [
        "dist/index.cjs",
        "dist/wasm/index.cjs",
        "dist/wasm/tinycloud_web_sdk_rs_bg.wasm",
      ],
    ],
    ["node-sdk", ["dist/index.js", "dist/index.cjs"]],
    [
      "operations",
      ["dist/index.js", "dist/index.cjs", "dist/state.js", "dist/state.cjs"],
    ],
  ] as const;
  for (const [name, files] of requiredOutputs) {
    const packageDirectory = tinycloudPackages(sourceDirectory).find(
      ([candidate]) => candidate === name,
    )?.[1];
    if (!packageDirectory)
      throw new Error(`Unknown TinyCloud package ${name}.`);
    if (!(await hasFiles(packageDirectory, files))) {
      await run(process.execPath, ["run", "build"], packageDirectory);
    }
  }
}

export async function withPackedTinyCloudPackages<T>(
  callback: (
    smokeDirectory: string,
    packageDirectories: ReadonlyMap<string, string>,
    sourceDirectory: string,
  ) => Promise<T>,
): Promise<T> {
  return await withTrackedRepository(async (sourceDirectory) => {
    await buildPackedGraph(sourceDirectory);
    const smokeDirectory = await mkdtemp(
      join(repositoryDirectory, ".packed-entrypoints-"),
    );
    try {
      await installThirdPartyDependencies(smokeDirectory);
      const packageDirectories = new Map<string, string>();
      for (const [name, packageDirectory] of tinycloudPackages(
        sourceDirectory,
      )) {
        const packed = await packPackage(packageDirectory, smokeDirectory);
        packageDirectories.set(name, packed.packageDirectory);
        await assertPackedNode20Manifest(name, packed.packageDirectory);
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
      return await callback(
        smokeDirectory,
        packageDirectories,
        sourceDirectory,
      );
    } finally {
      await rm(smokeDirectory, { recursive: true, force: true });
    }
  });
}

export async function verifyPackedTinyCloudEntrypoints(): Promise<void> {
  await withPackedTinyCloudPackages(async (smokeDirectory) => {
    const selectedNodeMajor = (
      await run(
        nodeBinary,
        ["-p", "process.versions.node.split('.')[0]"],
        smokeDirectory,
      )
    ).trim();
    if (selectedNodeMajor !== expectedNodeMajor) {
      throw new Error(
        `Packed entrypoint probe expected Node ${expectedNodeMajor}, got ${selectedNodeMajor} from ${nodeBinary}.`,
      );
    }
    const cjsProbe = `
      (async () => {
        const core = require("@tinycloud/sdk-core");
        if (typeof core.TinyCloud !== "function") throw new Error("SDK Core CJS export missing");
        const wasm = require("@tinycloud/node-sdk-wasm");
        if (!wasm || typeof wasm !== "object") throw new Error("Node SDK WASM CJS package missing");
        const node = require("@tinycloud/node-sdk");
        if (typeof node.activateValidatedRuntimeDelegation !== "function") throw new Error("Node SDK CJS export missing");
        const operations = require("@tinycloud/operations");
        if (Object.keys(operations).join(",") !== "invokeOperation") throw new Error("Unexpected Operations CJS exports");
        const state = require("@tinycloud/operations/state");
        if (typeof state.updateProfileStore !== "function") throw new Error("Operations state CJS export missing");
        if (typeof state.updateProfileStoreWhileLocked === "function") throw new Error("Operations state leaked a lock-owning export");
        const result = await operations.invokeOperation("tinycloud.unknown.get", 1, {}, {});
        if (result.status !== "error" || result.error.code !== "OPERATION_NOT_FOUND") throw new Error(JSON.stringify(result));
      })();
    `;
    await run(nodeBinary, ["-e", cjsProbe], smokeDirectory);

    const esmProbe = `
      const core = await import("@tinycloud/sdk-core");
      if (typeof core.TinyCloud !== "function") throw new Error("SDK Core ESM export missing");
      const wasm = await import("@tinycloud/node-sdk-wasm");
      if (!wasm || typeof wasm !== "object") throw new Error("Node SDK WASM ESM package missing");
      const node = await import("@tinycloud/node-sdk");
      if (typeof node.activateValidatedRuntimeDelegation !== "function") throw new Error("Node SDK ESM export missing");
      const operations = await import("@tinycloud/operations");
      if (Object.keys(operations).join(",") !== "invokeOperation") throw new Error("Unexpected Operations ESM exports");
      const state = await import("@tinycloud/operations/state");
      if (typeof state.updateProfileStore !== "function") throw new Error("Operations state ESM export missing");
      if (typeof state.updateProfileStoreWhileLocked === "function") throw new Error("Operations state leaked a lock-owning export");
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
  await linkThirdPartyDependencies(join(smokeDirectory, "node_modules"));
  await mkdir(join(smokeDirectory, "node_modules", "@tinycloud"), {
    recursive: true,
  });
}
