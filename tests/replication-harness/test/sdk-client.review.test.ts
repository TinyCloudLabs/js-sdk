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
const logPath = process.env.TC893_HOME + "/observations.jsonl";
const record = (entry) => appendFileSync(logPath, JSON.stringify(entry) + "\n");
record({ kind: "boot", nodeVersion: process.version, bunType: typeof process.versions.bun, runtime: process.versions.bun === undefined ? "node" : "bun/" + process.versions.bun, env: Object.keys(process.env).sort() });
console.error("sdk-driver-stderr-canary");
class TinyCloudNode {
  constructor(options) {
    this.options = options;
    this.restorableSession = undefined;
    record({ kind: "init", privateKeyProvided: options.privateKey !== undefined });
    this.kv = {
      get: async (key, options = {}) => {
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
        return { ok: true, data: { data: new Uint8Array([42]) } };
      },
      put: async (key) => key === "denied" ? { ok: false, error: { code: "AUTH_REQUIRED", message: "login required" } } : { ok: true, data: {} },
      delete: async () => ({ ok: true, data: {} }),
      list: async () => ({ ok: true, data: { keys: [] } }),
      batchPut: async () => ({ ok: true, data: { written: [] } }),
    };
    this.replication = { status: async () => [], sync: async () => ({ ok: false, error: { code: "REPLICA_UNAVAILABLE" } }), purge: async () => ({ ok: false, error: { code: "REPLICA_UNAVAILABLE" } }), clearPending: async () => ({ ok: false, error: { code: "REPLICA_UNAVAILABLE" } }) };
  }
  async signIn() {
    record({ kind: "sign-in" });
    this.restorableSession = { spaceId: "owner-space", expiresAt: new Date(Date.now() + 60000).toISOString(), jwk: { kty: "OKP", x: "owner-public", d: "device-session-secret" }, verificationMethod: "did:owner", address: "0xowner", chainId: 1, siwe: "signed owner session", signature: "signature" };
  }
  async restoreSession(session) {
    record({ kind: "restore" });
    this.restorableSession = session;
  }
  async delegateTo(audience, caps, options) {
    const delegation = { delegationHeader: { Authorization: "Bearer grant" }, cid: "grant-cid", spaceId: this.restorableSession.spaceId, expiry: new Date(Date.now() + options.expiry).toISOString() };
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
    await expect(invalidConstruction("delegate-session", { key: "unsupported" })).rejects.toThrow(/deviceJwk/);
    owner = new SdkClientImpl({ id: "owner", host: "https://node.example", domain: "node.example", home: ownerHome, storageDir: join(root, "owner-replica"), sdkLoader: loaderPath, privateKeyHex: "owner-secret-do-not-persist", auth: "fresh-sign-in" });
    const stderrArtifactPath = owner.stderrArtifactPath;
    const hello = await owner.rpc("hello", {});
    expect(hello.driver).toBe("tc893-sdk-driver");
    expect(hello.node).toMatch(/^v\d+\.\d+\.\d+/);
    expect(hello.node).not.toContain("bun/");

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
    expect(await owner.rpc("kv.put", { key: "denied", value: { $b64: "eA==" } })).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(await owner.put("denied", "x")).toMatchObject({ ok: false, outcome: "failed", code: "AUTH_REQUIRED" });
    expect(await owner.purge()).toMatchObject({ ok: false, code: "REPLICA_UNAVAILABLE", purged: [], failed: [] });
    expect(await owner.clearPending()).toMatchObject({ ok: false, code: "REPLICA_UNAVAILABLE", cleared: 0 });

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
    expect((await readFile(owner.stderrArtifactPath, "utf8")).match(/sdk-driver-stderr-canary/g)).toHaveLength(2);
    expect(owner.stderr.match(/sdk-driver-stderr-canary/g)).toHaveLength(2);
    expect((await owner.get("restored"))).toMatchObject({ ok: true, found: true });
    await owner.rpc("session.deviceKey", {});
    const grant = await owner.rpc("grant.issue", { audience: "did:device", caps: [{ prefix: "notes/", actions: ["get"] }], expiresInMs: 60_000 });
    expect((await owner.authority()).grantExpiresAt).toBeNull();

    const proof = JSON.parse(await readFile(join(ownerHome, "session.json"), "utf8")) as Record<string, unknown>;
    expect(proof.deviceJwk).toBeTruthy();
    expect(proof.verificationMethod).toBeTruthy();
    expect(proof.delegation).toBeTruthy();
    expect(JSON.stringify(proof)).not.toContain("owner-secret-do-not-persist");

    process.env.HARNESS_NODE = "node";
    delegate = new SdkClientImpl({ id: "device", host: "https://node.example", domain: "node.example", home: join(root, "device-home"), storageDir: join(root, "device-replica"), sdkLoader: loaderPath, auth: "session-only", delegation: proof });
    expect((await delegate.rpc("hello", {})).node).toMatch(/^v\d+\.\d+\.\d+/);
    expect((await delegate.authority()).posture).toBe("delegate-session");
    expect((await delegate.authority()).grantExpiresAt).toBe(Date.parse(grant.expiresAt));
    expect(await readFile(join(root, "device-home", "session.json"), "utf8")).not.toContain("owner-secret-do-not-persist");
    await delegate.restart({ auth: "restore" });
    expect((await delegate.authority()).grantExpiresAt).toBe(Date.parse(grant.expiresAt));

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
  } finally {
    await Promise.all([owner?.close({ deadlineMs: 100 }), delegate?.close({ deadlineMs: 100 }), sessionOnly?.close({ deadlineMs: 100 })].map((closing) => closing?.catch(() => undefined)));
    await rm(root, { recursive: true, force: true });
    for (const [key, value] of restoreEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 30_000);
