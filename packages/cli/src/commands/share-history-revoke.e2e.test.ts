import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const cliEntry = join(import.meta.dir, "../index.ts");
// Each test starts several CLI processes against a real node.
setDefaultTimeout(120_000);

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  json<T>(): T;
}

interface PublishOutput {
  readonly metadata: { readonly shareId: string };
}

interface RevokeOutput {
  readonly result: { readonly state: string };
}

// Covers a local-owner profile: its sender share history is keyed by the local private key, which survives logout and
// re-login, so a Share published before either can still be revoked by ID. The OpenKey-recorded history path is covered
// by adapters.test.ts and auth-logout-history-guard.integration.test.ts.
describe.skipIf(!NODE_BIN)("share revoke by ID across re-login and logout, against a real node", () => {
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
    const child = Bun.spawn([process.execPath, cliEntry, "--host", host, "--profile", "owner", ...args], {
      env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    // The CLI emits this JSON itself; each caller names the shape it asserts on.
    return { exitCode, stdout, stderr, json: <T>() => JSON.parse(stdout) as T };
  }

  async function publish(name: string): Promise<string> {
    const file = join(root, name);
    await writeFile(file, `${name}\n`);
    const published = await cli(["share", "publish", file, "--json"]);
    expect(published.exitCode).toBe(0);
    return published.json<PublishOutput>().metadata.shareId;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tc-share-revoke-e2e-"));
    home = join(root, "home-owner");
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") return reject(new Error("no port"));
        server.close(() => resolve(address.port));
      });
    });
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

    await mkdir(home, { recursive: true });
    expect((await cli(["init", "--key-only"])).exitCode).toBe(0);
    expect((await cli(["auth", "login", "--method", "local"])).exitCode).toBe(0);
  });

  afterAll(async () => {
    node?.kill();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("a share published before a plain re-login can be revoked by ID after it", async () => {
    const shareId = await publish("before-relogin.txt");
    expect((await cli(["auth", "login", "--method", "local"])).exitCode).toBe(0);

    const revoked = await cli(["share", "revoke", shareId, "--json"]);
    expect(revoked.exitCode).toBe(0);
    expect(revoked.json<RevokeOutput>().result.state).toBe("revoked");
  });

  test("a local-owner profile revokes by ID after logout and login", async () => {
    const shareId = await publish("before-logout.txt");
    expect((await cli(["auth", "logout"])).exitCode).toBe(0);
    expect((await cli(["auth", "login", "--method", "local"])).exitCode).toBe(0);

    const revoked = await cli(["share", "revoke", shareId, "--json"]);
    expect(revoked.exitCode).toBe(0);
    expect(revoked.json<RevokeOutput>().result.state).toBe("revoked");
  });
});
