import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const NODE_RUNTIME = process.env.CLI_NODE_BINARY ?? "node";
// The acceptance gate for the packed CLI bundle: this test exercises the real
// dist artifact, not the TypeScript entry point, so a bundler-time identifier
// rename (1.6.3's unbound SHARE_PUBLISH_RESULT_VERSION) fails here.
const distEntry = join(import.meta.dir, "../../dist/index.js");
setDefaultTimeout(120_000);

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  json<T>(): T;
}

interface PublishOutput {
  readonly metadata: { readonly shareId: string };
  readonly url?: string;
}

describe.skipIf(!NODE_BIN)("share publish and receive through the packed dist, against a real node", () => {
  let root: string;
  let host: string;
  let home: string;
  let node: ChildProcess;

  async function cli(args: string[]): Promise<Run> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      TC_HOME: home,
      TC500_SKIP_CLI_SENDER: "1",
    };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    const child = Bun.spawn(
      [NODE_RUNTIME, distEntry, "--host", host, "--profile", "owner", ...args],
      { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode, stdout, stderr, json: <T>() => JSON.parse(stdout) as T };
  }

  test("the packed bundle binds one SHARE_PUBLISH_RESULT_VERSION", async () => {
    const built = await readFile(distEntry, "utf8");
    // A bundler rename emits a suffixed top-level declaration and left 1.6.3's
    // native publish use unbound. Every spelled-out identifier must be the
    // unsuffixed name, and it must be declared.
    const identifiers = new Set(built.match(/\bSHARE_PUBLISH_RESULT_VERSION\d*\b/g) ?? []);
    expect([...identifiers]).toEqual(["SHARE_PUBLISH_RESULT_VERSION"]);
    expect(built).toMatch(/\b(?:const|var|let)\s+SHARE_PUBLISH_RESULT_VERSION\s*=/);
  });

  describe("with a signed-in local owner", () => {
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "tc-share-dist-e2e-"));
      home = join(root, "home-owner");
      const portReady = Promise.withResolvers<number>();
      const server = createServer();
      server.once("error", portReady.reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          portReady.reject(new Error("no port"));
          return;
        }
        server.close(() => portReady.resolve(address.port));
      });
      const port = await portReady.promise;
      host = `http://127.0.0.1:${port}`;
      node = spawn(NODE_BIN!, [], {
        cwd: root,
        env: {
          ...process.env,
          TINYCLOUD_STORAGE__DATADIR: join(root, "data"),
          ROCKET_PORT: String(port),
          ROCKET_ADDRESS: "127.0.0.1",
          TINYCLOUD_KEYS__TYPE: "Static",
          TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const launched = Promise.withResolvers<void>();
      let output = "";
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("Rocket has launched")) launched.resolve();
      };
      node.stdout!.on("data", onData);
      node.stderr!.on("data", onData);
      node.once("error", (error) => launched.reject(error));
      await launched.promise;

      expect((await cli(["init", "--key-only"])).exitCode).toBe(0);
      expect((await cli(["auth", "login", "--method", "local"])).exitCode).toBe(0);
    });

    afterAll(async () => {
      node?.kill();
      if (root) await rm(root, { recursive: true, force: true });
    });

    test("a native bearer share publish succeeds and its link receives", async () => {
      const file = join(root, "dist-publish.txt");
      await writeFile(file, "packed dist share\n");
      // --json redacts the link, so publish once without it to capture the URL
      // a real user would pass to `share receive`.
      const human = await cli(["share", "publish", file]);
      expect(human.stderr).not.toContain("SHARE_PUBLISH_RESULT_VERSION");
      expect(human.exitCode).toBe(0);
      const url = human.stdout.trim();
      expect(url).toContain("/viewer#tc1=");

      const published = await cli(["share", "publish", file, "--json"]);
      expect(published.exitCode).toBe(0);
      expect(published.json<PublishOutput>().metadata.shareId.length).toBeGreaterThan(0);

      const received = await cli(["share", "receive", url, "--json"]);
      expect(received.stderr).not.toContain("SHARE_PUBLISH_RESULT_VERSION");
      expect(received.exitCode).toBe(0);
    });
  });
});
