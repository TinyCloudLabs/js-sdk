import { userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve, sep } from "node:path";

// Bun 1.4's userInfo().homedir follows HOME. Node reads the OS account home.
// Query only OS identity, without loading any Node preloads or profile code.
const realHome = resolve(process.versions.bun
  ? execFileSync(process.env.NODE_BINARY ?? "node", ["-p", "require('node:os').userInfo().homedir"], {
    encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" },
  }).trim()
  : userInfo().homedir);

/** Pure path guard: never probes, repairs or reads the real profile store. */
export function assertPrivateTestHome(value, name = "test home") {
  if (!value || !isAbsolute(value)) throw new Error(`Private profile tests require explicit private ${name}`);
  // Compare against OS identity, never a mutable HOME-derived homedir().
  const profileRoot = resolve(realHome, ".tinycloud");
  const path = resolve(value);
  if (path === realHome || path === profileRoot || path.startsWith(`${profileRoot}${sep}`) || path === sep) {
    throw new Error(`Private profile tests refuse the real ${name}`);
  }
}

export function assertPrivateTestEnvironment(environment = process.env, stateRoot) {
  for (const name of ["HOME", "TC_HOME"]) assertPrivateTestHome(environment[name], name);
  if (stateRoot !== undefined) assertPrivateTestHome(stateRoot);
}
