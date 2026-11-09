// A fetch wrapper for `scripts/generate-node-release.ts` that keeps successful
// responses for chosen URLs on disk, so a run with a warm cache makes no
// request to GitHub releases. It only changes where the bytes come from: the
// generator still compares everything it reads with the pin, and archives are
// still checked against their pinned size and SHA-256 by `measureNodeBinary`,
// so a stale or altered cache entry fails the check.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FetchLike } from "./node-fetch.js";

export interface CachingFetchOptions {
  /** Directory holding one file per cached URL, named by the SHA-256 of the URL. */
  dir: string;
  /** True for the URLs whose responses are kept; every other URL goes straight to `inner`. */
  shouldCache: (url: string) => boolean;
  /** Transport used on a miss. Defaults to the global `fetch`. */
  inner?: FetchLike;
}

const entryName = (url: string) => createHash("sha256").update(url).digest("hex");

const bodyResponse = (bytes: Uint8Array) =>
  new Response(bytes, { status: 200, headers: { "content-length": String(bytes.byteLength) } });

export function cachingFetch({ dir, shouldCache, inner = (url, init) => fetch(url, init) }: CachingFetchOptions): FetchLike {
  return async (url, init) => {
    if (!shouldCache(url)) return inner(url, init);
    const file = join(dir, entryName(url));
    try {
      return bodyResponse(await readFile(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // The cache holds the final body, so redirects are followed here and the entry is keyed by the original URL.
    const response = await inner(url, { ...init, redirect: "follow" });
    if (!response.ok) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(dir, { recursive: true });
    const staged = `${file}.${randomUUID()}.tmp`;
    await writeFile(staged, bytes);
    await rename(staged, file);
    return bodyResponse(bytes);
  };
}
