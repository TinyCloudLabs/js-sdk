#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const SMOKE_HOST = process.env.TC_LIVE_SMOKE_HOST ?? "https://node.tinycloud.xyz";
const ENABLED = process.env.TC_LIVE_SMOKE === "1";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  command: string;
};

type JsonResult = {
  [key: string]: unknown;
};

function isDefaultNodeHost(host: string): boolean {
  try {
    return new URL(host).hostname === "node.tinycloud.xyz";
  } catch {
    return false;
  }
}

if (!ENABLED) {
  process.stderr.write("[skip] Set TC_LIVE_SMOKE=1 to run the delegated secrets smoke test.\n");
  process.exit(0);
}

function buildCommand(args: string[]): string {
  return ["bun", ...args].join(" ");
}

async function run(
  cliEntry: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return await new Promise<RunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["run", cliEntry, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`Command ${buildCommand(["run", cliEntry, ...args])} exited via signal ${signal}.`));
        return;
      }
      resolvePromise({
        code: code ?? 0,
        stdout,
        stderr,
        command: buildCommand(["run", cliEntry, ...args]),
      });
    });
  });
}

function parseJson<T extends JsonResult>(result: RunResult, label: string): T {
  const text = result.stdout.trim();
  if (text === "") {
    throw new Error(`${label} produced no JSON output.\n${result.stderr.trim()}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `${label} did not produce valid JSON.\nCommand: ${result.command}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function expectSuccess(result: RunResult, label: string): void {
  if (result.code === 0) {
    return;
  }

  const caveat = label === "delegated secret read" && isDefaultNodeHost(SMOKE_HOST)
    ? "\nKnown caveat: node.tinycloud.xyz has not been verified to expose the encryption-networks service. If this looks like a decrypt failure, retry against https://tee.node.tinycloud.xyz."
    : "";

  throw new Error(
    `${label} failed.\nCommand: ${result.command}\nExit code: ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}${caveat}`,
  );
}

function expectSecretValue(result: RunResult, expected: string): void {
  const parsed = parseJson<{ name: string; value: string }>(result, "delegated secret read");
  if (parsed.value !== expected) {
    throw new Error(
      `Delegated secret read returned the wrong value.\nExpected: ${expected}\nReceived: ${parsed.value}\nCommand: ${result.command}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
}

async function main(): Promise<void> {
  const { TinyCloudNode } = await import("../../node-sdk/src/index.ts");
  const { generateLocalIdentity } = await import("../src/auth/local-key.ts");
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const cliRoot = resolve(scriptDir, "..");
  const cliEntry = resolve(cliRoot, "src/index.ts");
  const tempHome = await mkdtemp(join(tmpdir(), "tc-cli-live-smoke-"));
  const profile = `delegated-smoke-${Date.now().toString(36)}`;
  const secretName = `SMOKE_${Date.now().toString(36).toUpperCase()}_${randomBytes(3).toString("hex").toUpperCase()}`;
  const secretValue = `secret-${randomBytes(12).toString("hex")}`;
  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    TC_HOME: tempHome,
  };

  try {
    const ownerIdentity = await generateLocalIdentity();
    const ownerNode = new TinyCloudNode({
      privateKey: ownerIdentity.privateKey,
      host: SMOKE_HOST,
      autoCreateSpace: true,
    });
    await ownerNode.signIn();

    const agentInit = await run(cliEntry, [
      "--quiet",
      "--json",
      "--profile",
      profile,
      "--host",
      SMOKE_HOST,
      "init",
      "--name",
      profile,
      "--key-only",
    ], {
      cwd: cliRoot,
      env,
    });
    expectSuccess(agentInit, "agent init");
    parseJson<{ did: string }>(agentInit, "agent init");

    const login = await run(cliEntry, [
      "--quiet",
      "--json",
      "--profile",
      profile,
      "--host",
      SMOKE_HOST,
      "auth",
      "login",
      "--method",
      "local",
    ], {
      cwd: cliRoot,
      env,
    });
    expectSuccess(login, "agent login");
    const loginJson = parseJson<{ sessionDid: string; did: string }>(login, "agent login");
    if (typeof loginJson.did !== "string" || loginJson.did.length === 0) {
      throw new Error(`Agent login did not return a DID.\nSTDOUT:\n${login.stdout}\nSTDERR:\n${login.stderr}`);
    }
    // The delegation audience must be the agent's STABLE identity DID (did:pkh),
    // not its ephemeral session-key DID. When the agent later runs
    // `tc secrets get --delegation`, it authenticates in wallet mode and
    // `useDelegation` mints the activation sub-delegation with the agent's
    // did:pkh as the delegator. The node validates that the parent
    // delegation's delegatee equals that delegator, so delegating to the
    // session DID (did:key) makes activation fail with
    // "Cannot find parent delegation".
    const agentAudienceDid = loginJson.did;

    const networkDescriptor = await ownerNode.ensureEncryptionNetwork("default");
    const putResult = await ownerNode.secrets.put(secretName, secretValue);
    if (!putResult.ok) {
      throw new Error(`Owner secret write failed: ${putResult.error.code} ${putResult.error.message}`);
    }

    const delegationResult = await ownerNode.delegateTo(agentAudienceDid, [
      {
        service: "tinycloud.kv",
        space: "secrets",
        path: `vault/secrets/${secretName}`,
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "tinycloud.encryption",
        path: networkDescriptor.networkId,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ]);

    const delegationFile = join(tempHome, "delegation.json");
    await writeFile(
      delegationFile,
      `${JSON.stringify(delegationResult.delegation, null, 2)}\n`,
      "utf8",
    );

    const imported = await run(cliEntry, [
      "--quiet",
      "--json",
      "--profile",
      profile,
      "--host",
      SMOKE_HOST,
      "auth",
      "import",
      delegationFile,
    ], {
      cwd: cliRoot,
      env,
    });
    expectSuccess(imported, "delegation import");

    const delegatedRead = await run(cliEntry, [
      "--quiet",
      "--json",
      "--profile",
      profile,
      "--host",
      SMOKE_HOST,
      "secrets",
      "get",
      secretName,
      "--delegation",
      profile,
    ], {
      cwd: cliRoot,
      env,
    });
    expectSuccess(delegatedRead, "delegated secret read");
    expectSecretValue(delegatedRead, secretValue);

    process.stdout.write(
      JSON.stringify({
        ok: true,
        host: SMOKE_HOST,
        profile,
        secretName,
      }) + "\n",
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

await main();
