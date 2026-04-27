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

function isEnvelopeShape(value: unknown): value is TinyCloudVfsFileEnvelope {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as TinyCloudVfsFileEnvelope).version === 1 &&
    (value as TinyCloudVfsFileEnvelope).encoding === "base64" &&
    typeof (value as TinyCloudVfsFileEnvelope).data === "string"
  );
}

export function encodeFileValue(content: Buffer): string | TinyCloudVfsFileEnvelope {
  const utf8 = content.toString("utf8");
  if (Buffer.from(utf8, "utf8").equals(content)) {
    return utf8;
  }

  return encodeEnvelope(content);
}

export function decodeEnvelope(value: unknown): Buffer {
  if (isEnvelopeShape(value)) {
    return Buffer.from((value as TinyCloudVfsFileEnvelope).data, "base64");
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isEnvelopeShape(parsed)) {
        return Buffer.from(parsed.data, "base64");
      }
    } catch {
      // Plain text payloads are expected and should fall through.
    }

    return Buffer.from(value, "utf8");
  }

  throw new Error("unsupported file payload");
}

function isMetadataShape(value: unknown): value is TinyCloudVfsMetadata {
  return Boolean(
    value &&
    typeof value === "object" &&
    (((value as TinyCloudVfsMetadata).kind === "file") || ((value as TinyCloudVfsMetadata).kind === "directory")) &&
    typeof (value as TinyCloudVfsMetadata).size === "number" &&
    typeof (value as TinyCloudVfsMetadata).mode === "number" &&
    typeof (value as TinyCloudVfsMetadata).ctimeMs === "number" &&
    typeof (value as TinyCloudVfsMetadata).mtimeMs === "number" &&
    typeof (value as TinyCloudVfsMetadata).birthtimeMs === "number"
  );
}

export function decodeMetadata(value: unknown): TinyCloudVfsMetadata {
  if (isMetadataShape(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (isMetadataShape(parsed)) {
      return parsed;
    }
  }

  throw new Error("unsupported metadata payload");
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
