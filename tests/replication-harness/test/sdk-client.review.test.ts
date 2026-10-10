import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { HarnessError } from "../src/contracts/common";
import { createSdkClient, SdkClientImpl } from "../src/clients/sdk-client";

async function waitForFileContents(path: string, predicate: (contents: string) => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (predicate(await readFile(path, "utf8"))) return;
    } catch { /* The driver creates the artifact asynchronously. */ }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
  throw new Error(`Timed out waiting for ${path}`);
}
const loaderSource = String.raw`
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const logPath = process.env.TC893_HOME + "/observations.jsonl";
const record = (entry) => appendFileSync(logPath, JSON.stringify(entry) + "\n");
record({ kind: "boot", nodeVersion: process.version, bunType: typeof process.versions.bun, runtime: process.versions.bun === undefined ? "node" : "bun/" + process.versions.bun, env: Object.keys(process.env).sort() });
console.error("sdk-driver-stderr-canary");
class TinyCloudNode {
  constructor(options) {
    this.options = options;
    this.restorableSession = undefined;
    this.sessionKeyJwk = { kty: "OKP", x: randomUUID(), d: randomUUID() };
    this.sessionDid = "did:key:" + this.sessionKeyJwk.x + "#key-1";
    record({ kind: "init", privateKeyProvided: options.privateKey !== undefined, host: options.host });
    this.kv = {
      get: async (key, options = {}) => {
        record({ kind: "get", key, space: options.space });
        if (key === "throws") throw Object.assign(new Error("auth exception"), { code: "AUTH_EXPIRED" });
        if (key === "auth-error") return { ok: false, error: { code: "AUTH_REQUIRED", message: "login required" } };
        if (key === "missing") return { ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } };
        if (key === "timeout") {
          await new Promise((resolve) => setTimeout(resolve, 25));
          record({ kind: "timeout", timeoutMs: options.timeout });
          return { ok: false, error: { code: "TIMEOUT", message: "SDK timeout" } };
        }
        if (key === "abort") {
          record({ kind: "abort-started" });
          return await new Promise((resolve) => options.signal.addEventListener("abort", () => { record({ kind: "abort-cancelled" }); resolve({ ok: false, error: { code: "TIMEOUT" } }); }, { once: true }));
        }
        if (key.startsWith("parallel-")) await new Promise((resolve) => setTimeout(resolve, key.endsWith("a") ? 20 : 5));
        this.options.replication?.onEvent?.({ type: "replication.read", op: "get", key, source: "network", reason: "miss" });
        return { ok: true, data: { data: new Uint8Array([42]) } };
      },
      put: async (key) => {
        if (key === "denied") return { ok: false, error: { code: "AUTH_REQUIRED", message: "login required" } };
        if (key === "no-code") return { ok: false, error: { message: "missing code" } };
        const grant = this.restorableSession?.grant;
        if (grant && !grant.caps?.some((cap) => key.startsWith(cap.path) && cap.actions.includes("put"))) {
          return { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "outside device grant" } };
        }
        return { ok: true, data: {} };
      },
      delete: async (key) => key === "no-code" ? { ok: false, error: { message: "missing code" } } : { ok: true, data: {} },
      list: async (options) => { record({ kind: "list", prefix: options.prefix }); return { ok: true, data: { keys: [] } }; },
      batchPut: async () => ({ ok: true, data: { written: [] } }),
    };
    this.startSyncPromise = new Promise((resolve) => setTimeout(resolve, 10));
    this.replicationClosed = false;
    this.replicationPurged = false;
    this.replication = {
      status: async () => this.replicationPurged && !this.replicationClosed ? [{ prefix: "notes/", state: "idle" }] : [],
      sync: async ({ prefix } = {}) => {
        const trigger = prefix === "start-joined" ? "start" : prefix === "interval" ? "interval" : "manual";
        this.options.replication?.onEvent?.({ type: "replication.sync", trigger, outcome: "ok" });
        if (prefix === "start-joined" || prefix === "interval") return this.startSyncPromise;
      },
      purge: async ({ timeoutMs } = {}) => {
        if (timeoutMs === 123) { this.replicationPurged = true; return { purged: ["notes/"], failed: [] }; }
        return { ok: false, error: { code: "REPLICA_UNAVAILABLE" } };
      },
      clearPending: async () => 0,
      close: async () => { this.replicationClosed = true; },
    };
  }
  async signIn() {
    record({ kind: "sign-in", host: this.options.host });
    const expiry = new Date(Date.now() + 60000).toISOString();
    this.restorableSession = { spaceId: "owner-space", jwk: this.sessionKeyJwk, verificationMethod: this.sessionDid, address: "0xowner", chainId: 1, siwe: "signed owner session\nExpiration Time: " + expiry, signature: "signature", delegationHeader: { Authorization: "Bearer owner-session" } };
  }
  async restoreSession(session) {
    record({ kind: "restore", hosts: session.tinycloudHosts });
    this.restorableSession = session;
  }
  async delegateTo(audience, caps, options) {
    const delegation = { delegationHeader: { Authorization: "Bearer grant" }, cid: "grant-cid", spaceId: this.restorableSession.spaceId, expiry: new Date(Date.now() + options.expiry).toISOString(), audience, caps };
    return { delegation };
  }
}
export const sdk = { version: "review-test", TinyCloudNode, sqliteReplicaStorage: (options) => options };
export const resolved = "review-test-loader";
`;

test("SDK client keeps Node RPC, auth, deadline, and crash semantics isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc893-sdk-review-"));
  const ownerHome = join(root, "owner-home");
  const restoreEnv = new Map<string, string | undefined>();
  const isolatedKeys = ["HARNESS_NODE", "NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "npm_config_registry", "npm_config_user_agent", "npm_lifecycle_event", "npm_lifecycle_script", "NODE_OPTIONS", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "NO_PROXY", "TC_AMBIENT_SECRET", "LANG", "TZ"];
  for (const key of isolatedKeys) {
    restoreEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.NPM_TOKEN = "ambient-npm-token";
  process.env.NODE_AUTH_TOKEN = "ambient-node-auth-token";
  process.env.GITHUB_TOKEN = "ambient-github-token";
  process.env.npm_config_registry = "https://ambient.example.invalid";
  process.env.npm_config_user_agent = "ambient-npm-client";
  process.env.npm_lifecycle_event = "test";
  process.env.npm_lifecycle_script = "ambient script";
  process.env.NODE_OPTIONS = "--trace-warnings";
  process.env.HTTPS_PROXY = "http://ambient-proxy.invalid";
  process.env.HTTP_PROXY = "http://ambient-proxy.invalid";
  process.env.http_proxy = "http://ambient-proxy.invalid";
  process.env.https_proxy = "http://ambient-proxy.invalid";
  process.env.ALL_PROXY = "http://ambient-proxy.invalid";
  process.env.NO_PROXY = "ambient.example.invalid";
  process.env.TC_AMBIENT_SECRET = "ambient-tc-secret";
  process.env.LANG = "C.UTF-8";
  process.env.TZ = "UTC";

  let owner: SdkClientImpl | undefined;
  let delegate: SdkClientImpl | undefined;
  let sessionOnly: SdkClientImpl | undefined;
  let aliasClient: SdkClientImpl | undefined;
  try {
    const loaderPath = join(root, "fake-sdk.mjs");
    await writeFile(loaderPath, loaderSource, { mode: 0o600 });
    await chmod(loaderPath, 0o600);

    const invalidConstruction = (posture: "owner" | "delegate-session", deviceProof: unknown) => createSdkClient({
      topology: { id: "t", spec: { name: "t", nodes: [], clients: [] } } as never,
      environment: { runId: "r", resultsDir: root } as never,
      image: {} as never,
      sut: { source: "workspace", root } as never,
      spec: { id: "invalid", kind: "sdk", node: "local", identity: "shared", auth: { posture }, deviceProof },
    });
    await expect(invalidConstruction("owner", { key: "unsupported" })).rejects.toThrow(HarnessError);
    await expect(invalidConstruction("delegate-session", { key: "unsupported" })).rejects.toThrow(/device JWK/);
    owner = new SdkClientImpl({
      id: "owner", host: "https://node.example", domain: "node.example", home: ownerHome,
      storageDir: join(root, "owner-replica"), sdkLoader: loaderPath,
      privateKeyHex: "owner-secret-do-not-persist", auth: "fresh-sign-in",
      hostAliases: { nodeb: "https://nodeb-proxy.example" },
      replication: { prefixes: ["notes/"], mode: "foreground", storageDir: join(root, "owner-replica") },
    });
    const stderrArtifactPath = owner.stderrArtifactPath;
    const hello = await owner.rpc("hello", {});
    expect(hello.driver).toBe("tc893-sdk-driver");
    expect(hello.node).toMatch(/^v\d+\.\d+\.\d+/);
    expect(hello.node).not.toContain("bun/");
    aliasClient = owner.withHost("nodeb") as SdkClientImpl;
    expect(owner.withHost("https://nodeb-proxy.example")).toBe(aliasClient);
    expect(aliasClient.home()).not.toBe(owner.home());
    expect((await aliasClient.get("alias")).found).toBe(true);
    const aliasObservations = (await readFile(join(aliasClient.home(), "observations.jsonl"), "utf8"))
      .split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as { kind: string; host?: string });
    expect(aliasObservations.find((item) => item.kind === "init" && item.host === "https://nodeb-proxy.example")).toBeTruthy();
    expect(aliasObservations.find((item) => item.kind === "sign-in" && item.host === "https://nodeb-proxy.example")).toBeTruthy();

    const boot = JSON.parse((await readFile(join(ownerHome, "observations.jsonl"), "utf8")).split("\n")[0]!) as { nodeVersion: string; bunType: string; runtime: string; env: string[] };
    expect(hello.node).toBe(boot.nodeVersion);
    expect(boot.runtime).toBe("node");
    expect(boot.bunType).toBe("undefined");
    const allowedEnv = new Set(["PATH", "HOME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME", "LC_ADDRESS", "LC_IDENTIFICATION", "LC_MEASUREMENT", "LC_NAME", "LC_PAPER", "LC_TELEPHONE", "TZ", "TC_HOME", "TC893_LOADER", "TC893_HOME"]);
    expect(boot.env.every((name) => allowedEnv.has(name))).toBe(true);
    for (const leaked of ["HARNESS_NODE", "NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "npm_config_registry", "npm_config_user_agent", "npm_lifecycle_event", "npm_lifecycle_script", "NODE_OPTIONS", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "NO_PROXY", "TC_AMBIENT_SECRET"]) expect(boot.env).not.toContain(leaked);

    expect(await owner.get("missing")).toMatchObject({ ok: true, found: false });
    expect(await owner.get("auth-error")).toMatchObject({ ok: false, found: false, code: "AUTH_REQUIRED" });
    await expect(owner.get("throws")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    await expect(owner.get("space-selection", { space: "other-space" })).rejects.toMatchObject({ code: "CLIENT_UNSUPPORTED_OPTION" });
    await expect(owner.clearPending({ keys: [] })).rejects.toMatchObject({ code: "CLIENT_UNSUPPORTED_OPTION" });
    expect(await owner.rpc("kv.put", { key: "denied", value: { $b64: "eA==" } })).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(await owner.put("denied", "x")).toMatchObject({ ok: false, outcome: "failed", code: "AUTH_REQUIRED" });
    await expect(owner.put("no-code", "x")).rejects.toMatchObject({ code: "RPC_PROTOCOL" });
    await expect(owner.del("no-code")).rejects.toMatchObject({ code: "RPC_PROTOCOL" });
    expect(await owner.purge()).toMatchObject({ ok: false, code: "REPLICA_UNAVAILABLE", purged: [], failed: [] });
    expect(await owner.clearPending()).toMatchObject({ ok: true, cleared: 0 });

    const singleRead = await owner.get("single");
    expect(singleRead.events).toHaveLength(1);
    expect(singleRead.events[0]).toMatchObject({ opSeq: singleRead.opSeq, attribution: "op", event: { key: "single" } });
    const getObservation = (await readFile(join(ownerHome, "observations.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; key?: string; space?: unknown }).find((item) => item.kind === "get" && item.key === "single");
    expect(getObservation?.space).toBeUndefined();
    await owner.list("notes/only/");
    const listObservation = (await readFile(join(ownerHome, "observations.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; prefix?: string }).find((item) => item.kind === "list");
    expect(listObservation?.prefix).toBe("notes/only/");
    const [parallelA, parallelB] = await Promise.all([owner.get("parallel-a"), owner.get("parallel-b")]);
    expect(new Set([parallelA.opSeq, parallelB.opSeq]).size).toBe(2);
    expect([...parallelA.events, ...parallelB.events].every((event) => event.attribution === "op" && event.opSeq !== null)).toBe(true);
    expect((await owner.sync({ prefix: "notes/" })).ok).toBe(true);
    const joinedStart = await owner.sync({ prefix: "start-joined" });
    expect(joinedStart).toMatchObject({ ok: true, syncs: [{ trigger: "start", outcome: "ok" }] });
    const intervalSync = await owner.sync({ prefix: "interval" });
    expect(intervalSync).toMatchObject({ ok: false, code: "SYNC_EVENT_MISSING", syncs: [] });
    expect(owner.events({ type: "replication.sync" }).at(-1)).toMatchObject({ attribution: "background", event: { trigger: "interval" } });
    const sdkTimeout = await owner.get("timeout", { deadlineMs: 0 });
    expect(sdkTimeout).toMatchObject({ ok: false, found: false, code: "TIMEOUT" });
    const timeoutLines = (await readFile(join(ownerHome, "observations.jsonl"), "utf8")).split("\n");
    const completeTimeoutLines = timeoutLines.slice(0, -1).filter((line) => line.length > 0);
    const timeoutObservation = completeTimeoutLines.map((line) => JSON.parse(line) as { kind: string; timeoutMs?: number }).find((item) => item.kind === "timeout");
    expect(timeoutObservation?.timeoutMs).toBe(0);
    const abort = new AbortController();
    const aborted = owner.get("abort", { signal: abort.signal, deadlineMs: 5000 });
    await waitForFileContents(join(ownerHome, "observations.jsonl"), (contents) => contents.includes('"kind":"abort-started"'));
    abort.abort("cancelled by test");
    const abortError = await aborted.then(() => undefined, (error: unknown) => error);
    expect(abortError).toMatchObject({ code: "ABORTED" });
    await waitForFileContents(join(ownerHome, "observations.jsonl"), (contents) => contents.includes('"kind":"abort-cancelled"'));

    await owner.kill("SIGKILL");
    await expect(owner.get("after-crash")).rejects.toMatchObject({ code: "CLIENT_CRASHED" });
    const bootsAfterCrash = (await readFile(join(ownerHome, "observations.jsonl"), "utf8")).split("\n").filter((line) => line.includes('"kind":"boot"'));
    expect(bootsAfterCrash).toHaveLength(1);

    process.env.HARNESS_NODE = "node";
    await owner.restart({ auth: "restore" });
    await waitForFileContents(stderrArtifactPath, (contents) => (contents.match(/sdk-driver-stderr-canary/g) ?? []).length >= 2);
    expect((await readFile(owner.stderrArtifactPath, "utf8")).match(/sdk-driver-stderr-canary/g)).toHaveLength(3);
    expect(owner.stderr.match(/sdk-driver-stderr-canary/g)).toHaveLength(2);
    expect((await owner.get("restored"))).toMatchObject({ ok: true, found: true });
    const ownerProof = JSON.parse(await readFile(join(ownerHome, "session.json"), "utf8")) as Record<string, unknown>;
    const ownerSession = ownerProof.session as Record<string, unknown>;
    const ownerJwk = ownerSession.jwk as Record<string, unknown>;
    const ownerDelegationHeader = (ownerSession.delegationHeader as { Authorization: string }).Authorization;
    expect(ownerJwk.d).toBeTruthy();
    expect((await owner.authority()).grantExpiresAt).toBeNull();
    expect((await owner.authority()).sessionExpiresAt).toBeGreaterThan(Date.now());
    expect(await owner.status()).toEqual([]);

    process.env.HARNESS_NODE = "node";
    delegate = new SdkClientImpl({
      id: "device", host: "https://node.example", domain: "node.example",
      home: join(root, "device-home"), storageDir: join(root, "device-replica"),
      sdkLoader: loaderPath, auth: "session-only",
    });
    expect((await delegate.rpc("hello", {})).node).toMatch(/^v\d+\.\d+\.\d+/);
    const deviceKey = await delegate.rpc("session.deviceKey", {});
    expect(deviceKey.did).not.toBe(ownerSession.verificationMethod);
    const grant = await owner.rpc("grant.issue", {
      audience: deviceKey.did,
      caps: [{ prefix: "notes/", actions: ["get", "sync"] }],
      expiresInMs: 60_000,
    });
    await delegate.rpc("session.useDelegation", { delegation: grant.delegation, hosts: ["https://node.example"] });
    expect((await delegate.authority()).posture).toBe("delegate-session");
    expect((await delegate.authority()).grantExpiresAt).toBe(Date.parse(grant.expiresAt));
    await expect(delegate.rpc("session.restore", { session: ownerSession, hosts: ["https://node.example"] }))
      .rejects.toMatchObject({ code: "CLIENT_UNSUPPORTED_OPTION" });
    expect(await delegate.authority()).toMatchObject({ posture: "delegate-session", grantExpiresAt: Date.parse(grant.expiresAt) });
    await expect(delegate.restart({ auth: "fresh-sign-in" })).rejects.toMatchObject({ code: "CLIENT_UNSUPPORTED_OPTION" });
    expect((await delegate.get("notes/authorized")).found).toBe(true);
    const deviceProofText = await readFile(join(root, "device-home", "session.json"), "utf8");
    const proof = JSON.parse(deviceProofText) as Record<string, unknown>;
    const deviceJwk = proof.deviceJwk as Record<string, unknown>;
    expect(proof.session).toBeUndefined();
    expect(deviceJwk.d).toBeTruthy();
    expect(deviceJwk.x).not.toBe(ownerJwk.x);
    expect(deviceProofText).not.toContain(String(ownerJwk.d));
    expect(deviceProofText).not.toContain(ownerDelegationHeader);
    expect(deviceProofText).not.toContain("owner-secret-do-not-persist");
    await expect(delegate.put("outside-grant", "blocked")).resolves.toMatchObject({ ok: false, code: "AUTH_UNAUTHORIZED" });
    expect(await delegate.get("notes/allowed", { source: "network" })).toMatchObject({ ok: true, found: true });
    await delegate.restart({ auth: "restore" });
    expect((await delegate.authority()).grantExpiresAt).toBe(Date.parse(grant.expiresAt));
    await expect(delegate.put("outside-grant", "blocked-after-restore")).resolves.toMatchObject({ ok: false, code: "AUTH_UNAUTHORIZED" });
    const delegateProofBeforeHost = await readFile(join(root, "device-home", "session.json"), "utf8");
    const delegateHost = delegate.withHost("https://nodeb.example") as SdkClientImpl;
    expect((await delegateHost.get("notes/allowed")).found).toBe(true);
    expect(await delegateHost.authority()).toMatchObject({ posture: "delegate-session", grantExpiresAt: Date.parse(grant.expiresAt) });
    expect(await readFile(join(root, "device-home", "session.json"), "utf8")).toBe(delegateProofBeforeHost);
    const delegateHostProof = await readFile(join(delegateHost.home(), "session.json"), "utf8");
    expect(delegateHostProof).not.toContain(String(ownerJwk.d));
    expect(delegateHostProof).not.toContain(ownerDelegationHeader);

    process.env.HARNESS_NODE = "/missing/harness-node";
    sessionOnly = new SdkClientImpl({ id: "empty-device", host: "https://node.example", domain: "node.example", home: join(root, "empty-device-home"), storageDir: join(root, "empty-device-replica"), sdkLoader: loaderPath, node: "node", auth: "session-only" });
    expect((await sessionOnly.rpc("hello", {})).node).toMatch(/^v\d+\.\d+\.\d+/);
    expect((await sessionOnly.authority()).posture).toBe("delegate-session");
    const ownerObservations = (await readFile(join(ownerHome, "observations.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string; privateKeyProvided?: boolean; runtime?: string });
    expect(ownerObservations.filter((item) => item.kind === "sign-in")).toHaveLength(1);
    expect(ownerObservations.filter((item) => item.kind === "init").map((item) => item.privateKeyProvided)).toEqual([true, true]);
    expect(ownerObservations.filter((item) => item.kind === "boot").every((item) => item.runtime === "node")).toBe(true);
    const deviceObservations = (await readFile(join(root, "device-home", "observations.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string; privateKeyProvided?: boolean });
    expect(deviceObservations.filter((item) => item.kind === "sign-in")).toHaveLength(0);
    expect(deviceObservations.filter((item) => item.kind === "init").map((item) => item.privateKeyProvided)).toEqual([false, false]);
    const emptyDeviceObservations = (await readFile(join(root, "empty-device-home", "observations.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string; privateKeyProvided?: boolean });
    expect(emptyDeviceObservations.filter((item) => item.kind === "sign-in")).toHaveLength(0);
    expect(emptyDeviceObservations.filter((item) => item.kind === "init").map((item) => item.privateKeyProvided)).toEqual([false]);
    expect(await owner.rpc("replication.purge", { timeoutMs: 123 })).toEqual({ purged: ["notes/"], failed: [] });
    expect(await owner.status()).toEqual([]);
  } finally {
    await Promise.all([owner?.close({ deadlineMs: 100 }), delegate?.close({ deadlineMs: 100 }), sessionOnly?.close({ deadlineMs: 100 })].map((closing) => closing?.catch(() => undefined)));
    await rm(root, { recursive: true, force: true });
    for (const [key, value] of restoreEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 30_000);
test("SDK client rejects an undefined RPC value as a coded protocol error", async () => {
  const client = new SdkClientImpl({
    id: "malformed", host: "https://node.example", domain: "node.example",
    home: "/tmp/tc893-malformed-home", storageDir: "/tmp/tc893-malformed-replica", sdkLoader: "/tmp/unused.mjs",
  });
  let rejectResult!: (error: unknown) => void;
  const rejected = new Promise<unknown>((_resolve, reject) => { rejectResult = reject; });
  const internals = client as unknown as {
    pending: Map<number, { op: string; resolve(value: unknown): void; reject(error: unknown): void }>;
    receive(line: string): void;
  };
  internals.pending.set(9, { op: "kv.get", resolve: () => {}, reject: rejectResult });
  internals.receive(JSON.stringify({ v: 1, type: "response", id: 9, ok: true }));
  const error = await rejected.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HarnessError);
  expect(error).toMatchObject({ code: "RPC_PROTOCOL" });
});
test("SDK client validates operation-specific RPC result shapes", async () => {
  const client = new SdkClientImpl({
    id: "malformed-shapes", host: "https://node.example", domain: "node.example",
    home: "/tmp/tc893-malformed-shapes-home", storageDir: "/tmp/tc893-malformed-shapes-replica", sdkLoader: "/tmp/unused.mjs",
  });
  const internals = client as unknown as {
    pending: Map<number, { op: string; resolve(value: unknown): void; reject(error: unknown): void }>;
    receive(line: string): void;
  };
  const malformed: [string, unknown][] = [
    ["kv.get", { found: true, value: {} }],
    ["kv.get", { found: true, value: 5 }],
    ["kv.get", { found: true }],
    ["kv.list", {}],
    ["kv.batchPut", { written: 5 }],
    ["replication.clearPending", { cleared: "many" }],
    ["kv.put", { ok: false, error: { message: "missing code" } }],
  ];
  for (const [index, [op, value]] of malformed.entries()) {
    const id = index + 1;
    let rejectResult!: (error: unknown) => void;
    const rejected = new Promise<unknown>((_resolve, reject) => { rejectResult = reject; });
    internals.pending.set(id, { op, resolve: () => {}, reject: rejectResult });
    internals.receive(JSON.stringify({ v: 1, type: "response", id, ok: true, value }));
    const error = await rejected.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HarnessError);
    expect(error).toMatchObject({ code: "RPC_PROTOCOL" });
  }
});

test("SDK withHost clients are cached, share event artefacts, and close with their parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "tc893-sdk-host-lifecycle-"));
  const home = join(root, "parent-home");
  const oldNode = process.env.HARNESS_NODE;
  process.env.HARNESS_NODE = "node";
  const loaderPath = join(root, "fake-sdk.mjs");
  await writeFile(loaderPath, loaderSource, { mode: 0o600 });
  const parent = new SdkClientImpl({
    id: "host-lifecycle", host: "https://node-a.example", domain: "node-a.example",
    home, storageDir: join(root, "replica"), sdkLoader: loaderPath, auth: "fresh-sign-in",
    privateKeyHex: "synthetic-owner-key", hostAliases: { b: "https://node-b.example" },
    replication: { prefixes: ["notes/"], mode: "foreground", storageDir: join(root, "replica") },
  });
  try {
    await parent.rpc("hello", {});
    const sessionBefore = await readFile(join(home, "session.json"), "utf8");
    const child = parent.withHost("b") as SdkClientImpl;
    expect(parent.withHost("https://node-b.example")).toBe(child);
    expect(child.home()).not.toBe(parent.home());
    expect(child.home().startsWith(join(parent.home(), "hosts") + "/")).toBe(true);
    const reads = Array.from({ length: 5 }, (_unused, index) => [
      parent.get(`parent-${index}`),
      child.get(`child-${index}`),
    ]).flat();
    const results = await Promise.all(reads);
    expect(new Set(results.map((result) => result.opSeq)).size).toBe(10);
    expect(parent.events()).toHaveLength(10);
    expect(child.events()).toHaveLength(10);
    const events = (await readFile(parent.eventsArtifactPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seq: number });
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 10 }, (_unused, index) => index + 1));
    expect(await readFile(join(home, "session.json"), "utf8")).toBe(sessionBefore);
    const childProcess = (child as unknown as { process?: { exitCode: number | null; signalCode: NodeJS.Signals | null } }).process;
    expect(childProcess).toBeDefined();
    expect((await parent.close({ deadlineMs: 5_000 })).graceful).toBe(true);
    expect(childProcess!.exitCode !== null || childProcess!.signalCode !== null).toBe(true);
    expect(await readFile(join(home, "session.json"), "utf8")).toBe(sessionBefore);
  } finally {
    await parent.close({ deadlineMs: 5_000 }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    if (oldNode === undefined) delete process.env.HARNESS_NODE;
    else process.env.HARNESS_NODE = oldNode;
  }
});
