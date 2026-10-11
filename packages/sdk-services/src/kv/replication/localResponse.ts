import { err, ErrorCodes, ok, serviceError } from "../../types";
import type { KVResponse } from "../types";
import type { LocalGetResult } from "./types";

export type LocalGetResponse<T> = { ok: true; data: KVResponse<T> } | { ok: false; error: { code: string; message: string; service: string; meta?: Record<string, unknown> } };

export function parseLocalValue<T>(bytes: Uint8Array, contentType: string | undefined, raw: boolean | undefined, binary: boolean | undefined): T {
  if (binary) return bytes as T;
  const text = new TextDecoder().decode(bytes);
  if (raw) return text as T;
  if (contentType?.includes("application/json")) return JSON.parse(text) as T;
  if (contentType?.startsWith("text/")) return text as T;
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; } catch { return text as T; }
}

export function localGet<T>(result: LocalGetResult, key: string, options: { raw?: boolean; binary?: boolean; maxResponseBytes?: number }): LocalGetResponse<T> {
  if (result.status === "present") {
    if (options.maxResponseBytes !== undefined && result.value.byteLength > options.maxResponseBytes) {
      return err(serviceError(ErrorCodes.KV_RESPONSE_TOO_LARGE, `KV value at key ${JSON.stringify(key)} exceeds the requested response limit`, "kv", { meta: { status: 413 } }));
    }
    const contentType = Object.entries(result.metadata).find(([name]) => name.toLowerCase() === "content-type")?.[1];
    const headers = new Headers({ etag: result.etag, "content-length": String(result.value.byteLength), "cache-control": "private, no-cache", ...result.metadata, "x-tinycloud-source": "replica" });
    return ok({
      data: parseLocalValue<T>(result.value, contentType, options.raw, options.binary),
      headers: {
        etag: result.etag,
        contentType,
        contentLength: result.value.byteLength,
        get: (name: string) => headers.get(name),
      },
    });
  }
  if (result.status === "absent" || result.status === "deleted") return err(serviceError(ErrorCodes.KV_NOT_FOUND, `Key not found: ${key}`, "kv"));
  return err(serviceError(ErrorCodes.NETWORK_ERROR, "Local value is not available", "kv"));
}
