import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// The runtime caches a module that failed to load, so the failure is staged in a child process of its own:
// a Bun plugin fails the load of `secret-read.ts`, and the child reads a secret through a node whose vault
// read succeeds.
const CHILD = `
let loads = 0;
Bun.plugin({
  name: "fail-secret-read-load",
  setup(build) {
    build.onLoad({ filter: /[\\\\/]secret-read\\.ts$/ }, () => {
      loads += 1;
      throw new Error("Loading chunk secret-read failed.");
    });
  },
});
const { TinyCloudNode } = await import(process.argv[1]);
let reads = 0;
const node = Object.create(TinyCloudNode.prototype);
Object.assign(node, {
  _spaceService: {},
  getBaseVault: () => ({
    readNetworkEncrypted: async () => {
      reads += 1;
      return {
        status: "ok",
        entry: {
          value: {
            value: "secret value",
            createdAt: "2026-07-15T00:00:00.000Z",
            updatedAt: "2026-07-15T00:00:00.000Z",
          },
        },
      };
    },
  }),
});
const outcome = await node
  .readSecret({
    space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:target-secrets",
    name: "API_KEY",
  })
  .then((result) => ({ result }), (error) => ({ rejected: String(error) }));
console.log(JSON.stringify({ ...outcome, reads, loads }));
`;

test("readSecret resolves to read_failed when its first-use file fails to load after the read", async () => {
  const child = Bun.spawn(
    [process.execPath, "-e", CHILD, fileURLToPath(new URL("./TinyCloudNode.ts", import.meta.url))],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  const last = stdout.trim().split("\n").at(-1) ?? "";
  expect(JSON.parse(last)).toEqual({ result: { status: "read_failed" }, reads: 1, loads: 1 });
}, 60_000);
