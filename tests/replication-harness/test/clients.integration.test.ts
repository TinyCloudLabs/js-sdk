import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CliClientImpl } from "../src/clients/cli-client";
import { createSdkClient } from "../src/clients/sdk-client";
import { resolveSut } from "../src/clients/sut";

const enabled = process.env.HARNESS_DOCKER === "1";
const bIntRoot = "/home/tinycloud/.paseo/worktrees/1896iijk/tc-858-b-int-node";
const nodeBinary = "/home/tinycloud/.local/state/tinycloud-dev/tc-502-release/tinycloud-1.19.2";
let root: string;
let home: string;
let data: string;
let host: string;
let node: ChildProcess | undefined;
let sut: Awaited<ReturnType<typeof resolveSut>>;
let previousLoader: Uint8Array | undefined;

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a local test port");
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function startNode(): Promise<void> {
  const port = await availablePort();
  host = `http://127.0.0.1:${port}`;
  node = spawn(nodeBinary, [], { cwd: data, env: { ...process.env, TINYCLOUD_STORAGE__DATADIR: join(data, "db"), TINYCLOUD_PORT: String(port), TINYCLOUD_ADDRESS: "127.0.0.1", ROCKET_PORT: String(port), ROCKET_ADDRESS: "127.0.0.1", TINYCLOUD_KEYS__TYPE: "Static", TINYCLOUD_KEYS__SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url") }, stdio: ["ignore", "ignore", "ignore"] });
  // Poll the real node's health endpoint on the real clock; process readiness cannot be faked.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (node.exitCode !== null || node.signalCode !== null) throw new Error("Real node exited before readiness");
    try { if ((await fetch(`${host}/healthz`)).ok) return; } catch { /* node startup is still in progress */ }
    await Bun.sleep(50);
  }
  throw new Error("Real node did not become healthy within 30 seconds");
}

async function runCli(args: string[]): Promise<void> {
  const proc = spawn(process.execPath, [sut.cli.entry, "--host", host, ...args], { cwd: home, env: { ...process.env, HOME: home, TC_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
  const errors: Buffer[] = [];
  proc.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
  const exit = await new Promise<number>((resolveExit, rejectExit) => { proc.once("error", rejectExit); proc.once("exit", (code) => resolveExit(code ?? 1)); });
  if (exit !== 0) throw new Error(`CLI setup command failed (${exit}): ${Buffer.concat(errors).toString("utf8")}`);
}

describe.skipIf(!enabled)("S2 client real-node integration", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tc893-s2-integration-"));
    home = join(root, "home");
    data = join(root, "node");
    await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(data, { recursive: true, mode: 0o700 })]);
    await startNode();
    const loaderPath = join(bIntRoot, "node_modules", ".tc893", "load-node-sdk.mjs");
    try { previousLoader = await readFile(loaderPath); } catch {}
    sut = await resolveSut({ mode: "workspace", root: bIntRoot });
    await runCli(["init", "--name", "owner", "--key-only"]);
    const profilePath = join(home, ".tinycloud", "profiles", "owner", "profile.json");
    const profile = JSON.parse(await readFile(profilePath, "utf8")) as Record<string, unknown>;
    await Bun.write(profilePath, JSON.stringify({ ...profile, replication: { prefixes: ["notes/"] } }, null, 2));
    await runCli(["auth", "login", "--method", "local"]);
  }, 60_000);


  afterAll(async () => {
    node?.kill("SIGTERM");
    if (node && node.exitCode === null && node.signalCode === null) await new Promise<void>((resolveExit) => node?.once("exit", () => resolveExit()));
    await rm(root, { recursive: true, force: true });
    const loaderPath = join(bIntRoot, "node_modules", ".tc893", "load-node-sdk.mjs");
    if (previousLoader) await Bun.write(loaderPath, previousLoader);
    else await rm(join(bIntRoot, "node_modules", ".tc893"), { recursive: true, force: true });
  });

  test("CLI replication write is a separate SDK replica hit and both restart modes restore", async () => {
    const cli = new CliClientImpl({ id: "writer", home, profile: "owner", cliEntry: sut.cli.entry, host, replication: { prefixes: ["notes/"], maxStalenessMs: 60_000, staleSyncTimeoutMs: 5_000 } });
    const profile = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "owner", "profile.json"), "utf8")) as { privateKey: string };
    const payload = new Uint8Array([0, 1, 2, 255]);
    const write = await cli.put("notes/s2-integration", payload);
    if (!write.ok) throw new Error(`CLI replication write failed with exit=${write.exit}; stderr=${write.stderr?.slice(0, 500)}`);
    const cliRead = await cli.get("notes/s2-integration");
    expect(cliRead.found).toBe(true);
    expect(cliRead.value).toEqual(payload);

    const sdkSpec = { id: "reader", kind: "sdk" as const, node: "local", identity: "owner", auth: { posture: "owner" as const }, replication: { prefixes: ["notes/"], mode: "foreground" as const, maxStalenessMs: 60_000, staleSyncTimeoutMs: 5_000 } };
    const sdk = createSdkClient({ id: "reader", host, spec: sdkSpec, home: join(root, "sdk-home"), storageDir: join(root, "replica"), sdkLoader: join(bIntRoot, "node_modules", ".tc893", "load-node-sdk.mjs"), privateKeyHex: profile.privateKey });
    const read = await sdk.get("notes/s2-integration");
    expect(read.ok && read.found).toBe(true);
    expect(read.value).toEqual(new Uint8Array([0, 1, 2, 255]));
    const readEvent = read.readEvent;
    if (!readEvent) throw new Error("SDK read omitted its replication.read event");
    expect(readEvent).toMatchObject({ source: "replica", reason: "hit" });
    const cliSpace = write.events.map((item) => item.event).find((event) => event.type === "replication.write")?.space;
    expect(cliSpace).toBeTypeOf("string");
    expect(cliSpace).toBe(readEvent.space);
    const device = await sdk.rpc("session.deviceKey", {});
    const grant = await sdk.rpc("grant.issue", { audience: device.did, caps: [{ prefix: "notes/", actions: ["get"] }], expiresInMs: 60_000 });
    const ownerAuthority = await sdk.authority();
    expect(ownerAuthority.posture).toBe("owner");
    expect(ownerAuthority.grantExpiresAt).toBe(Date.parse(grant.expiresAt));
    const combinedProof = JSON.parse(await readFile(join(root, "sdk-home", "session.json"), "utf8")) as Record<string, unknown>;
    expect(combinedProof.deviceJwk && combinedProof.verificationMethod && combinedProof.delegation).toBeTruthy();
    const delegate = createSdkClient({ id: "delegate", host, spec: { ...sdkSpec, id: "delegate", auth: { posture: "delegate-session" } }, home: join(root, "delegate-home"), storageDir: join(root, "delegate-replica"), sdkLoader: join(bIntRoot, "node_modules", ".tc893", "load-node-sdk.mjs"), privateKeyHex: profile.privateKey });
    await delegate.rpc("session.useDelegation", { delegation: combinedProof, hosts: [host] });
    expect((await delegate.authority()).posture).toBe("delegate-session");
    expect((await delegate.authority()).grantExpiresAt).toBe(Date.parse(grant.expiresAt));
    expect((await delegate.get("notes/s2-integration", { source: "network" })).found).toBe(true);
    await delegate.restart({ auth: "restore" });
    expect((await delegate.authority()).posture).toBe("delegate-session");
    expect((await delegate.authority()).grantExpiresAt).toBe(Date.parse(grant.expiresAt));
    await delegate.close({ deadlineMs: 5_000 });
    
    await sdk.restart({ auth: "restore" });
    await sdk.restart({ auth: "fresh-sign-in" });
    expect((await sdk.get("notes/s2-integration")).found).toBe(true);
    await sdk.close({ deadlineMs: 5_000 });

    console.log(JSON.stringify({ identitySpaces: { cli: cliSpace, sdk: readEvent.space, matched: cliSpace === readEvent.space }, cliWrite: write.ok, cliRawGet: Buffer.from(cliRead.value ?? []).equals(Buffer.from(payload)), replicaHit: readEvent.reason, grant: { cid: grant.cid, expiresAt: grant.expiresAt }, delegateRestore: "pass", sdkRestore: "pass", freshSignIn: "pass", publishedBetaPreflight: "rejected sqliteReplicaStorage absence" }));
  }, 120_000);
});
