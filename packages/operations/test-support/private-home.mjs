import { userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

// Bun 1.4's userInfo().homedir follows HOME. Node reads the OS account home.
// Query only OS identity, without loading any Node preloads or profile code.
const realHome = resolve(process.versions.bun
  ? execFileSync(process.env.NODE_BINARY ?? "node", ["-p", "require('node:os').userInfo().homedir"], {
    encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" },
  }).trim()
  : userInfo().homedir);

// Resolve only the OS home PARENT here, never the shared home/profile target.
// This also recognizes OS ancestor aliases such as /var -> /private/var.
const protectedHomes = [...new Set([realHome, join(realpathSync(dirname(realHome)), basename(realHome))])];

function refuseProtectedPath(path, name, includeHome = true) {
  const resolved = resolve(path);
  if (resolved === parse(resolved).root || protectedHomes.some((home) =>
    (includeHome && resolved === home) ||
    resolved === join(home, ".tinycloud") ||
    resolved.startsWith(`${join(home, ".tinycloud")}${sep}`))) {
    throw new Error(`Private profile tests refuse the real ${name}`);
  }
}

/** Resolve aliases componentwise; reject shared targets before probing them. */
export function assertPrivateTestHome(value, name = "test home") {
  if (!value || !isAbsolute(value)) throw new Error(`Private profile tests require explicit private ${name}`);
  const input = process.platform === "win32" ? value.replaceAll("/", sep) : value;
  let root = parse(input).root;
  let pending = input.slice(root.length).split(sep).filter(Boolean);
  let links = 0;
  refuseProtectedPath(input, name);
  while (pending.length > 0) {
    const component = pending.shift();
    if (component === ".") continue;
    if (component === "..") {
      root = dirname(root);
      continue;
    }
    const path = join(root, component);
    // A HOME ancestor can lead to this owned workspace, but its .tinycloud
    // tree must never be probed, even when a later ".." would leave it.
    refuseProtectedPath(path, name, pending.length === 0);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stats?.isSymbolicLink()) {
      if (++links > 40) throw new Error(`Private profile tests refuse a symlink loop in ${name}`);
      const target = readlinkSync(path);
      const targetRoot = parse(target).root;
      if (isAbsolute(target)) root = targetRoot;
      pending = [...target.slice(targetRoot.length).split(sep).filter(Boolean), ...pending];
      // Check the expanded destination BEFORE any lookup through the alias.
      // Keep raw components for traversal: resolving ".." before symlinks is unsafe.
      refuseProtectedPath(`${root}${sep}${pending.join(sep)}`, name);
    } else {
      root = path;
    }
  }
  refuseProtectedPath(root, name);
}

export function assertPrivateTestEnvironment(environment = process.env, stateRoot) {
  for (const name of ["HOME", "TC_HOME"]) assertPrivateTestHome(environment[name], name);
  if (stateRoot !== undefined) assertPrivateTestHome(stateRoot);
}
