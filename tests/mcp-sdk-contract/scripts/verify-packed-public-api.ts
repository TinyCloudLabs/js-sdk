import { execFile as execFileCallback } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const contractDirectory = resolve(testDirectory, "..");
const workspaceDirectory = resolve(contractDirectory, "../..");
const packageDirectory = (name: string) => join(workspaceDirectory, "packages", name);
const bun = process.execPath;

const packages = [
  { name: "@tinycloud/bootstrap", directory: packageDirectory("bootstrap") },
  { name: "@tinycloud/sdk-services", directory: packageDirectory("sdk-services") },
  { name: "@tinycloud/sdk-core", directory: packageDirectory("sdk-core") },
  { name: "@tinycloud/node-sdk", directory: packageDirectory("node-sdk") },
  { name: "@tinycloud/web-sdk", directory: packageDirectory("web-sdk") },
] as const;

async function run(
  command: string,
  arguments_: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execFile(command, [...arguments_], {
    cwd,
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}

async function buildPackages(): Promise<void> {
  for (const package_ of packages) {
    await run(bun, ["run", "build"], package_.directory);
  }
}

async function packPackage(
  directory: string,
  packDirectory: string,
): Promise<string> {
  const packed = JSON.parse(
    await run(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory],
      directory,
      { ...process.env, npm_config_cache: join(packDirectory, ".npm-cache") },
    ),
  ) as Array<{ filename: string }>;
  if (packed.length !== 1) {
    throw new Error(`expected one packed artifact from ${directory}`);
  }
  return join(packDirectory, packed[0]!.filename);
}

async function installWorkspaceDependencies(smokeDirectory: string): Promise<void> {
  const workspaceNodeModules = join(workspaceDirectory, "node_modules");
  const smokeNodeModules = join(smokeDirectory, "node_modules");
  await mkdir(smokeNodeModules, { recursive: true });

  for (const entry of await readdir(workspaceNodeModules)) {
    if (entry === "@tinycloud") continue;
    await symlink(join(workspaceNodeModules, entry), join(smokeNodeModules, entry), "dir");
  }

  const tinycloudDirectory = join(smokeNodeModules, "@tinycloud");
  await mkdir(tinycloudDirectory, { recursive: true });
  for (const name of ["node-sdk-wasm", "web-sdk-wasm"]) {
    await symlink(
      join(workspaceNodeModules, "@tinycloud", name),
      join(tinycloudDirectory, name),
      "dir",
    );
  }
}

async function installPackedPackages(smokeDirectory: string, packDirectory: string): Promise<void> {
  const tinycloudDirectory = join(smokeDirectory, "node_modules", "@tinycloud");
  await mkdir(packDirectory, { recursive: true });
  for (const package_ of packages) {
    const tarball = await packPackage(package_.directory, packDirectory);
    const target = join(tinycloudDirectory, package_.name.split("/")[1]!);
    await mkdir(target, { recursive: true });
    await run("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"], workspaceDirectory);
  }
}

async function compileConsumer(smokeDirectory: string): Promise<void> {
  const consumerDirectory = join(smokeDirectory, "consumer");
  await mkdir(consumerDirectory, { recursive: true });
  await cp(
    join(contractDirectory, "secret-read-entrypoints.compile.ts"),
    join(consumerDirectory, "index.ts"),
  );
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await writeFile(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        // Existing generated Zod and web facade declarations contain unrelated
        // library-internal diagnostics; consumer expressions below are still
        // checked strictly against the declarations extracted from tarballs.
        skipLibCheck: true,
        noEmit: true,
        types: ["node"],
      },
      files: ["index.ts"],
    }),
  );
  await run(
    bun,
    [join(workspaceDirectory, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    consumerDirectory,
  );
}

async function main(): Promise<void> {
  const smokeDirectory = await mkdtemp(join(contractDirectory, ".packed-public-api-"));
  try {
    await buildPackages();
    await installWorkspaceDependencies(smokeDirectory);
    await installPackedPackages(smokeDirectory, join(smokeDirectory, "packs"));
    await compileConsumer(smokeDirectory);
  } finally {
    await rm(smokeDirectory, { recursive: true, force: true });
  }
}

await main();
