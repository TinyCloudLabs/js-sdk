import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { activateSessionWithHost } from "@tinycloud/sdk-core";

// Real-node e2e for the agent OpenKey grant (TC-1422). The owner is an OpenKey
// profile holding a broad 3 h session. A fake OpenKey answers the approval URL
// the CLI prints, as the browser page would: the owner wallet signs the requested
// scope with the requested expiry, the approval is activated at the node, and the
// callback is POSTed to the loopback with Origin https://openkey.so.
const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const cliEntry = join(import.meta.dir, "../index.ts");
const OWNER_SESSION_MS = 3 * 3600_000;
const SEVEN_DAYS_S = 7 * 86400;
const hoursUntil = (iso: string) => (Date.parse(iso) - Date.now()) / 3600_000;
setDefaultTimeout(240_000);

describe.skipIf(!NODE_BIN)("agent OpenKey grant, against a real node", () => {
  let root: string;
  let host: string;
  let node: ChildProcess;
  let ownerSigner: PrivateKeySigner;
  let appSpace: string;
  const wasm = new NodeWasmBindings();

  const home = (profile: string) => join(root, `home-${profile}`);

  function cliArgs(profile: string, args: string[]) {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home(profile), TC_HOME: home(profile) };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    delete env.TC_OPENKEY_HOST;
    return { argv: [process.execPath, cliEntry, "--host", host, "--profile", profile, ...args], env };
  }

  async function cli(profile: string, args: string[]) {
    const { argv, env } = cliArgs(profile, args);
    const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  }

  function abilitiesOf(permissions: PermissionEntry[]) {
    const abilities: Record<string, Record<string, string[]>> = {};
    for (const p of permissions) {
      const service = p.service.slice("tinycloud.".length);
      abilities[service] = {
        ...abilities[service],
        [p.path]: [...new Set([...(abilities[service]?.[p.path] ?? []), ...p.actions])],
      };
    }
    return abilities;
  }

  /** Runs `auth grant --yes` headless and answers the printed approval URL as OpenKey would. */
  async function grantWithOpenKey(
    requestFile: string,
    approve: (permissions: PermissionEntry[]) => { permissions: PermissionEntry[]; signer: PrivateKeySigner },
  ) {
    const { argv, env } = cliArgs("owner", ["auth", "grant", requestFile, "--yes"]);
    const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const stdoutText = new Response(child.stdout).text();
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    let stderr = "";
    let url: URL | undefined;
    while (!url) {
      const { value, done } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value);
      const match = stderr.match(/(https?:\/\/\S+\/delegate\?\S+)/);
      if (match) url = new URL(match[1]!);
    }
    let callbackStatus = 0;
    let expiryParam = "";
    if (url) {
      const params = url.searchParams;
      expiryParam = params.get("expiry") ?? "";
      const jwk = JSON.parse(Buffer.from(params.get("jwk")!, "base64url").toString()) as object;
      const requested = (
        JSON.parse(Buffer.from(params.get("permissions")!, "base64url").toString()) as { permissions: PermissionEntry[] }
      ).permissions;
      const { permissions, signer } = approve(requested);
      const address = await signer.getAddress();
      const spaceName = (requested.find((p) => p.space)?.space ?? "applications").split(":").at(-1)!;
      const spaceId = wasm.makeSpaceId(address, 1, spaceName);
      const seconds = Number(expiryParam.replace(/s$/, ""));
      const now = Date.now();
      const prepared = wasm.prepareSession({
        abilities: abilitiesOf(permissions),
        address,
        chainId: 1,
        domain: "cli.tinycloud.xyz",
        spaceId,
        jwk,
        issuedAt: new Date(now).toISOString(),
        expirationTime: new Date(now + seconds * 1000).toISOString(),
      });
      const signature = await signer.signMessage(prepared.siwe);
      const session = wasm.completeSessionSetup({ ...prepared, signature });
      await activateSessionWithHost(host, session.delegationHeader);
      const response = await fetch(params.get("callback")!, {
        method: "POST",
        headers: { Origin: "https://openkey.so", "Content-Type": "application/json" },
        body: JSON.stringify({
          ...session,
          address,
          chainId: 1,
          spaceId,
          verificationMethod: params.get("did"),
          siwe: prepared.siwe,
          signature,
        }),
      });
      callbackStatus = response.status;
    }
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value);
    }
    const exitCode = await child.exited;
    return { exitCode, stdout: await stdoutText, stderr, sawUrl: url !== undefined, callbackStatus, expiryParam };
  }

  async function agentRequest(name: string, args: string[]) {
    await mkdir(home(name), { recursive: true });
    const created = await cli(name, ["profile", "create", name, "--posture", "delegate-session", "--operator", "agent"]);
    expect(created.exitCode).toBe(0);
    const file = join(root, `${name}-req.json`);
    const made = await cli(name, ["auth", "request", ...args, "--emit", file]);
    expect(made.exitCode).toBe(0);
    return file;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tc-agent-openkey-e2e-"));
    process.env.TC_HOME = home("owner");
    const { profileConfigPath, profilePath, sessionPath, tinycloudConfigPath, writeJsonAtomic } = await import(
      "@tinycloud/operations/state"
    );

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

    // The owner wallet (local key) hosts the applications space and seeds one document.
    await mkdir(home("lowner"), { recursive: true });
    expect((await cli("lowner", ["init", "--key-only"])).exitCode).toBe(0);
    expect((await cli("lowner", ["auth", "login", "--method", "local"])).exitCode).toBe(0);
    expect(
      (await cli("lowner", ["auth", "request", "--cap", "tinycloud.kv:applications::get,list,put,del", "--grant", "--yes"]))
        .exitCode,
    ).toBe(0);
    expect((await cli("lowner", ["space", "create", "applications"])).exitCode).toBe(0);
    expect(
      (await cli("lowner", ["kv", "put", "--space", "applications", "demo/knowledge/a.md", "hello-tc1422"])).exitCode,
    ).toBe(0);
    let ownerKey = "";
    for await (const file of new Bun.Glob("**/profile.json").scan({ cwd: home("lowner"), dot: true, absolute: true })) {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (parsed && typeof parsed === "object" && "privateKey" in parsed && typeof parsed.privateKey === "string") {
        ownerKey = parsed.privateKey;
      }
    }
    ownerSigner = new PrivateKeySigner(ownerKey.replace(/^0x/, ""));
    const ownerAddress = await ownerSigner.getAddress();
    appSpace = wasm.makeSpaceId(ownerAddress, 1, "applications");
    const ownerDid = `did:pkh:eip155:1:${ownerAddress}`;

    // OpenKey owner profile: a broad 3 h session on applications.
    const manager = wasm.createSessionManager();
    const jwk = JSON.parse(manager.jwk("default")!);
    const sessionDid = manager.getDID("default");
    const now = Date.now();
    const expiresAt = new Date(now + OWNER_SESSION_MS).toISOString();
    const prepared = wasm.prepareSession({
      abilities: {
        kv: { "": ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"] },
        sql: { "": ["tinycloud.sql/read", "tinycloud.sql/write"] },
        capabilities: { "": ["tinycloud.capabilities/read"] },
      },
      address: ownerAddress,
      chainId: 1,
      domain: "cli.tinycloud.xyz",
      spaceId: appSpace,
      jwk,
      issuedAt: new Date(now - 1000).toISOString(),
      expirationTime: expiresAt,
    });
    const signature = await ownerSigner.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    await activateSessionWithHost(host, session.delegationHeader);
    await writeJsonAtomic(tinycloudConfigPath(), { defaultProfile: "owner", version: 1 });
    await writeJsonAtomic(profileConfigPath("owner"), {
      name: "owner",
      host,
      chainId: 1,
      spaceName: "applications",
      spaceId: appSpace,
      did: sessionDid,
      sessionDid,
      ownerDid,
      authMethod: "openkey",
      posture: "owner-openkey",
      operatorType: "human",
      createdAt: "2026-10-21T00:00:00.000Z",
      openkeyHost: "https://openkey.so",
    });
    await writeJsonAtomic(join(profilePath("owner"), "key.json"), jwk);
    await writeJsonAtomic(sessionPath("owner"), {
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      jwk,
      address: ownerAddress,
      chainId: 1,
      spaceId: appSpace,
      verificationMethod: sessionDid,
      siwe: prepared.siwe,
      signature,
      ownerDid,
      expiresAt,
      tinycloudHosts: [host],
    });
  });

  afterAll(async () => {
    node?.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });

  test("apps-agent preset: grant lasts the 7 d approval, not the 3 h owner session; agent reads its app only", async () => {
    const req = await agentRequest("agent", ["--preset", "apps-agent", "--app", "demo"]);
    const result = await grantWithOpenKey(req, (permissions) => ({ permissions, signer: ownerSigner }));
    expect(result.sawUrl).toBe(true);
    expect(result.callbackStatus).toBeLessThan(300);
    expect(result.exitCode).toBe(0);

    const grant = JSON.parse(result.stdout) as { expiry: string; prompted: boolean };
    expect(result.expiryParam).toBe(`${SEVEN_DAYS_S}s`);
    expect(grant.prompted).toBe(true);
    expect(hoursUntil(grant.expiry)).toBeGreaterThan(7 * 24 - 0.1);
    expect(hoursUntil(grant.expiry)).toBeLessThanOrEqual(7 * 24);

    const grantFile = join(root, "agent-grant.json");
    await writeFile(grantFile, result.stdout);
    expect((await cli("agent", ["auth", "import", grantFile])).exitCode).toBe(0);
    const read = await cli("agent", ["kv", "get", "--space", appSpace, "demo/knowledge/a.md"]);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain("hello-tc1422");
    expect((await cli("agent", ["kv", "put", "--space", appSpace, "demo/knowledge/b.md", "x"])).exitCode).not.toBe(0);
    expect((await cli("agent", ["kv", "get", "--space", appSpace, "demo2/knowledge/a.md"])).exitCode).not.toBe(0);
  });

  test("a 6 d request gets a 6 d grant from its own approval", async () => {
    const req = await agentRequest("agent6d", ["--cap", "tinycloud.kv:applications:demo/:get,list", "--expiry", "6d"]);
    const result = await grantWithOpenKey(req, (permissions) => ({ permissions, signer: ownerSigner }));
    expect(result.exitCode).toBe(0);
    const grant = JSON.parse(result.stdout) as { expiry: string; prompted: boolean };
    expect(result.expiryParam).toBe(`${6 * 86400}s`);
    expect(grant.prompted).toBe(true);
    expect(hoursUntil(grant.expiry)).toBeGreaterThan(6 * 24 - 0.1);
    expect(hoursUntil(grant.expiry)).toBeLessThanOrEqual(6 * 24);
  });

  test("an approval that unchecks an ability is refused with OPENKEY_APPROVAL_NARROWER and emits no grant", async () => {
    const req = await agentRequest("agentn", ["--preset", "apps-agent", "--app", "demo"]);
    const narrowed = await grantWithOpenKey(req, (permissions) => ({
      permissions: permissions
        .map((p) => ({ ...p, actions: p.actions.filter((a) => a !== "tinycloud.kv/list") }))
        .filter((p) => p.actions.length > 0),
      signer: ownerSigner,
    }));
    expect(narrowed.exitCode).not.toBe(0);
    expect(narrowed.stderr).toContain("OPENKEY_APPROVAL_NARROWER");
    expect(narrowed.stdout).toBe("");
  });

  test("a callback signed by a different wallet is refused with OPENKEY_OWNER_MISMATCH", async () => {
    const req = await agentRequest("agentf", ["--preset", "apps-agent", "--app", "demo"]);
    const forger = new PrivateKeySigner("59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const forged = await grantWithOpenKey(req, (permissions) => ({ permissions, signer: forger }));
    expect(forged.callbackStatus).toBe(200);
    expect(forged.exitCode).not.toBe(0);
    expect(forged.stderr).toContain("OPENKEY_OWNER_MISMATCH");
    expect(forged.stdout).toBe("");
  });
});
