import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishedShare, TargetPublishInput } from "@tinycloud/share-sdk";
import { configureShareCommandServices } from "./share.js";
import { runShareCaptured } from "./share.integration-harness.js";

const viewerOrigin = "https://share-dev.tinycloud.link";

/** The node refuses an upload body over 95 MiB (tinycloud-node MAX_UPLOAD_BODY_BYTES) with 413. A public share uploads the file's bytes unchanged. */
const NODE_UPLOAD_BODY_BYTES = 99_614_720;

function publishedFor(request: TargetPublishInput): PublishedShare {
  return {
    protocol: "tinycloud-share", version: 1, url: `${viewerOrigin}/viewer#tc1=opaque`,
    link: { kind: "native", cid: "bafy-native" },
    metadata: {
      protocol: "tinycloud-share", version: 1, shareId: "bafy-native", origin: viewerOrigin,
      target: { kind: "bearer", origin: "https://node.example", nodeAudience: "did:web:node.example", spaceId: "owner-space" },
      resource: { kind: "exact", path: `shares/bafy-native/${request.filename}` }, actions: ["read"],
      expiresAt: request.expiresAt.toISOString(), display: { filename: request.filename }, recipientMatcher: { kind: "bearer" },
      enforcementDelegationCid: "bafy-native",
    },
  };
}

/** handleError ends the process; record its exit code and let the action return instead. */
async function run(args: readonly string[]): Promise<{ exitCode: number | undefined; stderr: string; stdout: string }> {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
  try {
    const result = await runShareCaptured(["share", "publish", ...args, "--viewer-origin", viewerOrigin, "--json"]);
    return { exitCode: exitCode ?? result.exitCode, stderr: result.stderr, stdout: result.stdout };
  } finally { process.exit = originalExit; }
}

function errorOf(stderr: string): { code: string; message: string } {
  const start = stderr.lastIndexOf('{\n  "error"');
  return JSON.parse(stderr.slice(start)).error;
}

describe("the share size limit is the largest upload the node accepts", () => {
  let root: string;
  let published: TargetPublishInput[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tc-share-size-"));
    published = [];
    configureShareCommandServices({ targetAdapter: { publish: async (request) => { published.push(request); return publishedFor(request); } } });
  });
  afterEach(async () => {
    configureShareCommandServices({});
    await rm(root, { recursive: true, force: true });
  });

  async function fileOf(bytes: number): Promise<string> {
    const path = join(root, "big.md");
    await writeFile(path, "");
    await truncate(path, bytes);
    return path;
  }

  test("a file of exactly 95 MiB is published", async () => {
    const result = await run([await fileOf(NODE_UPLOAD_BODY_BYTES)]);
    expect(result.exitCode).toBe(0);
    expect(published).toHaveLength(1);
    expect((published[0]!.source as Uint8Array).byteLength).toBe(NODE_UPLOAD_BODY_BYTES);
  });

  test("one byte over 95 MiB is refused before anything is published, with the size message", async () => {
    const result = await run([await fileOf(NODE_UPLOAD_BODY_BYTES + 1)]);
    expect(result.exitCode).toBe(7);
    expect(errorOf(result.stderr)).toEqual({ code: "MAX_BYTES_EXCEEDED", message: "Shared files must be under 95 MB. Use a smaller file or split it." });
    expect(published).toHaveLength(0);
  });

  test("--max-bytes cannot raise the limit past 95 MiB", async () => {
    const result = await run([await fileOf(1), "--max-bytes", String(NODE_UPLOAD_BODY_BYTES + 1)]);
    expect(result.exitCode).toBe(7);
    expect(errorOf(result.stderr).message).toBe("max-bytes must be between 1 and 95 MiB");
    expect(published).toHaveLength(0);
  });
});
