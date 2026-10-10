import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CliClientImpl, createCliClient, createCliDelegation } from "../src/clients/cli-client";
import { createSdkClient, type SdkClientImpl } from "../src/clients/sdk-client";
import { createSharedEndpointStorageDeviceFixture } from "../src/clients/shared-fixture";
import type { ClientSpec, TopologySpec } from "../src/contracts/topology";
import type { ClientConstructionOptions } from "../src/contracts/frozen";
import type { ResolvedImage, RunEnvironment, Topology } from "../src/contracts/lifecycle";
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
let environment: RunEnvironment;
let topology: Topology;
let cli: CliClientImpl;
let sdkSpec: ClientSpec;
let sdkClients: SdkClientImpl[] = [];
const image = {} as ResolvedImage;

function topologyFor(spec: TopologySpec, id: string, clients = new Map<string, SdkClientImpl>()): Topology {
  return {
    id,
    spec,
    backend: "local",
    proxy: () => ({ listenUrl: host }),
    sdk(clientId: string) {
      const client = clients.get(clientId);
      if (!client) throw new Error(`Missing integration SDK client ${clientId}`);
      return client;
    },
  } as unknown as Topology;
}

function constructionOptions(spec: ClientSpec, currentTopology = topology): ClientConstructionOptions {
  return { topology: currentTopology, environment, spec, image, sut } as ClientConstructionOptions;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

async function readRecord(path: string, label: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return asRecord(value, label);
}

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


async function runNodeEntry(entry: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawn(process.env.HARNESS_NODE ?? "node", [entry, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TZ: process.env.TZ, HOME: home, TC_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  proc.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  proc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    proc.once("error", rejectExit);
    proc.once("exit", (exitCode) => resolveExit(exitCode));
  });
  return { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

describe.skipIf(!enabled)("S2 client real-node integration", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tc893-s2-integration-"));
    data = join(root, "node");
    await mkdir(data, { recursive: true, mode: 0o700 });
    await startNode();
    const loaderPath = join(bIntRoot, "node_modules", ".tc893", "load-node-sdk.mjs");
    try { previousLoader = await readFile(loaderPath); } catch {}
    sut = await resolveSut({ mode: "workspace", root: bIntRoot });
    const cliSpec: ClientSpec = {
      id: "writer", kind: "cli", node: "local", identity: "owner", auth: { posture: "owner" },
      replication: { prefixes: ["notes/"], maxStalenessMs: 60_000, staleSyncTimeoutMs: 5_000 },
    };
    sdkSpec = {
      id: "reader", kind: "sdk", node: "local", identity: "owner", auth: { posture: "owner" },
      replication: { prefixes: ["notes/"], mode: "foreground", maxStalenessMs: 60_000, staleSyncTimeoutMs: 5_000 },
    };
    const spec: TopologySpec = { name: "s2-real-node", nodes: [{ id: "local" }], clients: [cliSpec, sdkSpec] };
    environment = { runId: "s2-real-node", resultsDir: root } as RunEnvironment;
    topology = topologyFor(spec, "s2-real-node");
    cli = await createCliClient(constructionOptions(cliSpec));
    sdkClients = [];
    home = cli.home();
  }, 60_000);


  afterAll(async () => {
    await Promise.all(sdkClients.map((client) => client.close({ deadlineMs: 5_000 }).catch(() => undefined)));
    await cli?.close({ deadlineMs: 5_000 });
    node?.kill("SIGTERM");
    if (node && node.exitCode === null && node.signalCode === null) await new Promise<void>((resolveExit) => node?.once("exit", () => resolveExit()));
    await rm(root, { recursive: true, force: true });
    const loaderPath = join(bIntRoot, "node_modules", ".tc893", "load-node-sdk.mjs");
    if (previousLoader) await Bun.write(loaderPath, previousLoader);
    else await rm(join(bIntRoot, "node_modules", ".tc893"), { recursive: true, force: true });
  });

  test("CLI replication write is a separate SDK replica hit and both restart modes restore", async () => {
    const sdkHome = join(root, environment.runId, topology.id, "clients", "reader", "home");
    const profile = await readRecord(join(home, ".tinycloud", "profiles", "owner", "profile.json"), "CLI owner profile");
    const ownerPrivateKey = profile.privateKey;
    if (typeof ownerPrivateKey !== "string") throw new Error("CLI owner profile omitted privateKey");
    const payload = new Uint8Array([0, 1, 2, 255]);
    const write = await cli.put("notes/s2-integration", payload);
    if (!write.ok) throw new Error(`CLI replication write failed with exit=${write.exit}; stderr=${write.stderr?.slice(0, 500)}`);
    const cliRead = await cli.get("notes/s2-integration");
    expect(cliRead.found).toBe(true);
    expect(cliRead.value).toEqual(payload);

    const sdk = await createSdkClient(constructionOptions(sdkSpec));
    sdkClients.push(sdk);
    const read = await sdk.get("notes/s2-integration");
    expect(read.ok && read.found).toBe(true);
    expect(read.value).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(await sdk.get("notes/s2-missing")).toMatchObject({ ok: true, found: false });
    const readEvent = read.readEvent;
    if (!readEvent) throw new Error("SDK read omitted its replication.read event");
    expect(readEvent).toMatchObject({ source: "replica", reason: "hit" });
    const cliSpace = write.events.map((item) => item.event).find((event) => event.type === "replication.write")?.space;
    expect(cliSpace).toBeTypeOf("string");
    expect(cliSpace).toBe(readEvent.space);
    const device = await sdk.rpc("session.deviceKey", {});
    const grant = await sdk.rpc("grant.issue", { audience: device.did, caps: [{ prefix: "notes/", actions: ["get", "sync"] }], expiresInMs: 60_000 });
    const ownerAuthority = await sdk.authority();
    expect(ownerAuthority.posture).toBe("owner");
    expect(ownerAuthority.grantExpiresAt).toBeNull();
    const combinedProof = await readRecord(join(sdkHome, "session.json"), "combined SDK owner proof");
    expect(combinedProof.deviceJwk && combinedProof.verificationMethod && combinedProof.delegation).toBeTruthy();
    const delegateHome = join(root, environment.runId, topology.id, "clients", "delegate", "home");
    const delegateSpec: ClientSpec = {
      ...sdkSpec,
      id: "delegate",
      auth: { posture: "delegate-session", grant: { issuer: "reader", caps: [{ prefix: "notes/", actions: ["get", "sync"] }], expiresInMs: 60_000 } },
      deviceProof: combinedProof,
    };
    const delegate = await createSdkClient(constructionOptions(delegateSpec));
    await delegate.rpc("hello", {});
    sdkClients.push(delegate);
    expect((await delegate.authority()).posture).toBe("delegate-session");
    const deviceProofOnDisk = await readFile(join(delegateHome, "session.json"), "utf8");
    expect(deviceProofOnDisk).not.toContain(ownerPrivateKey);
    const savedDeviceProof = await readRecord(join(delegateHome, "session.json"), "saved SDK device proof");
    const savedDeviceJwk = asRecord(savedDeviceProof.deviceJwk, "saved SDK device JWK");
    expect(savedDeviceJwk.d).toBeTruthy();
    expect((await delegate.authority()).grantExpiresAt).toBe(Date.parse(grant.expiresAt));
    const deniedPut = await delegate.put("notes/s2-unauthorized", "blocked");
    expect(deniedPut).toMatchObject({ ok: false, code: "AUTH_UNAUTHORIZED" });
    expect((await delegate.get("notes/s2-integration", { source: "network" })).found).toBe(true);
    await delegate.restart({ auth: "restore" });
    expect((await delegate.authority()).posture).toBe("delegate-session");
    expect((await delegate.authority()).grantExpiresAt).toBe(Date.parse(grant.expiresAt));
    await delegate.close({ deadlineMs: 5_000 });

    if (typeof cliSpace !== "string") throw new Error("CLI replication write omitted its identity space");
    const deviceCliSpec: ClientSpec = {
      id: "device", kind: "cli", node: "local", identity: "owner",
      auth: { posture: "delegate-session", grant: { issuer: "writer", caps: [{ prefix: "notes/", actions: ["get"] }], expiresInMs: 60_000 } },
      replication: { prefixes: ["notes/"], maxStalenessMs: 60_000, staleSyncTimeoutMs: 5_000 },
    };
    const deviceCli = await createCliClient(constructionOptions(deviceCliSpec));
    const deviceFlow = await createCliDelegation({ owner: cli, device: deviceCli, ownerReady: true, space: cliSpace, prefix: "notes/", actions: ["get"], expiry: "60s" });
    expect(deviceFlow.request.exit).toBe(0);
    expect(deviceFlow.grant.exit).toBe(0);
    expect(deviceFlow.imported.exit).toBe(0);
    expect((await cli.authority()).grantExpiresAt).toBeNull();
    expect(deviceFlow.requestPath).toStartWith("/");
    expect(deviceFlow.grantPath).toStartWith("/");
    const deviceRead = await deviceCli.get("notes/s2-integration");
    expect(deviceRead).toMatchObject({ ok: true, found: true });
    expect(deviceRead.value).toEqual(payload);
    await deviceCli.close({ deadlineMs: 5_000 });
    const deviceProfile = await readFile(join(deviceCli.home(), ".tinycloud", "profiles", "device", "profile.json"), "utf8");
    expect(deviceProfile).not.toContain(profile.privateKey);
    
    await sdk.restart({ auth: "restore" });
    await sdk.restart({ auth: "fresh-sign-in" });
    expect((await sdk.get("notes/s2-integration")).found).toBe(true);
    await sdk.kill("SIGKILL");
    await expect(sdk.get("notes/s2-integration")).rejects.toMatchObject({ code: "CLIENT_CRASHED" });
    await sdk.restart({ auth: "restore" });
    expect((await sdk.get("notes/s2-integration")).found).toBe(true);
    await sdk.close({ deadlineMs: 5_000 });
    expect(await readFile(join(sdkHome, "driver.stderr.log"), "utf8")).toBeTypeOf("string");

    const publishedPreflight = await resolveSut({ mode: "published", cliVersion: "1.1.0-beta.24", nodeSdkVersion: "3.1.0-beta.15" }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; detail?: unknown; message?: string },
    );
    expect(publishedPreflight).toBeDefined();
    expect(publishedPreflight?.code).toBe("PREFLIGHT_FAILED");
    const preflightDetail = publishedPreflight?.detail as { version?: string; cliVersion?: string; cliEntry?: string } | undefined;
    expect(preflightDetail).toMatchObject({ version: "3.1.0-beta.15", cliVersion: "1.1.0-beta.24" });
    expect(preflightDetail?.cliEntry).toContain("/node_modules/@tinycloud/cli/bin/tc");
    const publishedCli = await runNodeEntry(preflightDetail?.cliEntry ?? "", ["--version"]);
    expect(publishedCli.code).toBe(0);
    expect(publishedCli.stdout).toContain("1.1.0-beta.24");

    console.log(JSON.stringify({ identitySpaces: { cli: cliSpace, sdk: readEvent.space, matched: cliSpace === readEvent.space }, cliWrite: write.ok, cliRawGet: Buffer.from(cliRead.value ?? []).equals(Buffer.from(payload)), replicaHit: readEvent.reason, grant: { cid: grant.cid, expiresAt: grant.expiresAt }, delegateRestore: "pass", sdkRestore: "pass", freshSignIn: "pass", cliDeviceFlow: "pass", publishedBetaPreflight: { code: publishedPreflight?.code, nodeSdkVersion: preflightDetail?.version, cliVersion: preflightDetail?.cliVersion, cliEntryExecuted: publishedCli.code === 0 } }));
  }, 240_000);
  test("shared endpoint/storage fixture uses distinct real device proofs", async () => {
    const fixtureTopologyId = "s2-shared";
    const sharedEnvironment = { runId: environment.runId, resultsDir: root } as RunEnvironment;
    const writerSpec = topology.spec.clients.find((client) => client.id === "writer")!;
    const issuerA: ClientSpec = { ...sdkSpec, id: "issuera" };
    const issuerB: ClientSpec = { ...sdkSpec, id: "issuerb" };
    const deviceA: ClientSpec = {
      id: "devicea", kind: "sdk", node: "local", identity: "owner",
      auth: { posture: "delegate-session", grant: { issuer: "issuera", caps: [{ prefix: "notes/", actions: ["get", "sync"] }], expiresInMs: 120_000 } },
      replication: { prefixes: ["notes/"], mode: "foreground", maxStalenessMs: 60_000, staleSyncTimeoutMs: 5_000 },
    };
    const deviceB: ClientSpec = {
      id: "deviceb", kind: "sdk", node: "local", identity: "owner",
      auth: { posture: "delegate-session", grant: { issuer: "issuerb", caps: [{ prefix: "notes/", actions: ["get", "sync"] }], expiresInMs: 120_000 } },
      replication: { prefixes: ["notes/"], mode: "foreground", maxStalenessMs: 60_000, staleSyncTimeoutMs: 5_000 },
    };
    const spec: TopologySpec = { name: "shared-device-fixture", nodes: [{ id: "local" }], clients: [writerSpec, issuerA, issuerB, deviceA, deviceB] };
    const proofTopology = topologyFor(spec, fixtureTopologyId);
    const createOptions = (clientSpec: ClientSpec, currentTopology = proofTopology): ClientConstructionOptions => ({
      topology: currentTopology, environment: sharedEnvironment, spec: clientSpec, image, sut,
    });
    const proofHome = (id: string) => join(root, sharedEnvironment.runId, fixtureTopologyId, "clients", id, "home", "session.json");
    const issuerClientA = await createSdkClient(createOptions(issuerA));
    const issuerClientB = await createSdkClient(createOptions(issuerB));
    sdkClients.push(issuerClientA, issuerClientB);
    try {
      for (const issuer of [issuerClientA, issuerClientB]) {
        const device = await issuer.rpc("session.deviceKey", {});
        await issuer.rpc("grant.issue", {
          audience: device.did,
          caps: [{ prefix: "notes/", actions: ["get", "sync"] }],
          expiresInMs: 120_000,
        });
      }
      const proofA = await readRecord(proofHome("issuera"), "first SDK device proof");
      const proofB = await readRecord(proofHome("issuerb"), "second SDK device proof");
      const sessionA = asRecord(proofA.session, "first SDK owner session");
      const sessionB = asRecord(proofB.session, "second SDK owner session");
      const deviceKeyA = asRecord(proofA.deviceJwk, "first SDK device JWK");
      const deviceKeyB = asRecord(proofB.deviceJwk, "second SDK device JWK");
      expect(sessionA.spaceId).toBe(sessionB.spaceId);
      expect(deviceKeyA.x).toBeTruthy();
      expect(deviceKeyA.x).not.toBe(deviceKeyB.x);
    } finally {
      await Promise.all([issuerClientA.close({ deadlineMs: 5_000 }), issuerClientB.close({ deadlineMs: 5_000 })]);
    }

    const replicaRoot = join(root, "shared-device-replica");
    const clients = new Map<string, SdkClientImpl>();
    const fixture = await createSharedEndpointStorageDeviceFixture({
      spec,
      clientIds: ["devicea", "deviceb"],
      canonicalEndpoint: host,
      replicaRoot,
      deviceProofs: [{ id: "device-proof-a", proof: await readRecord(proofHome("issuera"), "first SDK device proof") }, { id: "device-proof-b", proof: await readRecord(proofHome("issuerb"), "second SDK device proof") }],
      async createTopology(preparedSpec) {
        const preparedTopology = topologyFor(preparedSpec, fixtureTopologyId, clients);
        for (const clientSpec of preparedSpec.clients) {
          if (clientSpec.kind !== "sdk") continue;
          const client = await createSdkClient(createOptions(clientSpec, preparedTopology));
          clients.set(clientSpec.id, client);
          sdkClients.push(client);
        }
        return preparedTopology;
      },
    });
    expect(fixture.canonicalEndpoint).toBe(host);
    expect(fixture.replicaRoot).toBe(replicaRoot);
    expect(fixture.mode).toBe("foreground");
    expect([clients.get("devicea")?.replicaDir(), clients.get("deviceb")?.replicaDir()]).toEqual([replicaRoot, replicaRoot]);
    expect(fixture.topology.spec.clients.filter((client) => client.id === "devicea" || client.id === "deviceb").map((client) => client.endpoint)).toEqual([host, host]);
    expect(fixture.devices[0].id).not.toBe(fixture.devices[1].id);

    const first = await fixture.clients[0].get("notes/s2-integration");
    expect(first).toMatchObject({ ok: true, found: true });
    const second = await fixture.clients[1].get("notes/s2-integration");
    expect(second).toMatchObject({ ok: true, found: true, readEvent: { source: "replica", reason: "hit" } });
    const reopened = await fixture.reopen("devicea", { auth: "restore", refresh: false, deadlineMs: 5_000 });
    expect(await reopened.get("notes/s2-integration")).toMatchObject({ ok: true, found: true });
    const delegateProofOnDisk = await readFile(join(root, sharedEnvironment.runId, fixtureTopologyId, "clients", "devicea", "home", "session.json"), "utf8");
    const sharedOwnerProfile = await readRecord(join(home, ".tinycloud", "profiles", "owner", "profile.json"), "CLI owner profile");
    const sharedOwnerKey = sharedOwnerProfile.privateKey;
    if (typeof sharedOwnerKey !== "string") throw new Error("CLI owner profile omitted privateKey");
    expect(delegateProofOnDisk).not.toContain(sharedOwnerKey);
    console.log(JSON.stringify({ sharedEndpoint: fixture.canonicalEndpoint, sharedReplicaRoot: fixture.replicaRoot, distinctDeviceProofs: true, secondDeviceRead: second.readEvent?.reason, restore: "pass" }));
  }, 120_000);
});
