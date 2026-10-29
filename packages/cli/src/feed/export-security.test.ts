import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, access, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ServiceContext } from "../../../sdk-services/src/context";
import { KVService } from "../../../sdk-services/src/kv/KVService";
import { exportFeedRawSnapshot } from "./export";
import type { FeedRawSnapshot } from "./export-types";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sourceSpace = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications";
const prefix = "fixture/raw-security/";
const sourceKey = `${prefix}raw-value`;
const value = new Uint8Array([0xff, 0x00, 0x81, 0x41]);
const sentinel = "Unrelated owner file; never cleanup this entry.\n";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tc2209-export-security-"));
  await chmod(directory, 0o700);
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const action = request.headers.get("x-fixture-action") ?? "";
    const path = decodeURIComponent(request.headers.get("x-fixture-path") ?? "");
    calls.push(action);
    if (action === "tinycloud.kv/sync" && path === prefix) {
      return Response.json({
        changes: request.headers.has("x-tinycloud-cursor") ? [] : [{ key: sourceKey, deleted: false, etag: '"raw-security-etag"', metadata: {} }],
        more: false, cursor: "raw-security-opaque-end",
        source: { nodeDid: "did:key:raw-security", space: sourceSpace, prefix },
        authority: { notBefore: null, expiresAt: null, retainUntil: null },
      });
    }
    if (action === "tinycloud.kv/get" && path === sourceKey) {
      return new Response(value, { headers: { ETag: '"raw-security-etag"', "Content-Type": "application/json" } });
    }
    return new Response("Fixture operation denied", { status: 403 });
  } });
  cleanup.push(() => server.stop(true));
  const context = new ServiceContext({
    hosts: [server.url.href], retryPolicy: { maxAttempts: 1 },
    invoke: (_active, _service, path, action) => ({ Authorization: "test-invocation", "x-fixture-action": action, "x-fixture-path": encodeURIComponent(path) }),
    session: { delegationHeader: { Authorization: "test-invocation" }, delegationCid: "test-cid", spaceId: sourceSpace, verificationMethod: "did:key:test", jwk: {} },
  });
  const kv = new KVService(); kv.initialize(context);
  return { directory, calls, options: (outputDirectory: string) => ({ kv, sourceSpace, prefix, outFile: join(outputDirectory, "snapshot.json") }) };
}

async function expectTrustedCapture(options: Parameters<typeof exportFeedRawSnapshot>[0]): Promise<void> {
  const receipt = await exportFeedRawSnapshot(options);
  const snapshot: FeedRawSnapshot = JSON.parse(await readFile(options.outFile, "utf8"));
  expect(snapshot.rows).toEqual([{ sourceKey, sourceArea: "kv", encoding: "base64", rawBase64: Buffer.from(value).toString("base64"),
    sha256: createHash("sha256").update(value).digest("hex"), etag: '"raw-security-etag"', metadata: {} }]);
  expect(snapshot.source.completePrefixSnapshot).toBe(true);
  expect(snapshot.proof.tail.cursor).toBe(snapshot.source.cursor);
  expect(receipt.rowCount).toBe(1);
  expect((await stat(options.outFile)).mode & 0o777).toBe(0o600);
}

test("group/world-writable output directories are refused before source capture and preserve unrelated files", async () => {
  for (const mode of [0o770, 0o777, 0o1777]) {
    const f = await fixture();
    const output = join(f.directory, "shared-output");
    await mkdir(output); await chmod(output, mode);
    const unrelated = join(output, "unrelated-owner-file");
    await writeFile(unrelated, sentinel, { mode: 0o600 });
    const options = f.options(output);
    const result = await exportFeedRawSnapshot(options).then(() => ({ ok: true }), () => ({ ok: false }));
    expect(result.ok).toBe(false);
    expect(f.calls).toEqual([]);
    expect(await exists(options.outFile)).toBe(false);
    expect(await readFile(unrelated, "utf8")).toBe(sentinel);
  }
});

test("a private owned leaf beneath a nonsticky writable ancestor is refused before capture", async () => {
  for (const mode of [0o770, 0o777]) {
    const f = await fixture();
    const shared = join(f.directory, "unsafe-ancestor");
    const output = join(shared, "owned-leaf");
    await mkdir(shared); await chmod(shared, mode);
    await mkdir(output, { mode: 0o700 });
    const unrelated = join(output, "unrelated-owner-file");
    await writeFile(unrelated, sentinel, { mode: 0o600 });
    const options = f.options(output);
    const result = await exportFeedRawSnapshot(options).then(() => ({ ok: true }), () => ({ ok: false }));
    expect(result.ok).toBe(false);
    expect(f.calls).toEqual([]);
    expect(await exists(options.outFile)).toBe(false);
    expect(await readFile(unrelated, "utf8")).toBe(sentinel);
  }
});

test("a trusted owned sticky temporary parent protects its private owned output leaf", async () => {
  const f = await fixture();
  const shared = join(f.directory, "trusted-sticky-parent");
  const output = join(shared, "owned-leaf");
  await mkdir(shared);
  execFileSync("chmod", ["1777", shared]);
  expect((await stat(shared)).mode & 0o1000).toBe(0o1000);
  await mkdir(output, { mode: 0o700 });
  expect((await stat(output)).uid).toBe(process.geteuid!());
  await expectTrustedCapture(f.options(output));
});

test("an ordinary private owned output directory still publishes the exact raw bytes", async () => {
  const f = await fixture();
  expect((await stat(f.directory)).uid).toBe(process.geteuid!());
  await expectTrustedCapture(f.options(f.directory));
});

test("a trusted owner-controlled ancestor alias preserves access to a private owned output leaf", async () => {
  const f = await fixture();
  const physical = join(f.directory, "physical");
  await mkdir(physical, { mode: 0o700 });
  await mkdir(join(physical, "owned-leaf"), { mode: 0o700 });
  const alias = join(f.directory, "owned-alias");
  await symlink(physical, alias, "dir");
  await expectTrustedCapture(f.options(join(alias, "owned-leaf")));
});

test("an owned alias cannot conceal an unsafe physical ancestor from the output guard", async () => {
  const f = await fixture();
  const physical = join(f.directory, "unsafe-physical");
  await mkdir(physical);
  await chmod(physical, 0o777);
  await mkdir(join(physical, "owned-leaf"), { mode: 0o700 });
  const alias = join(f.directory, "owned-alias");
  await symlink(physical, alias, "dir");
  const options = f.options(join(alias, "owned-leaf"));
  await expect(exportFeedRawSnapshot(options)).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect(await exists(options.outFile)).toBe(false);
});

test("a replaceable intermediate alias is refused even when the spelled and final paths are trusted", async () => {
  const f = await fixture();
  await chmod(f.directory, 0o755);
  const physical = join(f.directory, "private");
  await mkdir(physical, { mode: 0o700 });
  await mkdir(join(physical, "owned-leaf"), { mode: 0o700 });
  const shared = join(f.directory, "shared-open");
  await mkdir(shared);
  await chmod(shared, 0o777);
  const bridge = join(shared, "bridge");
  await symlink(physical, bridge, "dir");
  const alias = join(f.directory, "protected-alias");
  await symlink(bridge, alias, "dir");
  const options = f.options(join(alias, "owned-leaf"));
  await expect(exportFeedRawSnapshot(options)).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect(await exists(options.outFile)).toBe(false);
});

test("trusted intermediate relative aliases preserve their private owned destination", async () => {
  const f = await fixture();
  const physical = join(f.directory, "private");
  await mkdir(physical, { mode: 0o700 });
  await mkdir(join(physical, "owned-leaf"), { mode: 0o700 });
  const bridgeDirectory = join(f.directory, "trusted-bridge");
  await mkdir(bridgeDirectory, { mode: 0o700 });
  await symlink("../private", join(bridgeDirectory, "bridge"), "dir");
  const alias = join(f.directory, "protected-alias");
  await symlink("trusted-bridge/bridge", alias, "dir");
  await expectTrustedCapture(f.options(join(alias, "owned-leaf")));
});
