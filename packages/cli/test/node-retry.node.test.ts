import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TC-1475 B2: the retry backoff must keep a one-shot *Node* process alive.
// bun's event loop hides an unref'd timer, so this runs the SDK + CLI error
// path under real `node` against a local HTTP server.

const dir = mkdtempSync(join(tmpdir(), "tc-node-retry-"));
const bundle = join(dir, "fixture.mjs");
const build = Bun.spawnSync(
  ["bun", "build", join(import.meta.dir, "node-retry.fixture.ts"), "--target=node", "--format=esm", `--outfile=${bundle}`],
  { stderr: "pipe" },
);
if (build.exitCode !== 0) throw new Error(`fixture build failed: ${build.stderr}`);

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function serve(busyResponses: number): Promise<{ url: string; requests: () => number }> {
  let count = 0;
  server = createServer((_req, res) => {
    count++;
    if (count <= busyResponses) {
      res.writeHead(503, { "retry-after": "1" }).end("sql_busy: begin: database is locked");
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify("hello"));
    }
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, requests: () => count };
}

async function runNode(url: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["node", bundle, url], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("kv get under real Node (retry backoff keeps the process alive)", () => {
  test("busy once then 200: retries, prints the value, exits 0, server saw 2 requests", async () => {
    const node = await serve(1);
    const { stdout, exitCode } = await runNode(node.url);
    expect(node.requests()).toBe(2);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ data: "hello" });
  }, 20_000);

  test("persistently busy: typed NODE_BUSY with the CLI node-error exit code", async () => {
    const node = await serve(Infinity);
    const { stdout, stderr, exitCode } = await runNode(node.url);
    expect(node.requests()).toBeGreaterThan(1);
    expect(exitCode).toBe(7);
    expect(stdout + stderr).toContain("NODE_BUSY");
  }, 40_000);

});
