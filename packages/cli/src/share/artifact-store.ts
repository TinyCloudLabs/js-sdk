import { ArtifactError, type ArtifactStore } from "@tinycloud/share-sdk";
import type { IKVService } from "@tinycloud/node-sdk";

const MAX_LIST_PAGES = 1000;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * The owner-space KV as an {@link ArtifactStore}. `put` always carries
 * `If-None-Match: *`, so a 412 (`KV_PRECONDITION_FAILED`) means the key exists
 * and the caller decides, by hash, whether that is its own earlier write.
 */
export function kvArtifactStore(kv: IKVService): ArtifactStore {
  return {
    async put(key, bytes, options) {
      const written = await kv.put(key, bytes.slice(), {
        ifNoneMatch: options.ifNoneMatch,
        contentType: options.contentType ?? "application/octet-stream",
      });
      if (written.ok) return "created";
      if (errorCode(written.error) === "KV_PRECONDITION_FAILED") return "exists";
      throw new ArtifactError("storage", `could not write ${key}: ${errorCode(written.error) ?? "unknown error"}`, { cause: written.error });
    },
    async get(key) {
      const read = await kv.get<Uint8Array>(key, { binary: true });
      if (read.ok) return new Uint8Array(read.data.data);
      if (errorCode(read.error) === "KV_NOT_FOUND") return undefined;
      throw new ArtifactError("storage", `could not read ${key}: ${errorCode(read.error) ?? "unknown error"}`, { cause: read.error });
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const listed = await kv.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
        if (!listed.ok) throw new ArtifactError("storage", `could not list ${prefix}: ${errorCode(listed.error) ?? "unknown error"}`, { cause: listed.error });
        keys.push(...listed.data.keys);
        if (listed.data.truncated !== true) return keys;
        if (listed.data.nextCursor === undefined) throw new ArtifactError("storage", `listing ${prefix} was truncated without a cursor`);
        cursor = listed.data.nextCursor;
      }
      throw new ArtifactError("storage", `listing ${prefix} exceeded ${MAX_LIST_PAGES} pages`);
    },
  };
}
