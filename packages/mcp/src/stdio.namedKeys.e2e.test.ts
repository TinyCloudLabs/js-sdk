import "../../operations/test-support/test-bootstrap.mjs";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { assertPrivateTestEnvironment } from "../../operations/test-support/private-home.mjs";
import { startUnregisteredLocationRegistry } from "../../node-sdk/src/test-support/unregistered-location-registry";
import type { UnregisteredLocationRegistry } from "../../node-sdk/src/test-support/unregistered-location-registry";

// TC-3284 ruling 4 / TC-3852: a real tinycloud-node with per-secret keys (`named_keys_v1`), and a delegate that reads
// a secret on its own key through the MCP server: the agent's `tinycloud_secrets_get` asks for what it needs, the owner
// approves exactly that with `tc auth grant`, the agent imports the grant, and a restarted MCP process returns the
// value. Skipped without TC_NAMED_KEYS_E2E_NODE_BIN (the lane `named-keys-node-e2e` sets it and fails on any skip).
const NODE_BIN = process.env.TC_NAMED_KEYS_E2E_NODE_BIN;
setDefaultTimeout(180_000);

const packageDirectory = new URL("..", import.meta.url).pathname;
const mcpCliPath = join(packageDirectory, "dist/cli.js");
const tinycloudCliPath = join(packageDirectory, "../cli/dist/index.js");
const nodeBinary = process.env.NODE_BINARY ?? "node";

function privateEnvironment(home: string): Record<string, string | undefined> {
  const bootstrap = new URL("../../operations/test-support/test-bootstrap.mjs", import.meta.url).href;
  const environment = {
    ...process.env,
    HOME: home,
    TC_HOME: home,
    USERPROFILE: home,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${bootstrap}`.trim(),
  };
  delete environment.TC_HOST;
  delete environment.TC_PRIVATE_KEY;
  assertPrivateTestEnvironment(environment, home);
  return environment;
}

async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
  return promise;
}

function contentOf(result: { structuredContent?: unknown | null }): Record<string, any> | undefined {
  return result.structuredContent as Record<string, any> | undefined;
}

interface ConnectedClient {
  readonly client: Client;
  readonly stderr: () => string;
}

describe.skipIf(!NODE_BIN)("MCP reads a secret on its own key against a real node", () => {
  const root = join(tmpdir(), `tc-mcp-named-keys-${randomBytes(6).toString("hex")}`);
  const home = join(root, "home");
  let node: ChildProcess | undefined;
  let registry: UnregisteredLocationRegistry;
  let host: string;
  const open: ConnectedClient[] = [];

  async function tc(args: string[], stdin?: unknown): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([nodeBinary, tinycloudCliPath, "--json", "--quiet", ...args], {
      env: privateEnvironment(home),
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
      child.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  async function ok(args: string[], stdin?: unknown): Promise<string> {
    const run = await tc(args, stdin);
    // `tc auth grant` prints what it approves on stderr, so only the exit code is checked here.
    expect({ args, exitCode: run.exitCode, stderr: run.exitCode === 0 ? "" : run.stderr }).toEqual({ args, exitCode: 0, stderr: "" });
    return run.stdout;
  }

  async function connect(profile: string): Promise<ConnectedClient> {
    const transport = new StdioClientTransport({
      command: nodeBinary,
      args: [mcpCliPath, "--profile", profile],
      env: privateEnvironment(home) as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "tinycloud-mcp-named-keys-e2e", version: "0.0.0" });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    await client.connect(transport);
    const connected = { client, stderr: () => stderr };
    open.push(connected);
    return connected;
  }

  async function profileConfig(name: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(home, ".tinycloud/profiles", name, "profile.json"), "utf8"));
  }

  async function useRegistry(name: string): Promise<void> {
    await writeFile(
      join(home, ".tinycloud/profiles", name, "profile.json"),
      JSON.stringify({ ...await profileConfig(name), tinycloudRegistryUrl: registry.url.origin }, null, 2),
    );
  }

  beforeAll(async () => {
    await mkdir(join(root, "node", "data"), { recursive: true });
    await mkdir(home, { recursive: true });
    const port = await freePort();
    host = `http://127.0.0.1:${port}`;
    registry = startUnregisteredLocationRegistry();
    node = spawn(NODE_BIN!, [], {
      cwd: join(root, "node"),
      env: {
        PATH: process.env.PATH, HOME: home, TMPDIR: root,
        TINYCLOUD_STORAGE__DATADIR: join(root, "node", "data"),
        TINYCLOUD_PORT: String(port), TINYCLOUD_ADDRESS: "127.0.0.1", ROCKET_PORT: String(port), ROCKET_ADDRESS: "127.0.0.1",
        TINYCLOUD_KEYS__TYPE: "Static", TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
        TINYCLOUD_ENCRYPTION_NETWORK__NAMED_KEYS_V1: "true",
        TINYCLOUD_ENCRYPTION_NETWORK__DELETION_LEDGER_PATH: join(root, "node", "ledger"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launched = Promise.withResolvers<void>();
    let window = "";
    const onData = (chunk: Buffer) => {
      window = (window + chunk.toString()).slice(-128);
      if (window.includes("Rocket has launched")) launched.resolve();
    };
    node.stdout?.on("data", onData);
    node.stderr?.on("data", onData);
    node.once("close", (code) => launched.reject(new Error(`node exited before launch (${code})`)));
    await launched.promise;

    // A local-key owner hosts the space and creates the default encryption network.
    await ok(["--profile", "owner", "--host", host, "init", "--name", "owner", "--key-only"]);
    await useRegistry("owner");
    await ok(["--profile", "owner", "--host", host, "auth", "login", "--method", "local"]);
    await ok(["--profile", "owner", "--host", host, "secrets", "network", "init"]);
  });

  afterAll(async () => {
    await Promise.all(open.splice(0).map(({ client }) => client.close().catch(() => undefined)));
    node?.kill("SIGTERM");
    registry?.stop?.();
    await rm(root, { recursive: true, force: true });
  });

  test("the agent's MCP get asks for the secret's own key, the owner grants exactly that, and a restarted MCP returns the value", async () => {
    const value = `mcp-${randomBytes(12).toString("hex")}`;
    await ok(["--profile", "owner", "secrets", "put", "MCP_V2", "--stdin"], value);
    await ok(["profile", "create", "agent", "--posture", "delegate-session", "--host", host, "--registry-url", registry.url.origin]);

    // A fresh delegate has no session until it files its first request: it asks for the record read through the CLI,
    // as an agent set up for secrets does, and the owner approves it.
    const { spaceId } = await profileConfig("owner") as { spaceId?: string };
    expect(spaceId).toEqual(expect.stringMatching(/^tinycloud:/));
    const kvRequestFile = join(root, "agent-kv-request.json");
    const kvGrantFile = join(root, "agent-kv-grant.json");
    await ok(["--profile", "agent", "auth", "request", "--cap", `tinycloud.kv:${spaceId}:vault/secrets/MCP_V2:get`, "--emit", kvRequestFile]);
    await writeFile(kvGrantFile, await ok(["--profile", "owner", "auth", "grant", kvRequestFile]));
    await ok(["--profile", "agent", "auth", "import", kvGrantFile]);

    // Each round: a fresh MCP process asks, the owner grants what it asked for, a second process imports the grant.
    // The agent needs the record read and the secret's own key, so it may take more than one round.
    const requestedEncryption: Array<{ path?: string; actions?: string[] }> = [];
    let read: Record<string, any> | undefined;
    let stderr = "";
    for (let round = 0; round < 4 && read === undefined; round += 1) {
      const asking = await connect("agent");
      const result = await asking.client.callTool({ name: "tinycloud_secrets_get", arguments: { name: "MCP_V2" } });
      await asking.client.close();
      const body = contentOf(result)!;
      stderr += asking.stderr();
      if (body.status === "ok") { read = body; break; }
      expect({ round, status: body.status, error: body.error }).toEqual({ round, status: "authority_required", error: undefined });
      const request = body.request as {
        requestId: string;
        requested: Array<{ service: string; path?: string; actions?: string[] }>;
      };
      requestedEncryption.push(...request.requested.filter((entry) => entry.service === "tinycloud.encryption"));

      const grant = JSON.parse(await ok(["--profile", "owner", "auth", "grant", "--stdin", "--yes"], request));
      expect(grant).toMatchObject({ kind: "tinycloud.auth.delegation", requestId: request.requestId });
      const importing = await connect("agent");
      const imported = await importing.client.callTool({ name: "tinycloud_auth_import", arguments: grant });
      await importing.client.close();
      stderr += importing.stderr();
      expect(contentOf(imported)).toMatchObject({ status: "ok", output: { activated: true } });
    }

    expect(read).toBeDefined();
    expect(JSON.stringify(read)).toContain(value);
    // The agent only ever asked for the secret's own key: never the network root, never a `secrets/` prefix.
    expect(requestedEncryption.map((entry) => entry.path)).toEqual([
      expect.stringMatching(/^urn:tinycloud:encryption:did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}:default\/secrets\/mcp_v2$/),
    ]);
    expect(requestedEncryption[0]!.actions).toEqual(["tinycloud.encryption/decrypt"]);
    // The value reaches only the tool result, never the MCP process's stderr.
    expect(stderr).not.toContain(value);
  });
});
