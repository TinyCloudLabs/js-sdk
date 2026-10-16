import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TinyCloudNode, PrivateKeySigner } from "@tinycloud/node-sdk";
import * as wasm from "@tinycloud/node-sdk-wasm";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

// TC-834 S3-T9: `tc secrets request` / `tc secrets wait` against a real local
// node, pinning the consent-before-hosting spike (/tmp/tc834/spike). A
// recording proxy sits in front of the node; the agent CLI and the owner SDK
// talk to it through separate listeners so each request is attributed.

const NODE_BIN = process.env.TC_REPLICA_E2E_NODE_BIN;
const CLI = resolve(import.meta.dir, "../dist/bootstrap.js");
const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TC_")));

type Run = { code: number; stdout: string; stderr: string; startedAt: number; endedAt: number };
type Recorded = {
  seq: number;
  who: "agent" | "owner";
  method: string;
  path: string;
  status: number;
  authorization?: string;
  responseBody?: string;
};
type Proxy = { url: string; stop: () => void };

const childProcesses = new Set<ChildProcess>();

function trackChild(child: ChildProcess): ChildProcess {
  childProcesses.add(child);
  child.on("error", () => {});
  child.once("close", () => childProcesses.delete(child));
  return child;
}

async function freePort(): Promise<number> {
  const { promise, resolve: done, reject: fail } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", fail);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    server.close(() => done(port));
  });
  return promise;
}

describe.skipIf(!NODE_BIN)("tc secrets request/wait against a real local node (S3-T9)", () => {
  let home: string;
  let temp: string;
  let nodeUrl: string;
  let agentProxy: Proxy;
  let ownerProxy: Proxy;
  let node: ChildProcess | undefined;
  const log: Recorded[] = [];
  const agentWaitRuns: { step: string; from: number; to: number }[] = [];
  let onRecord: ((entry: Recorded) => void) | undefined;
  const nodeSecret = randomBytes(48).toString("base64url");
  const suffix = randomBytes(4).toString("hex").toUpperCase();
  const NAME = `TC834_A_${suffix}`;
  const SECOND = `TC834_B_${suffix}`;
  const UNGRANTED = `TC834_C_${suffix}`;
  const path = (name: string) => `vault/secrets/${name}`;

  // Owner state (built exactly as /tmp/tc834/spike/spike.ts:104-125).
  let ownerNode: TinyCloudNode;
  let ownerAddress: string;
  let secretsId: string;
  let restoreHosting: () => void;
  let agentGrantAuthorization: string;
  let hostMark = 0;

  function startProxy(who: Recorded["who"]): Proxy {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const incoming = new URL(request.url);
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
        const headers = new Headers(request.headers);
        headers.delete("host");
        const upstream = await fetch(`${nodeUrl}${incoming.pathname}${incoming.search}`, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
        });
        const bytes = await upstream.arrayBuffer();
        const entry: Recorded = {
          seq: log.length,
          who,
          method: request.method,
          path: incoming.pathname,
          status: upstream.status,
        };
        if (incoming.pathname === "/delegate") entry.authorization = request.headers.get("authorization") ?? undefined;
        if (!upstream.ok || incoming.pathname === "/delegate") entry.responseBody = new TextDecoder().decode(bytes).slice(0, 2_000);
        log.push(entry);
        onRecord?.(entry);
        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
        responseHeaders.delete("transfer-encoding");
        return new Response(bytes, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  async function startNode(nodeData: string, port: number): Promise<void> {
    const child = trackChild(spawn(NODE_BIN!, [], {
      cwd: nodeData,
      env: {
        ...ambient,
        TMPDIR: temp,
        TINYCLOUD_STORAGE__DATADIR: join(nodeData, "data"),
        TINYCLOUD_PORT: String(port),
        TINYCLOUD_ADDRESS: "127.0.0.1",
        ROCKET_PORT: String(port),
        ROCKET_ADDRESS: "127.0.0.1",
        TINYCLOUD_KEYS__TYPE: "Static",
        TINYCLOUD_KEYS__SECRET: nodeSecret,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }));
    node = child;
    const launched = Promise.withResolvers<void>();
    let window = "";
    const onData = (chunk: Buffer) => {
      window = (window + chunk.toString()).slice(-64);
      if (window.includes("Rocket has launched")) launched.resolve();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("close", (code) => launched.reject(new Error(`local node exited before launch (${code ?? -1})`)));
    await launched.promise;
  }

  async function tc(args: string[], profile: string): Promise<Run> {
    const startedAt = Date.now();
    const child = trackChild(spawn("node", [CLI, "-q", "--json", "--profile", profile, ...args], {
      cwd: home,
      env: { ...ambient, TMPDIR: temp, TC_HOME: home, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    }));
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number>((done) => child.once("close", (exit) => done(exit ?? -1)));
    return {
      code,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
      startedAt,
      endedAt: Date.now(),
    };
  }

  async function ok<T>(args: string[], profile: string): Promise<T> {
    const run = await tc(args, profile);
    if (run.code !== 0) throw new Error(`tc ${args.join(" ")} exited ${run.code}: ${run.stderr}`);
    return JSON.parse(run.stdout) as T;
  }

  /** One agent `wait` run; every request it makes through the proxy is attributed to it. */
  async function agentWait(step: string, args: string[]): Promise<Run & { requests: Recorded[] }> {
    const from = log.length;
    const run = await tc(["secrets", "wait", ...args], "agent");
    const to = log.length;
    agentWaitRuns.push({ step, from, to });
    const requests = log.slice(from, to);
    expect(requests.every((entry) => entry.who === "agent")).toBe(true);
    return { ...run, requests };
  }

  function summary(entries: readonly Recorded[]): string[] {
    return entries.map((entry) => `${entry.who} ${entry.method} ${entry.path} ${entry.status}`);
  }

  function report(step: string, entries: readonly Recorded[], extra: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ step, ...extra, requests: summary(entries) }));
  }

  async function ownerEtag(name: string): Promise<string | undefined> {
    const got = await ownerNode.kvForSpace(secretsId).get(path(name), { raw: true, prefix: "" });
    if (!got.ok) throw new Error(`owner could not read ${name}`);
    const data: unknown = got.data;
    if (!data || typeof data !== "object" || !("headers" in data)) return undefined;
    const headers: unknown = data.headers;
    if (!headers || typeof headers !== "object" || !("etag" in headers)) return undefined;
    return typeof headers.etag === "string" ? headers.etag : undefined;
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "tc834-wait-home-"));
    temp = join(home, "tmp");
    await mkdir(temp, { mode: 0o700 });
    const nodeData = await mkdtemp(join(temp, "node-"));
    const port = await freePort();
    nodeUrl = `http://127.0.0.1:${port}`;
    await startNode(nodeData, port);
    agentProxy = startProxy("agent");
    ownerProxy = startProxy("owner");

    // ---- Owner: exactly as spike.ts:104-125 (secrets left unhosted at sign-in). ----
    const pk = "0x" + randomBytes(32).toString("hex");
    const signer = new PrivateKeySigner(pk);
    ownerAddress = wasm.ensureEip55(await signer.getAddress());
    secretsId = wasm.makeSpaceId(ownerAddress, 1, "secrets");
    ownerNode = new TinyCloudNode({
      host: ownerProxy.url,
      privateKey: pk,
      autoCreateSpace: true,
      autoBootstrapAccount: false,
      autoDiscoverLocalNode: false,
    });
    // TS-private method; patched so signIn() leaves `secrets` unhosted the way a
    // fresh owner who never used Secret Manager has it. If the method drifts,
    // this guard fails the suite instead of letting it pass falsely.
    const internals = ownerNode as unknown as { ensureOwnedSpaceHostedById(spaceId: string): Promise<void> };
    const original = internals.ensureOwnedSpaceHostedById;
    if (typeof original !== "function") throw new Error("node-sdk drift: ensureOwnedSpaceHostedById is gone");
    internals.ensureOwnedSpaceHostedById = async (spaceId: string) => {
      if (spaceId === secretsId) return;
      return original.call(ownerNode, spaceId);
    };
    restoreHosting = () => { internals.ensureOwnedSpaceHostedById = original; };
    await ownerNode.signIn();
    await ownerNode.ensureEncryptionNetwork();
  }, 180_000);

  afterAll(async () => {
    agentProxy?.stop();
    ownerProxy?.stop();
    for (const child of childProcesses) child.kill("SIGKILL");
    if (home) await rm(home, { recursive: true, force: true });
  });

  test("(P) the owner's secrets space is not hosted: raw get answers 404 Space not found", async () => {
    const from = log.length;
    const got = await ownerNode.kvForSpace(secretsId).get(path(NAME), { raw: true, prefix: "" });
    const requests = log.slice(from);
    report("P", requests);
    expect(got.ok).toBe(false);
    expect(requests.some((entry) => entry.status === 404 && (entry.responseBody ?? "").includes("Space not found"))).toBe(true);
  });

  test("(G) the agent's grant is skipped on <owner>:secrets, then imported into a delegate-session profile", async () => {
    await ok(["profile", "create", "agent", "--posture", "delegate-session", "--host", agentProxy.url], "agent");
    const agentProfile = JSON.parse(await readFile(join(home, ".tinycloud", "profiles", "agent", "profile.json"), "utf8")) as { did: string };
    const agentDid = agentProfile.did.split("#", 1)[0]!;
    const from = log.length;
    const issued = await ownerNode.delegateTo(agentDid, [
      { service: "tinycloud.kv", space: "secrets", path: path(NAME), actions: ["tinycloud.kv/get"] },
      { service: "tinycloud.kv", space: "secrets", path: path(SECOND), actions: ["tinycloud.kv/get"] },
    ], { expiry: "1h" });
    const requests = log.slice(from);
    report("G delegateTo", requests);
    agentGrantAuthorization = issued.delegation.delegationHeader.Authorization;
    const delegatePost = requests.find((entry) => entry.method === "POST" && entry.path === "/delegate" && entry.authorization === agentGrantAuthorization);
    expect(delegatePost?.status).toBe(200);
    const receipt = JSON.parse(delegatePost!.responseBody!) as { skipped?: string[] };
    expect(receipt.skipped).toContain(secretsId);

    // `host` is unsigned routing metadata. Both proxy listeners forward to the
    // same node; the agent's copy names its own listener so its traffic stays
    // attributable while the owner writes concurrently (c2).
    await writeFile(join(home, "grant.json"), JSON.stringify({ ...issued.delegation, host: agentProxy.url }));
    const importFrom = log.length;
    await ok(["auth", "import", "grant.json"], "agent");
    report("G auth import", log.slice(importFrom));
  }, 60_000);

  test("(a) request exits 0 with the owner in EIP-55 form", async () => {
    const from = log.length;
    const run = await tc(["secrets", "request", NAME], "agent");
    report("a", log.slice(from), { exit: run.code, ms: run.endedAt - run.startedAt });
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout) as { url: string; names: string[]; owner: string };
    expect(out.names).toEqual([NAME]);
    expect(out.owner).toBe(`did:pkh:eip155:1:${ownerAddress}`);
    expect(out.owner.endsWith(ownerAddress)).toBe(true);
    expect(typeof out.url).toBe("string");
    expect(log.length).toBe(from);
  });

  test("(b) wait --timeout 0 before hosting → 8 pending, and the agent's /invoke gets Space not found", async () => {
    const run = await agentWait("b", [NAME, "--timeout", "0"]);
    report("b", run.requests, { exit: run.code, ms: run.endedAt - run.startedAt });
    expect(run.code).toBe(8);
    const out = JSON.parse(run.stdout) as { status: string; pending: string[]; present: string[] };
    expect(out.status).toBe("pending");
    expect(out.pending).toEqual([NAME]);
    expect(out.present).toEqual([]);
    expect(run.requests.some((entry) => entry.path === "/invoke" && (entry.responseBody ?? "").includes("Space not found"))).toBe(true);
  }, 60_000);

  test("(H) the owner hosts secrets and writes the value; (c) wait → ready with no re-POST of the agent grant", async () => {
    const hostFrom = log.length;
    restoreHosting();
    await ownerNode.hostOwnedSpace("secrets");
    const put = await ownerNode.secrets.put(NAME, `tc834-${randomBytes(24).toString("base64url")}`);
    expect(put.ok).toBe(true);
    hostMark = log.length;
    report("H", log.slice(hostFrom));

    const run = await agentWait("c", [NAME, "--timeout", "30s"]);
    report("c", run.requests, { exit: run.code, ms: run.endedAt - run.startedAt });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ status: "ready", names: [NAME] });
    const regrants = log.slice(hostMark).filter((entry) =>
      entry.method === "POST" && entry.path === "/delegate" && entry.authorization === agentGrantAuthorization);
    expect(regrants).toEqual([]);
  }, 90_000);

  test("(c2) wait is ready within one poll interval of a second write", async () => {
    const from = log.length;
    const waiting = tc(["secrets", "wait", SECOND, "--timeout", "60s"], "agent");
    // Write once the first (pending) attempt has reached the node.
    const firstInvoke = Promise.withResolvers<void>();
    onRecord = (entry) => { if (entry.who === "agent" && entry.path === "/invoke") firstInvoke.resolve(); };
    await Promise.race([firstInvoke.promise, waiting.then((run) => {
      throw new Error(`wait exited ${run.code} before its first probe reached the node: ${run.stderr}`);
    })]);
    onRecord = undefined;
    const put = await ownerNode.secrets.put(SECOND, `tc834-${randomBytes(24).toString("base64url")}`);
    expect(put.ok).toBe(true);
    const writtenAt = Date.now();
    const run = await waiting;
    const to = log.length;
    agentWaitRuns.push({ step: "c2", from, to });
    const agentRequests = log.slice(from, to).filter((entry) => entry.who === "agent");
    const readyAfterWriteMs = run.endedAt - writtenAt;
    report("c2", agentRequests, { exit: run.code, ms: run.endedAt - run.startedAt, readyAfterWriteMs });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ status: "ready", names: [SECOND] });
    // The write lands right after the first (pending) attempt, so the very next
    // attempt — one 3 s poll interval later — must see it: exactly two probes,
    // and ready within the interval plus one probe child's start-up and request.
    expect(agentRequests.filter((entry) => entry.path === "/invoke").length).toBe(2);
    expect(readyAfterWriteMs).toBeLessThan(3_000 + 5_000);
  }, 90_000);

  test("(d) an ungranted name → 5 PERMISSION_DENIED", async () => {
    const run = await agentWait("d", [UNGRANTED, "--timeout", "0"]);
    report("d", run.requests, {
      exit: run.code,
      ms: run.endedAt - run.startedAt,
      refusals: run.requests.filter((entry) => entry.status >= 400).map((entry) => entry.responseBody),
      stderr: run.stderr,
    });
    expect(run.code).toBe(5);
    const error = (JSON.parse(run.stderr) as { error: { code: string; recovery?: { action: string; names: string[] } } }).error;
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.recovery?.action).toBe("request_access");
    expect(error.recovery?.names).toEqual([UNGRANTED]);
  }, 60_000);

  test("(e) no decrypt request is ever made", () => {
    expect(log.filter((entry) => entry.path.includes("decrypt"))).toEqual([]);
  });

  test("(f) ifAbsent on an existing secret → ALREADY_EXISTS with 412, etag unchanged", async () => {
    const before = await ownerEtag(NAME);
    expect(typeof before).toBe("string");
    const from = log.length;
    const put = await ownerNode.secrets.put(NAME, "overwrite-attempt", { ifAbsent: true });
    const requests = log.slice(from);
    report("f", requests);
    expect(put.ok).toBe(false);
    if (put.ok) return;
    expect(put.error.code).toBe("ALREADY_EXISTS");
    expect(requests.some((entry) => entry.path === "/invoke" && entry.status === 412)).toBe(true);
    expect(await ownerEtag(NAME)).toBe(before);
  });

  test("(R4-1) every agent wait run sent only POST /invoke", () => {
    expect(agentWaitRuns.map(({ step }) => step)).toEqual(["b", "c", "c2", "d"]);
    for (const { step, from, to } of agentWaitRuns) {
      const agentRequests = log.slice(from, to).filter((entry) => entry.who === "agent");
      expect(agentRequests.length > 0).toBe(true);
      const other = agentRequests.filter((entry) => entry.method !== "POST" || entry.path !== "/invoke");
      if (other.length > 0) console.log(JSON.stringify({ step, unexpected: summary(other) }));
      expect(other).toEqual([]);
    }
  });
});
