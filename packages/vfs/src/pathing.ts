import { posix as pathPosix } from "node:path";

export const INTERNAL_META_PREFIX = ".tcvfs-meta";

export function normalizeVfsPath(inputPath: string): string {
  const normalized = pathPosix.normalize(inputPath.replace(/\\/g, "/"));
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return absolute;
}

export function toLogicalPath(inputPath: string): string {
  const normalized = normalizeVfsPath(inputPath);

  if (normalized.includes("\0")) {
    throw new Error("invalid path");
  }

  if (normalized === "/") {
    return "";
  }

  const logical = normalized.slice(1);
  if (
    logical === INTERNAL_META_PREFIX ||
    logical.startsWith(`${INTERNAL_META_PREFIX}/`) ||
    logical.split("/").includes("..")
  ) {
    throw new Error("path escapes virtual root");
  }

  return logical;
}

export function normalizeStoragePrefix(prefix?: string): string {
  if (!prefix) {
    return "";
  }

  return prefix
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function joinStoragePath(...parts: Array<string | undefined>): string {
  const cleaned = parts
    .filter((part): part is string => Boolean(part))
    .map((part) => normalizeStoragePrefix(part));

  return cleaned.filter(Boolean).join("/");
}

export function dirnameOf(logicalPath: string): string {
  if (!logicalPath) {
    return "";
  }

  const dir = pathPosix.dirname(`/${logicalPath}`);
  return dir === "/" ? "" : dir.slice(1);
}

export function basenameOf(logicalPath: string): string {
  return pathPosix.basename(logicalPath ? `/${logicalPath}` : "/");
}
