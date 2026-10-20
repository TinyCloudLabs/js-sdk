import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs against a real TinyCloud node binary (the variable the node-sdk e2e tests use).
const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const cliEntry = join(import.meta.dir, "../index.ts");
// Each test starts several CLI processes against a real node.
setDefaultTimeout(120_000);

const KEY = "xyz.test.health/knowledge/index.md";

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  json(): any;
  error(): any;
}

describe.skipIf(!NODE_BIN)("delegation revoke from a profile with no local record of the grant, against a real node", () => {
  let root: string;
  let host: string;
  let node: ChildProcess;
  let space: string;

  const home = (profile: string) => join(root, `home-${profile}`);

  async function cli(profile: string, args: string[]): Promise<Run> {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home(profile), TC_HOME: home(profile) };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    const child = Bun.spawn([process.execPath, cliEntry, "--host", host, "--profile", profile, ...args], {
      env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { exitCode, stdout, stderr, json: () => JSON.parse(stdout), error: () => JSON.parse(stderr.slice(stderr.indexOf("{"))).error };
  }

  async function ownerProfile(name: string): Promise<void> {
    await mkdir(home(name), { recursive: true });
    expect((await cli(name, ["init", "--key-only"])).exitCode).toBe(0);
    expect((await cli(name, ["auth", "login", "--method", "local"])).exitCode).toBe(0);
  }

  /** An agent profile holding a fresh read grant on the applications space; returns the grant's CID. */
  async function grantAgent(agent: string): Promise<string> {
    await mkdir(home(agent), { recursive: true });
    const created = await cli(agent, ["profile", "create", agent, "--posture", "delegate-session", "--operator", "agent"]);
    if (created.exitCode !== 0) throw new Error(`profile create ${agent} exited ${created.exitCode}: ${created.stderr.slice(0, 500)}`);
    const requestFile = join(root, `${agent}-request.json`);
    const grantFile = join(root, `${agent}-grant.json`);
    const request = await cli(agent, ["auth", "request", "--cap", "tinycloud.kv:applications:xyz.test.health/:get,list", "--expiry", "1d", "--emit", requestFile]);
    expect(request.exitCode).toBe(0);
    const granted = await cli("owner", ["auth", "grant", requestFile, "--yes"]);
    if (granted.exitCode !== 0) throw new Error(`auth grant exited ${granted.exitCode}: ${granted.stderr.slice(0, 600)}`);
    await writeFile(grantFile, granted.stdout);
    expect((await cli(agent, ["auth", "import", grantFile])).exitCode).toBe(0);
    return granted.json().delegationCid;
  }

  const agentRead = (agent: string) => cli(agent, ["kv", "get", "--space", space, KEY]);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tc-revoke-lookup-e2e-"));
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

    await ownerProfile("owner");
    expect((await cli("owner", ["auth", "request", "--cap", "tinycloud.kv:applications::get,list,put,del", "--grant", "--yes"])).exitCode).toBe(0);
    const created = await cli("owner", ["space", "create", "applications"]);
    expect(created.exitCode).toBe(0);
    space = created.json().spaceId;
    await writeFile(join(root, "index.md"), "# TinyHealth\n");
    expect((await cli("owner", ["kv", "put", "--space", "applications", KEY, "--file", join(root, "index.md")])).exitCode).toBe(0);

    // The same owner wallet on another machine, signed in afresh: a new session key, and none of the grant records.
    const wallet = JSON.parse(await readFile(join(home("owner"), ".tinycloud", "profiles", "owner", "profile.json"), "utf8"));
    await mkdir(join(home("owner3"), ".tinycloud", "profiles", "owner3"), { recursive: true });
    await writeFile(join(home("owner3"), ".tinycloud", "profiles", "owner3", "profile.json"), JSON.stringify({ ...wallet, name: "owner3", sessionDid: undefined }));
    await cp(join(home("owner"), ".tinycloud", "config.json"), join(home("owner3"), ".tinycloud", "config.json"));
    expect((await cli("owner3", ["auth", "login", "--method", "local"])).exitCode).toBe(0);

    // The same owner on another machine: the key and session, but none of the grant records.
    const source = join(home("owner"), ".tinycloud", "profiles", "owner");
    const copy = join(home("owner2"), ".tinycloud", "profiles", "owner2");
    await mkdir(copy, { recursive: true });
    for (const file of ["profile.json", "key.json", "session.json"]) await cp(join(source, file), join(copy, file));
    const profile = JSON.parse(await readFile(join(copy, "profile.json"), "utf8"));
    await writeFile(join(copy, "profile.json"), JSON.stringify({ ...profile, name: "owner2" }));
    await cp(join(home("owner"), ".tinycloud", "config.json"), join(home("owner2"), ".tinycloud", "config.json"));

    await ownerProfile("stranger");
  }, 120_000);

  afterAll(async () => {
    node?.kill();
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("the owner's other profile revokes the grant; the agent is refused with a message that says so", async () => {
    const cid = await grantAgent("agentA");
    expect((await agentRead("agentA")).exitCode).toBe(0);
    // The signing profile has the grant record; the other one must not.
    const missing = await cli("owner2", ["auth", "grants"]);
    expect(missing.stdout + missing.stderr).not.toContain(cid);

    const revoked = await cli("owner2", ["delegation", "revoke", cid, "--yes"]);
    if (revoked.exitCode !== 0) throw new Error(`revoke exited ${revoked.exitCode}: ${revoked.stderr.slice(0, 600)}`);
    expect(revoked.json()).toMatchObject({ cid, revoked: true, targetSpaceSource: "node-delegation-record", authorityScopeSource: "node-delegation-record" });

    const refused = await agentRead("agentA");
    expect(refused.exitCode).toBe(5);
    expect(refused.error()).toMatchObject({
      code: "GRANT_REVOKED",
      message: expect.stringMatching(/^This grant was revoked\. Ask the owner for a new grant/),
    });
    expect(refused.stderr).not.toContain(cid);
  });

  test("a profile with the owner's wallet but a different session key walks the node's chain to the owner, and revokes", async () => {
    const cid = await grantAgent("agentF");
    expect((await agentRead("agentF")).exitCode).toBe(0);
    const revoked = await cli("owner3", ["delegation", "revoke", cid, "--yes"]);
    if (revoked.exitCode !== 0) throw new Error(`revoke exited ${revoked.exitCode}: ${revoked.stderr.slice(0, 600)}`);
    expect(revoked.json()).toMatchObject({ cid, revoked: true, targetSpaceSource: "node-delegation-record" });
    expect((await agentRead("agentF")).error()).toMatchObject({ code: "GRANT_REVOKED" });
  });

  test("a revoke that repeats is still accepted", async () => {
    const cid = await grantAgent("agentB");
    expect((await cli("owner2", ["delegation", "revoke", cid, "--yes"])).exitCode).toBe(0);
    const again = await cli("owner2", ["delegation", "revoke", cid, "--yes"]);
    expect(again.exitCode).toBe(0);
    expect(again.json()).toMatchObject({ cid, revoked: true });
  });

  test("the profile that signed the grant still revokes it from its own record, and the agent is refused the same way", async () => {
    const cid = await grantAgent("agentC");
    const revoked = await cli("owner", ["delegation", "revoke", cid, "--yes"]);
    expect(revoked.exitCode).toBe(0);
    expect(revoked.json()).toMatchObject({ cid, revoked: true, targetSpaceSource: "local-signed-grant-artifact" });
    expect((await agentRead("agentC")).error()).toMatchObject({ code: "GRANT_REVOKED" });
  });

  test("an owner who did not issue the grant cannot revoke it, and the other agent is untouched", async () => {
    const cid = await grantAgent("agentD");
    const refused = await cli("stranger", ["delegation", "revoke", cid, "--yes"]);
    expect(refused.exitCode).toBe(4);
    expect(refused.error()).toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(refused.stdout).not.toContain('"revoked": true');
    expect((await agentRead("agentD")).exitCode).toBe(0);
  });

  test("an agent whose grant was never revoked keeps working, and a different 401 is not reported as a revocation", async () => {
    await grantAgent("agentE");
    expect((await agentRead("agentE")).exitCode).toBe(0);
    const expired = await cli("agentE", ["auth", "logout"]);
    expect(expired.exitCode).toBe(0);
    const after = await agentRead("agentE");
    expect(after.exitCode).not.toBe(0);
    expect(JSON.stringify(after.error())).not.toContain("revoked");
  });
});
