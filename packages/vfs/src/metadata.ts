import { INTERNAL_META_PREFIX, joinStoragePath, normalizeStoragePrefix } from "./pathing";
import type { TinyCloudVfsFileEnvelope, TinyCloudVfsMetadata } from "./types";

export function dataKey(storageRoot: string, logicalPath: string): string {
  return joinStoragePath(storageRoot, logicalPath);
}

export function metadataKey(storageRoot: string, logicalPath: string): string {
  return joinStoragePath(storageRoot, INTERNAL_META_PREFIX, logicalPath);
}

export function metadataPrefix(storageRoot: string, logicalPath = ""): string {
  return joinStoragePath(storageRoot, INTERNAL_META_PREFIX, logicalPath);
}

export function encodeEnvelope(content: Buffer): TinyCloudVfsFileEnvelope {
  return {
    version: 1,
    encoding: "base64",
    data: content.toString("base64"),
  };
}

export function decodeEnvelope(value: unknown): Buffer {
  if (
    value &&
    typeof value === "object" &&
    (value as TinyCloudVfsFileEnvelope).version === 1 &&
    (value as TinyCloudVfsFileEnvelope).encoding === "base64" &&
    typeof (value as TinyCloudVfsFileEnvelope).data === "string"
  ) {
    return Buffer.from((value as TinyCloudVfsFileEnvelope).data, "base64");
  }

  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }

  throw new Error("unsupported file payload");
}

export function nowMetadata(kind: "file" | "directory", size: number, mode: number, existing?: TinyCloudVfsMetadata): TinyCloudVfsMetadata {
  const now = Date.now();
  return {
    kind,
    size,
    mode,
    ctimeMs: now,
    mtimeMs: now,
    birthtimeMs: existing?.birthtimeMs ?? now,
  };
}

export function normalizeMode(kind: "file" | "directory", mode?: number): number {
  if (typeof mode === "number" && Number.isFinite(mode)) {
    return mode;
  }

  return kind === "directory" ? 0o755 : 0o644;
}

export function stripStoragePrefix(fullKey: string, prefix: string): string {
  const normalizedPrefix = normalizeStoragePrefix(prefix);
  if (!normalizedPrefix) {
    return fullKey.replace(/^\/+/, "");
  }

  const withSlash = `${normalizedPrefix}/`;
  if (fullKey === normalizedPrefix) {
    return "";
  }

  if (fullKey.startsWith(withSlash)) {
    return fullKey.slice(withSlash.length);
  }

  return fullKey;
}
