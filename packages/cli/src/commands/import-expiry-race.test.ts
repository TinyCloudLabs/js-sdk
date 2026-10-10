import { afterAll, afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, TinyCloudNode } from "@tinycloud/node-sdk";
const { mintCompactDelegation } = await import(new URL("../../../node-sdk/src/test-support/compact-delegation.ts", import.meta.url).href) as {
  mintCompactDelegation(options: { audience: string; expSecs: number; host?: string }): Promise<{
    delegation: { cid: string };
    ownerDid: string;
    spaceId: string;
  }>;
};


let home: string | undefined;
let restoreSpy: ReturnType<typeof spyOn> | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let exitSpy: ReturnType<typeof spyOn> | undefined;
let stderrSpy: ReturnType<typeof spyOn> | undefined;
let stdoutSpy: ReturnType<typeof spyOn> | undefined;

afterEach(async () => {
  setSystemTime();
  restoreSpy?.mockRestore();
  fetchSpy?.mockRestore();
  exitSpy?.mockRestore();
  stderrSpy?.mockRestore();
  stdoutSpy?.mockRestore();
  restoreSpy = undefined;
  fetchSpy = undefined;
  exitSpy = undefined;
  stderrSpy = undefined;
  stdoutSpy = undefined;
  delete process.env.TC_HOME;
  delete process.env.TC_HOST;
});

afterAll(async () => {
  if (home !== undefined) await rm(home, { recursive: true, force: true });
});


// TC-674 regression: fails before the fix
// Expiry at the activation boundary must roll back the provisional imported session.
test("unbound import rolls back when signed expiry passes after restore", async () => {
  home ??= await mkdtemp(join(tmpdir(), "tc-import-expiry-race-"));
  process.env.HOME = home;
  process.env.TC_HOME = home;
  delete process.env.TC_HOST;
  const { profileConfigPath, profilePath, sessionPath, withTinyCloudStateRoot, writeJsonAtomic } = await import("@tinycloud/operations/state");
  const { registerAuthCommand } = await import("./auth.js");
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;
  const wasm = new NodeWasmBindings();
  const sessionManager = wasm.createSessionManager();
  const sessionDid = sessionManager.getDID("default");
  const imported = await mintCompactDelegation({ audience: sessionDid.split("#", 1)[0]!, expSecs: exp, host: "https://node.invalid" });
  const profile = {
    name: "default", host: "https://node.invalid", chainId: 1, spaceName: "secrets",
    did: sessionDid, sessionDid, ownerDid: imported.ownerDid, spaceId: imported.spaceId,
    posture: "delegate-session", operatorType: "agent", authMethod: "openkey", createdAt: new Date().toISOString(),
  };
  await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath("default"), profile);
    await writeJsonAtomic(join(profilePath("default"), "key.json"), JSON.parse(sessionManager.jwk("default")!));
  });
  const artifactPath = join(home, "delegation.json");
  await writeFile(artifactPath, JSON.stringify(imported.delegation));

  const originalRestore = TinyCloudNode.prototype.restoreSession;
  let restoreCalls = 0;
  restoreSpy = spyOn(TinyCloudNode.prototype, "restoreSession").mockImplementation(async function (
    this: TinyCloudNode,
    ...args: Parameters<TinyCloudNode["restoreSession"]>
  ) {
    const result = await originalRestore.apply(this, args);
    restoreCalls += 1;
    if (restoreCalls === 1) setSystemTime(new Date(exp * 1000));
    return result;
  });
  setSystemTime(new Date(exp * 1000 - 60_000));
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (): Promise<Response> => {
    throw new Error("unexpected network request");
  }, { preconnect: globalThis.fetch.preconnect }));
  let stderr = "";
  let stdout = "";
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write);
  stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write);
  exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => { throw code; }) as never);

  const program = new Command().option("-p, --profile <name>").option("--json");
  registerAuthCommand(program);
  let exitCode = 0;
  try {
    await program.parseAsync(["node", "tc", "auth", "import", artifactPath, "--profile", "default", "--json"]);
  } catch (error) {
    exitCode = Number(error);
  }
  expect(exitCode).toBe(1);
  expect(stderr).toContain("DELEGATION_EXPIRED");
  expect(stdout).toBe("");
  expect(restoreCalls).toBe(1);
  expect(fetchSpy).not.toHaveBeenCalled();
  await withTinyCloudStateRoot(home, async () => {
    await expect(readFile(sessionPath("default"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(profileConfigPath("default"), "utf8"))).toEqual(profile);
  });
});
// TC-674 regression: fails before the fix
// The request-bound runtime is the second restore; expiry there also rolls back.
test("request-bound import reports signed expiry after runtime restore", async () => {
  home ??= await mkdtemp(join(tmpdir(), "tc-import-expiry-bound-race-"));
  process.env.HOME = home;
  process.env.TC_HOME = home;
  delete process.env.TC_HOST;
  const { authRequestsPath, profileConfigPath, profilePath, sessionPath, withTinyCloudStateRoot, writeJsonAtomic } = await import("@tinycloud/operations/state");
  const { buildPermissionRequestArtifact } = await import("@tinycloud/operations/artifacts");
  const { registerAuthCommand } = await import("./auth.js");
  const wasm = new NodeWasmBindings();
  const sessionManager = wasm.createSessionManager();
  const sessionDid = sessionManager.getDID("default");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const imported = await mintCompactDelegation({
    audience: sessionDid.split("#", 1)[0]!,
    expSecs: exp,
    host: "https://node.invalid",
  });
  const profile = {
    name: "default", host: "https://node.invalid", chainId: 1, spaceName: "secrets",
    did: sessionDid, sessionDid, ownerDid: imported.ownerDid, spaceId: imported.spaceId,
    posture: "delegate-session", operatorType: "agent", authMethod: "openkey", createdAt: new Date().toISOString(),
  };
  const requestId = "req_tc674_race";
  const request = buildPermissionRequestArtifact({
    profile: "default",
    posture: "delegate-session",
    operatorType: "agent",
    host: "https://node.invalid",
    sessionDid: sessionDid.split("#", 1)[0]!,
    ownerDid: imported.ownerDid,
    spaceId: imported.spaceId,
    missing: [{
      service: "tinycloud.kv",
      space: imported.spaceId,
      path: "vault/secrets/KEY",
      actions: ["tinycloud.kv/get"],
    }],
    createRequestId: () => requestId,
  });
  await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath("default"), profile);
    await writeJsonAtomic(join(profilePath("default"), "key.json"), JSON.parse(sessionManager.jwk("default")!));
    await writeJsonAtomic(authRequestsPath("default"), [request]);
  });
  const artifactPath = join(home, "delegation.json");
  await writeFile(artifactPath, JSON.stringify({
    kind: "tinycloud.auth.delegation",
    version: 1,
    requestId,
    delegationCid: imported.delegation.cid,
    delegation: { ...imported.delegation, expiry: new Date((exp + 3600) * 1000).toISOString() },
  }));

  const originalRestore = TinyCloudNode.prototype.restoreSession;
  let restoreCalls = 0;
  restoreSpy = spyOn(TinyCloudNode.prototype, "restoreSession").mockImplementation(async function (
    this: TinyCloudNode,
    ...args: Parameters<TinyCloudNode["restoreSession"]>
  ) {
    const result = await originalRestore.apply(this, args);
    restoreCalls += 1;
    if (restoreCalls === 2) setSystemTime(new Date(exp * 1000));
    return result;
  });
  setSystemTime(new Date(exp * 1000 - 60_000));
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (): Promise<Response> => {
    throw new Error("unexpected network request");
  }, { preconnect: globalThis.fetch.preconnect }));
  let stderr = "";
  let stdout = "";
  stderrSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write);
  stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write);
  exitSpy = spyOn(process, "exit").mockImplementation(((code?: string | number | null) => { throw code; }) as never);

  const program = new Command().option("-p, --profile <name>").option("--json");
  registerAuthCommand(program);
  let exitCode = 0;
  try {
    await program.parseAsync(["node", "tc", "auth", "import", artifactPath, "--profile", "default", "--json"]);
  } catch (error) {
    exitCode = Number(error);
  }
  expect(exitCode).toBe(1);
  expect(stderr).toContain("DELEGATION_EXPIRED");
  expect(restoreCalls).toBe(2);
  expect(fetchSpy).not.toHaveBeenCalled();
  await withTinyCloudStateRoot(home, async () => {
    await expect(readFile(sessionPath("default"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(profileConfigPath("default"), "utf8"))).toEqual(profile);
  });
});
