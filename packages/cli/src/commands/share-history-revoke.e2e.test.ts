import "../../../operations/test-support/test-bootstrap.mjs";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { profilePath, profileConfigPath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "../../../node-sdk/src/test-support/unregistered-location-registry";

const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const cliEntry = join(import.meta.dir, "../index.ts");
const BOOTSTRAP = join(import.meta.dir, "../../../operations/test-support/test-bootstrap.mjs");
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
describe.skipIf(!NODE_BIN)("share revoke by ID and history recover, against a real node", () => {
  const originalHome = process.env.HOME;
  const originalTcHome = process.env.TC_HOME;
  let root: string;
  let host: string;
  let home: string;
  let node: ChildProcess;
  let nodeClosed: Promise<void> | undefined;
  let registry: UnregisteredLocationRegistry | undefined;
  let shareConfig: ReturnType<typeof Bun.serve> | undefined;
  let shareConfigPreload: string;

  async function cli(args: string[]): Promise<Run> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      TC_HOME: home,
      TC500_SKIP_CLI_SENDER: "1",
    };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    const scopedArgs = args[0] === "init" ? ["init", "--name", "owner", ...args.slice(1)] : args;
    const preloads = ["--preload", BOOTSTRAP];
    if (args[0] === "share") {
      env.TC_SHARE_HISTORY_FIXTURE_CONFIG_ORIGIN = shareConfig!.url.origin;
      preloads.push("--preload", shareConfigPreload);
    }
    const child = Bun.spawn([process.execPath, ...preloads, cliEntry, "--host", host, "--profile", "owner", ...scopedArgs], {
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
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    process.env.TC_HOME = home;
    registry = await startUnregisteredLocationRegistry();
    shareConfig = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.method !== "GET" || new URL(request.url).pathname !== "/.well-known/tinycloud-share/config.json" || request.headers.has("authorization")) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({
          version: "tinycloud.share/config-v2",
          shareOrigin: "https://share.tinycloud.xyz",
          registryOrigin: registry!.url.origin,
          credentialsOrigin: shareConfig!.url.origin,
        });
      },
    });
    shareConfigPreload = join(root, "owned-share-config.ts");
    const adaptersPath = join(import.meta.dir, "../share/adapters.ts");
    await writeFile(shareConfigPreload, `import { mock } from "bun:test";
const path = ${JSON.stringify(adaptersPath)};
const original = await import(path);
const exports = { ...original };
const create = original.createShareAuthorityAdapters;
mock.module(path, () => ({
  ...exports,
  createShareAuthorityAdapters: (input = {}) => create({ ...input, origin: process.env.TC_SHARE_HISTORY_FIXTURE_CONFIG_ORIGIN }),
}));
`, { mode: 0o600 });
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
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TC_"))),
        HOME: home,
        TC_HOME: home,
        USERPROFILE: home,
        TINYCLOUD_STORAGE__DATADIR: join(root, "data"),
        ROCKET_PORT: String(port),
        ROCKET_ADDRESS: "127.0.0.1",
        TINYCLOUD_KEYS__TYPE: "Static",
        TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    nodeClosed = new Promise<void>((resolve) => node.once("close", () => resolve()));
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
    await withTinyCloudStateRoot(home, async () => {
      const path = profileConfigPath("owner");
      const profile: Record<string, unknown> = JSON.parse(await readFile(path, "utf8"));
      await writeJsonAtomic(path, { ...profile, tinycloudRegistryUrl: registry!.url.origin });
    });
    expect((await cli(["auth", "login", "--method", "local"])).exitCode).toBe(0);
  });

  afterAll(async () => {
    try {
      if (node && node.exitCode === null && node.signalCode === null) node.kill();
      const stopped = await Promise.allSettled([nodeClosed, registry?.stop(), shareConfig?.stop(true)]);
      const failed = stopped.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      try {
        if (root) await rm(root, { recursive: true, force: true });
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalTcHome === undefined) delete process.env.TC_HOME;
        else process.env.TC_HOME = originalTcHome;
      }
    }
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

  test("share history recover moves an unreadable local-owner history aside, and a new history starts", async () => {
    const cacheDir = await withTinyCloudStateRoot(home, async () => join(profilePath("owner"), "cache"));
    const historyFile = join(cacheDir, "share-history-v2.json");
    await writeFile(historyFile, "not-json-history");

    const recovered = await cli(["share", "history", "recover", "--json"]);
    expect(recovered.exitCode).toBe(0);

    const names = await readdir(cacheDir);
    expect(names).not.toContain("share-history-v2.json");
    const moved = names.filter((name) => name.startsWith("share-history-v2.json.unreadable-"));
    expect(moved).toHaveLength(1);
    expect(await readFile(join(cacheDir, moved[0]!), "utf8")).toBe("not-json-history");

    const shareId = await publish("after-recover.txt");
    const revoked = await cli(["share", "revoke", shareId, "--json"]);
    expect(revoked.exitCode).toBe(0);
    expect(revoked.json<RevokeOutput>().result.state).toBe("revoked");
  });

  test("share history recover maps a filesystem read failure to SHARE_HISTORY_RECOVER_FAILED and moves nothing", async () => {
    const cacheDir = await withTinyCloudStateRoot(home, async () => join(profilePath("owner"), "cache"));
    // A directory at the history path fails the read with a filesystem error, not a parse error.
    const historyPath = join(cacheDir, "share-history-v2.json");
    await rm(historyPath, { force: true });
    await mkdir(historyPath);
    const before = (await readdir(cacheDir)).sort();

    const failed = await cli(["share", "history", "recover", "--json"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("SHARE_HISTORY_RECOVER_FAILED");
    expect((await stat(historyPath)).isDirectory()).toBe(true);
    expect((await readdir(cacheDir)).sort()).toEqual(before);
  });
});
