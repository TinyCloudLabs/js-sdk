import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const excluded = new Set(["web-sdk.test.ts"]); // Requires the optional, undeclared eth-testing integration package.
const tests = readdirSync(resolve(packageRoot, "tests"))
  .filter((file) => /\.test\.(?:ts|js)$/.test(file) && !excluded.has(file))
  .sort();

for (const file of tests) {
  const result = Bun.spawnSync(["bun", "test", `tests/${file}`], {
    cwd: packageRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

console.log(JSON.stringify({ runner: "bun", files: tests.length, excludedOptionalIntegrations: [...excluded] }));
