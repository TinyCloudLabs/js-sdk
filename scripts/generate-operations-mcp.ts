import { spawn } from "node:child_process";

const check = process.argv.includes("--check");
const commands = [
  ["bun", "run", "--cwd", "packages/operations", check ? "check:generated" : "generate"],
  ["bun", "run", "--cwd", "packages/cli", check ? "check:generated" : "generate:reference"],
  ["bun", "run", "--cwd", "packages/mcp", check ? "check:generated" : "generate"],
  ["bun", "run", "--cwd", "packages/cli", "check:coverage"],
];

for (const command of commands) {
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exit(exitCode);
}
