import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");

function run(cwd: string, command: string[]): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
  }
}

const rustSdk = resolve(repositoryRoot, "packages/sdk-rs");
run(rustSdk, ["wasm-pack", "build", "--release", "--no-opt", "--target", "web", "--out-dir", "web-sdk-wasm", "--manifest-path", "Cargo.toml", "--features", "browser"]);
run(rustSdk, ["wasm-pack", "build", "--release", "--no-opt", "--target", "nodejs", "--out-dir", "node-sdk-wasm", "--manifest-path", "Cargo.toml", "--features", "nodejs"]);
run(resolve(rustSdk, "packages/web"), ["bun", "run", "build"]);
run(resolve(rustSdk, "packages/node"), ["bun", "run", "build"]);
run(resolve(repositoryRoot, "packages/sdk-core"), ["bun", "run", "build"]);
run(resolve(repositoryRoot, "packages/sdk-services"), ["bun", "run", "build"]);
run(resolve(repositoryRoot, "packages/node-sdk"), ["bun", "run", "build"]);
