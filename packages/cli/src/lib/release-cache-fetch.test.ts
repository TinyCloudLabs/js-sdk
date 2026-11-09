import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cachingFetch } from "./release-cache-fetch.js";
import type { FetchLike } from "./node-fetch.js";
import { buildArchivePins, type UpstreamRelease } from "./node-release-pin.js";
import { NODE_TARGETS } from "./node-release.js";

const URL_A = "https://github.com/TinyCloudLabs/tinycloud-node/releases/download/v1.21.0/sha256.sum";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "release-cache-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const counting = (responses: Response[]) => {
  const calls: string[] = [];
  const inner = (async (url: string) => { calls.push(url); return responses[Math.min(calls.length - 1, responses.length - 1)]!.clone(); }) as unknown as FetchLike;
  return { calls, inner };
};
const always = () => true;

describe("cachingFetch", () => {
  test("a miss fetches once and a repeat is served from the cache without a request", async () => {
    const { calls, inner } = counting([new Response("sums", { status: 200 })]);
    const fetchLike = cachingFetch({ dir, shouldCache: always, inner });
    expect(await (await fetchLike(URL_A, {})).text()).toBe("sums");
    expect(await (await fetchLike(URL_A, {})).text()).toBe("sums");
    expect(calls).toEqual([URL_A]);
  });

  test("a failed response is returned but never cached", async () => {
    const { calls, inner } = counting([new Response("gateway", { status: 504 }), new Response("sums", { status: 200 })]);
    const fetchLike = cachingFetch({ dir, shouldCache: always, inner });
    expect((await fetchLike(URL_A, {})).status).toBe(504);
    expect(await (await fetchLike(URL_A, {})).text()).toBe("sums");
    expect(calls.length).toBe(2);
    expect((await readdir(dir)).length).toBe(1);
  });

  test("URLs outside the cached set are always fetched", async () => {
    const { calls, inner } = counting([new Response("x", { status: 200 })]);
    const fetchLike = cachingFetch({ dir, shouldCache: () => false, inner });
    await fetchLike(URL_A, {});
    await fetchLike(URL_A, {});
    expect(calls.length).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a tampered cached checksum file is rejected by the pin builder", async () => {
    const release: UpstreamRelease = {
      tag_name: "v1.21.0", draft: false, prerelease: false,
      assets: NODE_TARGETS.map((target) => ({ name: `tinycloud-node-${target}.tar.xz`, size: 10, digest: `sha256:${"a".repeat(64)}` })),
    };
    const good = NODE_TARGETS.map((target) => `${"a".repeat(64)} *tinycloud-node-${target}.tar.xz`).join("\n");
    const bad = good.replace("a".repeat(64), "b".repeat(64));
    const key = createHash("sha256").update(URL_A).digest("hex");
    await writeFile(join(dir, key), bad);
    const fetchLike = cachingFetch({ dir, shouldCache: always, inner: async () => { throw new Error("network must not be used"); } });
    const sums = await (await fetchLike(URL_A, {})).text();
    expect(() => buildArchivePins("1.21.0", release, good)).not.toThrow();
    expect(() => buildArchivePins("1.21.0", release, sums)).toThrow(/disagrees with the GitHub asset digest/);
  });
});
