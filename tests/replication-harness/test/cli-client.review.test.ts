import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { CliClientImpl, createCliClient, createCliDelegation, reuseCliOwnerIdentity, scrubClientEnvironment } from "../src/clients/cli-client";
import { forgetSdkIdentityKeys, sdkIdentityPrivateKey } from "../src/clients/identity";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tc893-cli-review-"));
  roots.push(path);
  return path;
}

async function cliEntry(root: string, source: string): Promise<string> {
  const path = join(root, "fake-cli.mjs");
  await writeFile(path, source);
  return path;
}
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { /* The child has not created the marker yet. */ }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
  throw new Error(`Timed out waiting for ${path}`);
}


async function containsFileText(directory: string, needle: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await containsFileText(path, needle)) return true;
    } else if ((await readFile(path)).includes(needle)) return true;
  }
  return false;
}

describe("CLI review fixes", () => {
  test("passes only the CLI allowlist and deliberately set replication values", () => {
    const env = scrubClientEnvironment({
      PATH: "/usr/bin",
      HOME: "/ambient/home",
      TC_HOME: "/ambient/tc-home",
      TC_OPENKEY_HOST: "https://ambient.invalid",
      TC_REPLICATION_VERIFY: "ambient",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      TZ: "UTC",
      NPM_TOKEN: "secret",
      NODE_AUTH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      npm_config_registry: "https://registry.invalid",
      npm_config_user_agent: "ambient",
      npm_lifecycle_event: "test",
      npm_lifecycle_script: "ambient script",
      HTTP_PROXY: "http://proxy.invalid",
      HTTPS_PROXY: "http://proxy.invalid",
      http_proxy: "http://proxy.invalid",
      https_proxy: "http://proxy.invalid",
      ALL_PROXY: "http://proxy.invalid",
      NO_PROXY: "registry.invalid",
      ARBITRARY: "not inherited",
      toString: "must not exploit inherited allowlist entries",
    }, "/isolated/home", {
      TC_REPLICATION_VERIFY: "1",
      TC_REPLICATION_MAX_STALENESS_MS: "50",
      TC_SECRET: "not approved",
      NPM_TOKEN: "override-secret",
      HTTP_PROXY: "http://override.invalid",
      constructor: "must not exploit inherited replication entries",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      TZ: "UTC",
      HOME: "/isolated/home",
      TC_HOME: "/isolated/home",
      TC_REPLICATION_VERIFY: "1",
      TC_REPLICATION_MAX_STALENESS_MS: "50",
    });
  });

  test("runs CLI entry points with real Node, isolated cwd, and no ambient secrets", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const leakedNames = ["HARNESS_NODE", "NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "npm_config_registry", "npm_config_user_agent", "npm_lifecycle_event", "npm_lifecycle_script", "NODE_OPTIONS", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "NO_PROXY", "TC_AMBIENT_SECRET", "TC_REPLICATION_VERIFY"];
    const previous = new Map<string, string | undefined>();
    for (const key of leakedNames) {
      previous.set(key, process.env[key]);
      process.env[key] = key === "HARNESS_NODE" ? "node" : `ambient-${key}`;
    }
    try {
      const entry = await cliEntry(root, `
const leakedNames = ${JSON.stringify(leakedNames)};
console.log(JSON.stringify({ release: process.release.name, version: process.versions.node, bunType: typeof process.versions.bun, execPath: process.execPath, cwd: process.cwd(), home: process.env.HOME, tcHome: process.env.TC_HOME, leaked: leakedNames.filter((name) => Object.hasOwn(process.env, name)) }));
`);
      const cli = new CliClientImpl({ id: "runtime", home, cliEntry: entry, host: "http://127.0.0.1" });
      const result = await cli.tc(["hello"]);
      const evidence = JSON.parse(Buffer.from(result.stdout).toString("utf8")) as Record<string, unknown>;
      expect(result.exit).toBe(0);
      expect(evidence).toMatchObject({ release: "node", bunType: "undefined", cwd: home, home, tcHome: home });
      expect(evidence.version).toBeTruthy();
      expect(evidence.execPath).toBeTruthy();
      expect(evidence.leaked).toEqual([]);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  test("applies ClientSpec replication configuration to CLI operations", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const entry = await cliEntry(root, `console.log(JSON.stringify(process.argv.slice(2)));`);
    const cli = new CliClientImpl({
      id: "configured-replication",
      home,
      cliEntry: entry,
      host: "http://node.example",
      replication: { prefixes: ["notes/"] },
    });
    const result = await cli.tc(["kv", "get", "notes/key"]);
    expect(JSON.parse(Buffer.from(result.stdout).toString("utf8"))).toContain("--replication");
  });

  test("rejects a CLI Node runtime below v22.13 before the SUT starts", async () => {
    const root = await temporaryDirectory();
    const node = join(root, "node-old");
    const marker = join(root, "sut-started");
    await writeFile(node, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'v22.12.0\\n'; exit 0; fi
printf started > '${marker}'
`);
    await chmod(node, 0o700);
    const entry = await cliEntry(root, `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(marker)}, "started"));`);
    const cli = new CliClientImpl({ id: "old-node", home: join(root, "home"), cliEntry: entry, host: "http://127.0.0.1", node });
    await expect(cli.tc(["must-not-run"])).rejects.toMatchObject({ code: "PREFLIGHT_FAILED" });
    await expect(stat(marker)).rejects.toThrow();
  });

  test("captures appended event bytes from both sides of a single log rotation", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const entry = await cliEntry(root, `
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const profile = process.argv[process.argv.indexOf("--profile") + 1];
if (process.argv.at(-1) === "rotate") {
  const file = join(process.env.TC_HOME, ".tinycloud", "profiles", profile, "replication", "events.jsonl");
  await mkdir(dirname(file), { recursive: true });
  await rename(file, file + ".1");
  await appendFile(file + ".1", JSON.stringify({ type: "rotation.previous" }) + "\\n");
  await writeFile(file, JSON.stringify({ type: "rotation.current" }) + "\\n");
}
`);
    const cli = new CliClientImpl({ id: "rotation", home, cliEntry: entry, host: "http://127.0.0.1" });
    const eventsPath = cli.eventsFile();
    await mkdir(dirname(eventsPath), { recursive: true });
    await writeFile(eventsPath, JSON.stringify({ type: "old.before.operation", value: "é雪" }) + "\n");
    const baseline = await cli.tc(["baseline"]);
    await cli.tc(["idle-1"]);
    await cli.tc(["idle-2"]);
    await cli.tc(["idle-3"]);
    const result = await cli.tc(["rotate"]);
    expect(baseline.exit).toBe(0);
    expect(baseline.events).toEqual([]);
    expect(result.exit).toBe(0);
    expect(result.opSeq).toBe(baseline.opSeq + 4);
    expect(result.events.map((item) => item.event.type)).toEqual(["rotation.previous", "rotation.current"]);
    expect(result.events.map((item) => item.seq)).toEqual([1, 2]);
    expect(result.events.every((item) => item.opSeq === result.opSeq && item.attribution === "op")).toBe(true);
  });

  test("attributes overlapping same-profile operations and shares event sequence across hosts", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const entry = await cliEntry(root, `
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const profile = args[args.indexOf("--profile") + 1];
const host = args[args.indexOf("--host") + 1];
const operation = args.at(-1);
const home = process.env.TC_HOME;
await writeFile(join(home, operation + ".ready"), "ready");
let bothReady = false;
while (!bothReady) {
  try {
    await access(join(home, "op-a.ready"));
    await access(join(home, "op-b.ready"));
    bothReady = true;
  } catch {
    const { promise, resolve } = Promise.withResolvers();
    setTimeout(resolve, 10);
    await promise;
  }
}
const file = join(home, ".tinycloud", "profiles", profile, "replication", "events.jsonl");
await mkdir(join(home, ".tinycloud", "profiles", profile, "replication"), { recursive: true });
await appendFile(file, JSON.stringify({ type: "replication.read", op: "get", key: operation, host }) + "\\n");
`);
    const cli = new CliClientImpl({ id: "overlap", home, cliEntry: entry, host: "http://host-a", profile: "shared" });
    const [first, second] = await Promise.all([
      cli.tc(["kv", "get", "op-a"]),
      cli.withHost("http://host-b").tc(["kv", "get", "op-b"]),
    ]);
    expect([first.opSeq, second.opSeq].sort((a, b) => a - b)).toEqual([1, 2]);
    const events = cli.events();
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ opSeq: first.opSeq, attribution: "op", event: { key: "op-a", host: "http://host-a" } });
    expect(second.events[0]).toMatchObject({ opSeq: second.opSeq, attribution: "op", event: { key: "op-b", host: "http://host-b" } });
    expect(events).toHaveLength(2);
    expect(events.map((item) => item.seq)).toEqual([1, 2]);
    expect(events.map((item) => item.event.key).sort()).toEqual(["op-a", "op-b"]);
    const peer = new CliClientImpl({ id: "overlap-peer", home, cliEntry: entry, host: "http://host-c", profile: "shared" });
    const [peerFirst, peerSecond] = await Promise.all([
      cli.tc(["kv", "get", "op-a"]),
      peer.tc(["kv", "get", "op-b"]),
    ]);
    expect(peerFirst.events.length + peerSecond.events.length).toBe(2);
    expect([...peerFirst.events, ...peerSecond.events].every((item) => item.attribution === "op" && item.opSeq !== null)).toBe(true);
    expect([...peerFirst.events, ...peerSecond.events].map((item) => item.event.key).sort()).toEqual(["op-a", "op-b"]);
    for (const collected of [cli.events(), peer.events()]) {
      expect(collected.map((item) => item.seq)).toEqual(Array.from({ length: collected.length }, (_unused, index) => index + 1));
    }
  });

  test("reports failed gets as not found only for exit 4 and emits client artefacts", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const artifacts = join(root, "artifacts");
    const entry = await cliEntry(root, `
const args = process.argv.slice(2);
const key = args[args.indexOf("get") + 1];
console.error("cli-stderr-canary");
if (key === "missing") process.exit(4);
if (key === "failed") process.exit(1);
if (key === "killed") process.kill(process.pid, "SIGKILL");
`);
    const cli = new CliClientImpl({ id: "get-results", home, artifactDirectory: artifacts, cliEntry: entry, host: "http://127.0.0.1" });
    const missing = await cli.get("missing");
    expect(missing).toMatchObject({ ok: true, found: false, code: "NOT_FOUND", exit: 4 });
    const failed = await cli.get("failed");
    expect(failed).toMatchObject({ ok: false, found: false, code: "EXIT_1", exit: 1 });
    const killed = await cli.get("killed");
    expect(killed).toMatchObject({ ok: false, found: false, code: "SIGNAL_SIGKILL", exit: null, signal: "SIGKILL" });
    await expect(cli.restart({ auth: "fresh-sign-in" })).rejects.toMatchObject({ code: "CLIENT_UNSUPPORTED_OPTION" });
    expect(await readFile(join(artifacts, "stderr.log"), "utf8")).toContain("cli-stderr-canary");
    await readFile(join(artifacts, "events.jsonl"), "utf8");
  });

  test("does not count ambiguous sync events and resolves withHost aliases to the client proxy", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const entry = await cliEntry(root, `
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const profile = args[args.indexOf("--profile") + 1];
const command = args[args.indexOf("--host") + 2];
const host = args[args.indexOf("--host") + 1];
if (args.includes("auth") && args.includes("login")) {
  await writeFile(join(process.env.TC_HOME, ".tinycloud", "profiles", profile, "session.json"), "{}");
  console.log(JSON.stringify({ login: true, host, profile }));
} else if (args.at(-1) === "hello") {
  console.log(JSON.stringify({ host, profile }));
} else {
  const kind = args.includes("get") ? "get" : "sync";
  await writeFile(join(process.env.TC_HOME, kind + ".ready"), "ready");
  while (true) {
    try { await access(join(process.env.TC_HOME, "get.ready")); await access(join(process.env.TC_HOME, "sync.ready")); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  const file = join(process.env.TC_HOME, ".tinycloud", "profiles", profile, "replication", "events.jsonl");
  await mkdir(join(process.env.TC_HOME, ".tinycloud", "profiles", profile, "replication"), { recursive: true });
  await appendFile(file, JSON.stringify({ type: "replication.sync", trigger: "manual", outcome: "ok" }) + "\\n");
  await writeFile(join(process.env.TC_HOME, kind + ".event-ready"), "ready");
  while (true) {
    try { await access(join(process.env.TC_HOME, "get.event-ready")); await access(join(process.env.TC_HOME, "sync.event-ready")); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
}
`);
    const sourceProfile = join(home, ".tinycloud", "profiles", "owner");
    await mkdir(sourceProfile, { recursive: true });
    await writeFile(join(sourceProfile, "key.json"), JSON.stringify({ kty: "EC", d: "owner-key" }), { mode: 0o600 });
    await writeFile(join(sourceProfile, "profile.json"), JSON.stringify({ privateKey: "a".repeat(64), authMethod: "local", posture: "local-owner-key" }), { mode: 0o600 });
    const cli = new CliClientImpl({
      id: "alias", home, cliEntry: entry, host: "http://host-a",
      hostAliases: { nodeb: "http://127.0.0.1:9876" }, profile: "owner",
      ownerPosture: true, runId: "alias-host-test", identity: "owner",
    });
    await cli.registerOwnerIdentity();
    const sync = cli.sync({ prefix: "notes/" });
    const overlappingGet = cli.get("notes/key");
    const [syncResult] = await Promise.all([sync, overlappingGet]);
    expect(syncResult).toMatchObject({ ok: false, syncs: [] });
    const aliasClient = cli.withHost("nodeb");
    const aliasResult = await aliasClient.tc(["hello"]);
    expect(JSON.parse(Buffer.from(aliasResult.stdout).toString("utf8"))).toMatchObject({ host: "http://127.0.0.1:9876" });
    expect(JSON.parse(Buffer.from(aliasResult.stdout).toString("utf8")).profile).not.toBe("owner");
  });

  test("preserves the actual signal on abort and returns deadline-exceeded for CLI get", async () => {
    // A real Node child is required here: fake time cannot exercise kernel signal delivery or close metadata.
    const root = await temporaryDirectory();
    const entry = await cliEntry(root, `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
process.stdout.write("started");
await writeFile(join(process.env.TC_HOME, "started"), "ready");
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`);
    const abortHome = join(root, "abort-home");
    await mkdir(abortHome, { recursive: true });
    const abortClient = new CliClientImpl({ id: "abort", home: abortHome, cliEntry: entry, host: "http://127.0.0.1" });
    const controller = new AbortController();
    const pending = abortClient.tc(["hold"], { signal: controller.signal });
    await Promise.race([waitForFile(join(abortHome, "started")), pending.then(() => { throw new Error("CLI child exited before startup was observed"); })]);
    controller.abort();
    const aborted = await pending;
    expect(aborted).toMatchObject({ exit: null, signal: "SIGKILL" });
    expect(Buffer.from(aborted.stdout).toString("utf8")).toContain("started");

    const deadlineHome = join(root, "deadline-home");
    const deadlineClient = new CliClientImpl({ id: "deadline", home: deadlineHome, cliEntry: entry, host: "http://127.0.0.1" });
    const timedOut = await deadlineClient.get("notes/key", { deadlineMs: 100 });
    expect(timedOut).toMatchObject({ ok: false, found: false, code: "DEADLINE_EXCEEDED", exit: null, signal: "SIGKILL" });
  }, 15_000);

  test("reuses one owner key for profiles sharing a run identity", async () => {
    const root = await temporaryDirectory();
    const runId = `identity-reuse-${crypto.randomUUID()}`;
    const identity = "shared-owner";
    const sourceHome = join(root, "source-home");
    const targetHome = join(root, "target-home");
    const sourceProfile = join(sourceHome, ".tinycloud", "profiles", "owner");
    const targetProfile = join(targetHome, ".tinycloud", "profiles", "owner");
    await mkdir(sourceProfile, { recursive: true });
    await mkdir(targetProfile, { recursive: true });
    const sourceKey = { kty: "EC", d: "source-did-key" };
    const targetKey = { kty: "EC", d: "target-did-key" };
    const sourceConfig = { name: "owner", did: "did:source", privateKey: "a".repeat(64), authMethod: "local", posture: "local-owner-key" };
    await writeFile(join(sourceProfile, "key.json"), JSON.stringify(sourceKey), { mode: 0o600 });
    await writeFile(join(sourceProfile, "profile.json"), JSON.stringify(sourceConfig), { mode: 0o600 });
    await writeFile(join(targetProfile, "key.json"), JSON.stringify(targetKey), { mode: 0o600 });
    await writeFile(join(targetProfile, "profile.json"), JSON.stringify({ ...sourceConfig, did: "did:target", privateKey: "b".repeat(64) }), { mode: 0o600 });
    const source = new CliClientImpl({ id: "owner-a", home: sourceHome, profile: "owner", cliEntry: join(root, "unused"), host: "http://127.0.0.1", ownerPosture: true, runId, identity });
    const target = new CliClientImpl({ id: "owner-b", home: targetHome, profile: "owner", cliEntry: join(root, "unused"), host: "http://127.0.0.1", ownerPosture: true, runId, identity });
    try {
      await source.registerOwnerIdentity();
      await reuseCliOwnerIdentity(targetHome, "owner", runId, identity);
      await target.registerOwnerIdentity();
      expect(await readFile(join(targetProfile, "key.json"), "utf8")).toBe(JSON.stringify(sourceKey));
      expect(JSON.parse(await readFile(join(targetProfile, "profile.json"), "utf8"))).toMatchObject({
        did: "did:source", privateKey: "a".repeat(64), authMethod: "local", posture: "local-owner-key",
      });
    } finally {
      forgetSdkIdentityKeys(runId);
    }
  });
  test("serializes concurrent CLI owner setup for one identity", async () => {
    const root = await temporaryDirectory();
    const runId = `identity-race-${randomUUID()}`;
    const identity = "shared-owner";
    const marker = join(root, "registered-owner-key");
    const entry = await cliEntry(root, `
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const profile = args[args.indexOf("--profile") + 1];
const home = process.env.TC_HOME;
const directory = join(home, ".tinycloud", "profiles", profile);
const command = args.includes("init") ? "init" : args.includes("login") ? "login" : "other";
if (command === "init") {
  await mkdir(directory, { recursive: true });
  const privateKey = randomBytes(32).toString("hex");
  await writeFile(join(directory, "key.json"), JSON.stringify({ d: privateKey }));
  await writeFile(join(directory, "profile.json"), JSON.stringify({ name: profile, privateKey }));
  await new Promise((resolve) => setTimeout(resolve, 80));
} else if (command === "login") {
  const profileData = JSON.parse(await readFile(join(directory, "profile.json"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  try {
    const registered = await readFile(${JSON.stringify(marker)}, "utf8");
    if (registered !== profileData.privateKey) {
      console.error("Identity owner already has a different key");
      process.exitCode = 1;
    }
  } catch {
    await writeFile(${JSON.stringify(marker)}, profileData.privateKey, { flag: "wx" });
  }
}
`);
    const makeSpec = (id: string) => ({
      id, kind: "cli", node: "node-a", endpoint: "http://127.0.0.1:9", identity,
      auth: { posture: "owner" }, replication: false,
    });
    const clients = [makeSpec("owner-a"), makeSpec("owner-b")];
    const construction = (spec: (typeof clients)[number]) => ({
      topology: { id: "identity-race-topology", spec: { name: "identity-race", nodes: [], clients } },
      environment: { runId, resultsDir: join(root, "results") },
      spec, image: {}, sut: { cli: { entry } },
    } as never);
    const [first, second] = await Promise.all(clients.map((spec) => createCliClient(construction(spec))));
    try {
      const keyPaths = [first, second].map((client) => join(client.home(), ".tinycloud", "profiles", "owner", "key.json"));
      expect(await readFile(keyPaths[0]!, "utf8")).toBe(await readFile(keyPaths[1]!, "utf8"));
      expect(await readFile(marker, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await Promise.all([first.close({ deadlineMs: 100 }), second.close({ deadlineMs: 100 })]);
      forgetSdkIdentityKeys(runId);
    }
  }, 15_000);

  test("runs the isolated owner request/grant/import workflow without copying owner key material", async () => {
    const root = await temporaryDirectory();
    const ownerHome = join(root, "owner-home");
    const deviceHome = join(root, "device-home");
    const runId = `cli-review-${crypto.randomUUID()}`;
    const identity = "review-synthetic-owner";
    const entry = await cliEntry(root, `
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const profile = args[args.indexOf("--profile") + 1];
const commandStart = args.indexOf("--host") + 2;
const command = args.slice(commandStart);
const home = process.env.TC_HOME;
await appendFile(join(home, "calls.jsonl"), JSON.stringify({ profile, host: args[args.indexOf("--host") + 1], command }) + "\\n");
if (command[0] === "profile" && command[1] === "create") {
  const profileDir = join(home, ".tinycloud", "profiles", profile);
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "profile.json"), JSON.stringify({ name: profile, did: "did:device", sessionDid: "did:device", posture: "delegate-session" }));
  await writeFile(join(profileDir, "key.json"), JSON.stringify({ d: randomBytes(32).toString("hex") }));
} else if (command[0] === "init") {
  const profileDir = join(home, ".tinycloud", "profiles", profile);
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "profile.json"), JSON.stringify({ privateKey: randomBytes(32).toString("hex") }));
  const profilePath = join(home, ".tinycloud", "profiles", profile, "profile.json");
  const profileData = JSON.parse(await readFile(profilePath, "utf8"));
  if (!profileData.privateKey) {
    profileData.privateKey = randomBytes(32).toString("hex");
    await writeFile(profilePath, JSON.stringify(profileData));
  }
  await writeFile(join(home, ".tinycloud", "profiles", profile, "session.json"), JSON.stringify({}));
} else if (command[0] === "auth" && command[1] === "request") {
  const requestPath = command[command.indexOf("--emit") + 1];
  await writeFile(requestPath, JSON.stringify({ kind: "tinycloud.auth.request", requested: [] }));
} else if (command[0] === "auth" && command[1] === "grant") {
  const requestPath = command.find((argument) => argument.endsWith(".json"));
  if (!requestPath) throw new Error("missing request path");
  await readFile(requestPath, "utf8");
  process.stdout.write(JSON.stringify({ kind: "tinycloud.auth.delegation", synthetic: true }) + "\\n");
} else if (command[0] === "auth" && command[1] === "import") {
  const grantPath = command.find((argument) => argument.endsWith(".json"));
  if (!grantPath) throw new Error("missing grant path");
  await readFile(grantPath, "utf8");
  const expiry = new Date(Date.now() + 90000).toISOString();
  await writeFile(join(home, ".tinycloud", "profiles", profile, "session.json"), JSON.stringify({ expiresAt: expiry }));
  process.stdout.write(JSON.stringify({ expiry }) + "\\n");
}
if (command[0] === "hello") {
  process.stdout.write(JSON.stringify({ profile, host: args[args.indexOf("--host") + 1] }) + "\\n");
}
`);
    const owner = new CliClientImpl({ id: "owner", home: ownerHome, cliEntry: entry, host: "http://127.0.0.1", ownerPosture: true, runId, identity });
    const device = new CliClientImpl({ id: "device", home: deviceHome, cliEntry: entry, host: "http://127.0.0.1", ownerPosture: false, runId, identity });
    try {
      const workflow = await createCliDelegation({ owner, device, space: "default", prefix: "notes/", actions: ["get", "list", "metadata", "sync"] });
      const ownerProfile = JSON.parse(await readFile(join(ownerHome, ".tinycloud", "profiles", "owner", "profile.json"), "utf8")) as { privateKey: string };
      const deviceProfile = JSON.parse(await readFile(join(deviceHome, ".tinycloud", "profiles", "device", "profile.json"), "utf8")) as { posture: string; privateKey?: string; authMethod?: string; replication?: { prefixes: string[] } };
      const deviceKey = JSON.parse(await readFile(join(deviceHome, ".tinycloud", "profiles", "device", "key.json"), "utf8")) as { d: string };
      expect(deviceProfile.posture).toBe("delegate-session");
      expect(deviceProfile.authMethod).toBe("openkey");
      expect(deviceProfile.replication?.prefixes).toEqual(["notes/"]);
      expect(await readFile(join(deviceHome, ".tc893-delegation.json"), "utf8")).toBe(await readFile(workflow.grantPath, "utf8"));
      expect((await device.authority()).grantExpiresAt).toBeGreaterThan(Date.now());
      expect(deviceProfile.privateKey).toBeUndefined();
      expect(deviceKey.d).not.toBe(ownerProfile.privateKey);
      expect(isAbsolute(workflow.requestPath)).toBe(true);
      expect(isAbsolute(workflow.grantPath)).toBe(true);
      expect(workflow.requestPath.startsWith(deviceHome)).toBe(true);
      expect(workflow.grantPath.startsWith(ownerHome)).toBe(true);
      expect((await stat(workflow.grantPath)).mode & 0o777).toBe(0o600);
      const deviceOnB = device.withHost("http://node-b.example");
      const delegateOnB = await deviceOnB.tc(["hello"]);
      expect(JSON.parse(Buffer.from(delegateOnB.stdout).toString("utf8"))).toMatchObject({ host: "http://node-b.example" });
      expect((await deviceOnB.authority()).grantExpiresAt).toBeGreaterThan(Date.now());
      const reusedDeviceHome = join(root, "device-reuse-home");
      const reusedDevice = new CliClientImpl({ id: "device-reuse", home: reusedDeviceHome, cliEntry: entry, host: "http://127.0.0.1", ownerPosture: false, runId, identity });
      const reusedWorkflow = await createCliDelegation({ owner, device: reusedDevice, ownerReady: true, space: "default", prefix: "notes/", actions: ["get", "list", "metadata", "sync"] });
      expect(reusedWorkflow.requestPath.startsWith(reusedDeviceHome)).toBe(true);
      expect(await containsFileText(reusedDeviceHome, ownerProfile.privateKey)).toBe(false);

      const ownerCalls = (await readFile(join(ownerHome, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { command: string[] });
      const deviceCalls = (await readFile(join(deviceHome, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { command: string[]; host: string; profile: string });
      const reusedDeviceCalls = (await readFile(join(reusedDeviceHome, "calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { command: string[] });
      expect(ownerCalls.map((call) => call.command.slice(0, 2))).toEqual([["init", "--name"], ["auth", "login"], ["auth", "grant"], ["auth", "grant"]]);
      expect(reusedDeviceCalls.map((call) => call.command.slice(0, 2))).toEqual([["profile", "create"], ["auth", "request"], ["auth", "import"]]);
      expect(deviceCalls.filter((call) => call.host === "http://127.0.0.1").map((call) => call.command.slice(0, 2))).toEqual([["profile", "create"], ["auth", "request"], ["auth", "import"]]);
      expect(deviceCalls.some((call) => call.host === "http://node-b.example" && call.command.slice(0, 2).join(" ") === "auth import" && call.profile !== "device")).toBe(true);
      expect(ownerCalls[2]!.command.slice(2, 4)).toEqual(["--yes", workflow.requestPath]);
      expect(ownerCalls[3]!.command.slice(2, 4)).toEqual(["--yes", reusedWorkflow.requestPath]);
      expect(deviceCalls[1]!.command[deviceCalls[1]!.command.indexOf("--emit") + 1]).toBe(workflow.requestPath);
      expect(deviceCalls[2]!.command[2]).toBe(workflow.grantPath);
    } finally { forgetSdkIdentityKeys(runId); }
  });
});
