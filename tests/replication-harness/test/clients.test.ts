import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { HarnessError } from "../src/contracts/common";
import { resolveAnchoredPackage } from "../src/clients/sut";
import { resolveCliAuthPaths, scrubClientEnvironment, terminateWithLadder } from "../src/clients/cli-client";

const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function temporaryDirectory(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "tc893-s2-")); tempDirs.push(path); return path; }

describe("anchored package resolution", () => {
  test("resolves the package from the selected prefix package.json", async () => {
    const prefix = await temporaryDirectory();
    const packageDir = join(prefix, "node_modules", "@tinycloud", "cli");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(prefix, "package.json"), "{}\n");
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "@tinycloud/cli", version: "1.2.3" }));
    const resolved = await resolveAnchoredPackage(prefix, "@tinycloud/cli");
    expect(resolved.packageJson).toBe(join(packageDir, "package.json"));
    expect(resolved.data.version).toBe("1.2.3");
  });

  test("rejects a package symlink escaping the anchored node_modules", async () => {
    const prefix = await temporaryDirectory();
    const outside = join(await temporaryDirectory(), "cli");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "package.json"), JSON.stringify({ name: "@tinycloud/cli", version: "1.2.3" }));
    await mkdir(join(prefix, "node_modules", "@tinycloud"), { recursive: true });
    await writeFile(join(prefix, "package.json"), "{}\n");
    await symlink(outside, join(prefix, "node_modules", "@tinycloud", "cli"), "dir");
    await expect(resolveAnchoredPackage(prefix, "@tinycloud/cli")).rejects.toMatchObject({ code: "SUT_RESOLVE_FAILED" } satisfies Partial<HarnessError>);
  });
});

describe("CLI environment and shutdown", () => {
  test("removes ambient TC variables and only restores approved replication overrides", () => {
    const env = scrubClientEnvironment({ PATH: "/usr/bin", TC_HOME: "/wrong", TC_SECRET: "must-remove", TC_REPLICATION_VERIFY: "ambient", OTHER: "kept" }, "/isolated/home", { TC_REPLICATION_VERIFY: "1", TC_FAULTS: "/not-approved", CUSTOM: "override" });
    expect(env).toEqual({ PATH: "/usr/bin", OTHER: "kept", CUSTOM: "override", HOME: "/isolated/home", TC_HOME: "/isolated/home", TC_REPLICATION_VERIFY: "1" });
  });
  test("anchors auth request and grant files to the client's isolated home", () => {
    const home = "/tmp/tc893-client-home";
    expect(resolveCliAuthPaths(home, ["auth", "request", "--emit", "requests/device.json"])).toEqual(["auth", "request", "--emit", join(home, "requests/device.json")]);
    expect(resolveCliAuthPaths(home, ["auth", "grant", "--yes", "/tmp/request.json"])).toEqual(["auth", "grant", "--yes", "/tmp/request.json"]);
    expect(resolveCliAuthPaths(home, ["kv", "get", "notes/a", "--raw"])).toEqual(["kv", "get", "notes/a", "--raw"]);
  });

  test("uses SIGINT, SIGTERM, then SIGKILL when a child ignores graceful signals", async () => {
    // This validates actual OS signal delivery and escalation; fake timers cannot model signal handlers.
    const child = spawn(process.execPath, ["-e", "process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolveChild, rejectChild) => {
      child.stdout?.on("data", (chunk: Buffer) => { if (chunk.toString().includes("ready")) resolveChild(); });
      child.once("error", rejectChild);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveChild) => child.once("exit", (code, signal) => resolveChild({ code, signal })));
    await terminateWithLadder(child, undefined, 10);
    expect(await exited).toMatchObject({ signal: "SIGKILL" });
  });
});
