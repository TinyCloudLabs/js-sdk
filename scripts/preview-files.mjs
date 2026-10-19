import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const json = async (path) => JSON.parse(await readFile(path, "utf8"));
export const within = (root, path) => {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../"));
};

// Includes mode and symlink targets; refuses links outside the portable tree.
export async function inventory(root, excluded = new Set()) {
  const result = {};
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const key = relative(root, path);
      if (excluded.has(key)) continue;
      const stat = await lstat(path);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || !within(root, resolve(directory, target)) || !within(root, await realpath(path))) {
          throw new Error(`Nonportable symlink: ${key}`);
        }
        result[key] = { target };
      } else if (stat.isFile()) {
        result[key] = { sha256: sha256(await readFile(path)), mode: stat.mode & 0o777 };
      } else throw new Error(`Unsupported file type: ${key}`);
    }
  }
  await visit(root);
  return result;
}

export function assertPlatform() {
  if (process.versions.node !== "22.23.2" || process.platform !== "linux" || process.arch !== "x64"
    || !process.report.getReport().header.glibcVersionRuntime) {
    throw new Error("This preview requires Node 22.23.2 on Linux x64 with glibc; macOS, Windows, musl and other architectures are not accepted targets.");
  }
}

// Audit archive paths before extraction, then audit links and package metadata
// in the extracted tree. Code named profile/history is not operator state.
export function assertPackagePath(path) {
  const parts = path.replace(/\/$/, "").split("/");
  if (parts[0] !== "package" || parts.some((part) => part === ".." || part === "")
    || parts.some((part) => /^(?:\.env(?:\..*)?|\.npmrc|\.git|\.ssh|\.aws|\.gnupg|\.cache|\.npm|\.config|\.tinycloud|\.tc-apps|\.tc-diagnostics)$/.test(part))
    || /(?:^|\/)(?:credentials|profiles|sessions|history|histories|cache|caches)\/(?!package\.json$)/i.test(path)
    || /(?:^|\/)(?:credentials|profiles|sessions|config\.local)\.json$/i.test(path)
    || /\.(?:sqlite(?:3)?(?:-wal|-shm)?|db|log|pem|key)$/i.test(path)) {
    throw new Error(`Sensitive or unsafe package member: ${path}`);
  }
}

export function assertPortableDependencies(manifest) {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range !== "string" || /^(?:workspace:|link:|\/|[A-Za-z]:\\)/.test(range)
        || (range.startsWith("file:") && !/^file:packs\/[a-zA-Z0-9._-]+\.tgz$/.test(range))) {
        throw new Error(`Nonportable dependency ${manifest.name}: ${name}=${range}`);
      }
    }
  }
}
