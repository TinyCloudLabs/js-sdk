import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { activateSessionWithHost } from "@tinycloud/sdk-core";

// Real-node e2e for `tinycloud onboard`. A fresh home runs it as an agent
// would: each run prints the next OpenKey link and exits 8, and the next run
// gets the code OpenKey shows. A stand-in OpenKey answers each link as the
// approval page does: the owner wallet signs exactly the requested scope for
// the requested lifetime, the session is activated at the node, and the full
// delegation code is what the owner pastes back.
const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const cliEntry = join(import.meta.dir, "../index.ts");
const THIRTY_DAYS_S = 30 * 86400;
setDefaultTimeout(240_000);

describe.skipIf(!NODE_BIN)("tinycloud onboard, against a real node", () => {
  let root: string;
  let host: string;
  let node: ChildProcess;
  let ownerSigner: PrivateKeySigner;
  const wasm = new NodeWasmBindings();
  const home = (name: string) => join(root, `home-${name}`);

  async function cli(name: string, args: string[]) {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home(name), TC_HOME: home(name) };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    delete env.TC_OPENKEY_HOST;
    delete env.TC_PROFILE;
    const child = Bun.spawn([process.execPath, cliEntry, "--host", host, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  /** What OpenKey's approval page returns for this link, signed by `signer`, as a pasteable code. */
  async function approve(approvalUrl: string, signer: PrivateKeySigner): Promise<{ code: string; requested: PermissionEntry[]; expiry: string }> {
    const params = new URL(approvalUrl).searchParams;
    const jwk = JSON.parse(Buffer.from(params.get("jwk")!, "base64url").toString()) as object;
    // The CLI's own request, as OpenKey decodes it from the link.
    const request: { permissions: PermissionEntry[] } = JSON.parse(Buffer.from(params.get("permissions")!, "base64url").toString());
    const requested = request.permissions;
    const expiry = params.get("expiry") ?? "";
    const abilities: Record<string, Record<string, string[]>> = {};
    for (const p of requested) {
      const service = p.service.slice("tinycloud.".length);
      abilities[service] = { ...abilities[service], [p.path]: [...new Set([...(abilities[service]?.[p.path] ?? []), ...p.actions])] };
    }
    const address = await signer.getAddress();
    const spaceId = wasm.makeSpaceId(address, 1, requested[0]!.space!.split(":").at(-1)!);
    const now = Date.now();
    const prepared = wasm.prepareSession({
      abilities,
      address,
      chainId: 1,
      domain: "cli.tinycloud.xyz",
      spaceId,
      jwk,
      issuedAt: new Date(now).toISOString(),
      expirationTime: new Date(now + Number(expiry.replace(/s$/, "")) * 1000).toISOString(),
    });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    await activateSessionWithHost(host, session.delegationHeader);
    const payload = { ...session, address, chainId: 1, spaceId, verificationMethod: params.get("did"), siwe: prepared.siwe, signature };
    return { code: Buffer.from(JSON.stringify(payload)).toString("base64"), requested, expiry };
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tc-onboard-e2e-"));
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
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
    await launched.promise;

    // OpenKey hosts a new owner's spaces when they first approve; here the owner wallet hosts them.
    await mkdir(home("wallet"), { recursive: true });
    expect((await cli("wallet", ["init", "--key-only"])).exitCode).toBe(0);
    expect((await cli("wallet", ["auth", "login", "--method", "local"])).exitCode).toBe(0);
    for (const space of ["applications", "account"]) {
      expect((await cli("wallet", ["auth", "request", "--cap", `tinycloud.kv:${space}::get,list,put,del`, "--grant", "--yes"])).exitCode).toBe(0);
      expect((await cli("wallet", ["space", "create", space])).exitCode).toBe(0);
    }
    expect((await cli("wallet", ["kv", "put", "--space", "account", "spaces/applications", "hosted"])).exitCode).toBe(0);
    let ownerKey = "";
    for await (const file of new Bun.Glob("**/profile.json").scan({ cwd: home("wallet"), dot: true, absolute: true })) {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (parsed && typeof parsed === "object" && "privateKey" in parsed && typeof parsed.privateKey === "string") ownerKey = parsed.privateKey;
    }
    ownerSigner = new PrivateKeySigner(ownerKey.replace(/^0x/, ""));
  });

  afterAll(async () => {
    node?.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });

  test("a fresh home: two approvals, each for one space and 30 days; the grant does exactly what it names", async () => {
    await mkdir(home("agent"), { recursive: true });
    const first = await cli("agent", ["onboard"]);
    expect(first.exitCode).toBe(8);
    const step1 = JSON.parse(first.stdout) as { onboarded: boolean; profile: string; step: number; steps: number; approvalUrl: string };
    expect(step1).toMatchObject({ onboarded: false, profile: "default", step: 1, steps: 2 });
    // The same request until the owner approves: rerunning doesn't change the link.
    expect(JSON.parse((await cli("agent", ["onboard"])).stdout).approvalUrl).toBe(step1.approvalUrl);

    const approval1 = await approve(step1.approvalUrl, ownerSigner);
    expect(approval1.expiry).toBe(`${THIRTY_DAYS_S}s`);
    expect(new Set(approval1.requested.map((p) => p.space))).toEqual(new Set(["applications"]));
    const second = await cli("agent", ["onboard", "--code", approval1.code]);
    expect(second.exitCode).toBe(8);
    const step2 = JSON.parse(second.stdout) as { step: number; approvalUrl: string };
    expect(step2.step).toBe(2);

    const approval2 = await approve(step2.approvalUrl, ownerSigner);
    expect(approval2.expiry).toBe(`${THIRTY_DAYS_S}s`);
    expect(approval2.requested.filter((p) => p.service === "tinycloud.kv").map((p) => [p.path, p.actions])).toEqual([
      ["spaces/", ["tinycloud.kv/get", "tinycloud.kv/list"]],
      ["applications/", ["tinycloud.kv/get", "tinycloud.kv/list"]],
    ]);
    const done = await cli("agent", ["onboard", "--code", approval2.code]);
    expect(done.exitCode).toBe(0);
    const result = JSON.parse(done.stdout) as { onboarded: boolean; ownerDid: string };
    expect(result.onboarded).toBe(true);
    expect(result.ownerDid.toLowerCase()).toBe(`did:pkh:eip155:1:${(await ownerSigner.getAddress()).toLowerCase()}`);

    // Done stays done: no new link.
    expect((await cli("agent", ["onboard"])).exitCode).toBe(0);

    expect((await cli("agent", ["kv", "put", "--space", "applications", "onboard/note", "hello"])).exitCode).toBe(0);
    expect((await cli("agent", ["kv", "get", "--space", "applications", "onboard/note"])).stdout).toContain("hello");
    expect((await cli("agent", ["kv", "get", "--space", "account", "spaces/applications"])).stdout).toContain("hosted");
    // One approval covers a Health Log SQL write and read on the applications space, and `auth caps --diff` sees it.
    const healthDb = "xyz.tinycloud.sample.healthlog/healthlog";
    const caps = await cli("agent", ["auth", "caps", "--diff", `tinycloud.sql:applications:${healthDb}:read,write`]);
    expect(JSON.parse(caps.stdout)).toMatchObject({ covered: true });
    // Health Log's table is made by its install, which holds the schema grant onboarding doesn't give; the owner wallet stands in for it.
    expect((await cli("wallet", ["auth", "request", "--cap", `tinycloud.sql:applications:${healthDb}:schema,write`, "--grant", "--yes"])).exitCode).toBe(0);
    const create = await cli("wallet", ["sql", "execute", "CREATE TABLE IF NOT EXISTS meal (id INTEGER PRIMARY KEY, name TEXT)", "--db", healthDb, "--space", "applications"]);
    expect(create.exitCode, create.stderr + create.stdout).toBe(0);
    expect((await cli("agent", ["sql", "execute", "INSERT INTO meal(name) VALUES ('salmon')", "--db", healthDb, "--space", "applications"])).exitCode).toBe(0);
    expect(JSON.parse((await cli("agent", ["sql", "query", "SELECT name FROM meal", "--db", healthDb, "--space", "applications"])).stdout).rows).toEqual([["salmon"]]);
    expect((await cli("agent", ["sql", "execute", "INSERT INTO meal(name) VALUES ('x')", "--db", "other/db", "--space", "account"])).stderr).toContain("Unauthorized Action");
    // Read-only where the grant says read-only, and nothing outside what it names.
    expect((await cli("agent", ["kv", "put", "--space", "account", "spaces/x", "y"])).stderr).toContain("Unauthorized Action");
    expect((await cli("agent", ["kv", "get", "--space", "default", "anything"])).stderr).toContain("Unauthorized Action");
  });

  test("a code for a different wallet is refused and onboarding stays at the same step", async () => {
    await mkdir(home("forged"), { recursive: true });
    const first = JSON.parse((await cli("forged", ["onboard"])).stdout) as { approvalUrl: string };
    const forger = new PrivateKeySigner("59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const step1 = await approve(first.approvalUrl, ownerSigner);
    expect((await cli("forged", ["onboard", "--code", step1.code])).exitCode).toBe(8);
    const second = JSON.parse((await cli("forged", ["onboard"])).stdout) as { step: number; approvalUrl: string };
    expect(second.step).toBe(2);
    const forged = await cli("forged", ["onboard", "--code", (await approve(second.approvalUrl, forger)).code]);
    expect(forged.stderr).toContain("OPENKEY_OWNER_MISMATCH");
    const again = await cli("forged", ["onboard"]);
    expect(again.exitCode).toBe(8);
    expect(JSON.parse(again.stdout).step).toBe(2);
  });
});
