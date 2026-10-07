#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ENABLED = process.env.TC_LIVE_REVOKE === "1";
const HOST = process.env.TC_LIVE_REVOKE_HOST;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  args: string[];
};
function redact(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(authorization|token|secret|password|private[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${redact(text)}\n${String(error)}`);
  }
}

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value
    ? value[key]
    : undefined;
}

function requireStringProperty(value: unknown, key: string, label: string): string {
  const result = property(value, key);
  if (typeof result !== "string") throw new Error(`${label} did not contain string field "${key}".`);
  return result;
}

function requireSuccess(result: CommandResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.exitCode}.\n` +
      `STDOUT:\n${redact(result.stdout)}\nSTDERR:\n${redact(result.stderr)}`,
    );
  }
}

async function run(
  cliEntry: string,
  home: string,
  host: string,
  commandArgs: string[],
): Promise<CommandResult> {
  const args = ["--quiet", "--json", "--profile", "default", "--host", host, ...commandArgs];
  return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["run", cliEntry, ...args], {
      cwd: dirname(cliEntry),
      env: { ...process.env, HOME: home, USERPROFILE: home, TC_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`tc ${commandArgs.join(" ")} exited via ${signal}`));
        return;
      }
      resolvePromise({ exitCode: code ?? 0, stdout, stderr, args: ["tc", ...args] });
    });
  });
}

if (!ENABLED) {
  process.stderr.write("[skip] Set TC_LIVE_REVOKE=1 and TC_LIVE_REVOKE_HOST to run the real-node revocation test.\n");
  process.exit(0);
}
if (!HOST) {
  throw new Error("TC_LIVE_REVOKE_HOST is required when TC_LIVE_REVOKE=1.");
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, "..");
const cliEntry = resolve(cliRoot, "src/index.ts");
const root = await mkdtemp(join(tmpdir(), "tc-live-delegation-revoke-"));
const ownerHome = join(root, "owner");
const deviceHome = join(root, "device");
const requestFile = join(root, "request.json");
const grantFile = join(root, "grant.json");
const suffix = randomBytes(6).toString("hex");
const key = `tc-live-revoke-${suffix}/proof.txt`;
const payload = `revocation-proof-${suffix}`;

try {
  const versionResponse = await fetch(`${HOST.replace(/\/$/, "")}/version`);
  if (!versionResponse.ok) throw new Error(`Node version check failed: HTTP ${versionResponse.status}`);
  const nodeVersion = requireStringProperty(
    parseJson(await versionResponse.text(), "Node version endpoint"),
    "version",
    "Node version endpoint",
  );

  const ownerInit = await run(cliEntry, ownerHome, HOST, ["init", "--key-only"]);
  requireSuccess(ownerInit, "Owner init");
  const ownerLogin = await run(cliEntry, ownerHome, HOST, ["auth", "login", "--method", "local"]);
  requireSuccess(ownerLogin, "Owner login");
  const ownerSpace = requireStringProperty(parseJson(ownerLogin.stdout, "Owner login"), "spaceId", "Owner login");

  const deviceInit = await run(cliEntry, deviceHome, HOST, ["init", "--key-only"]);
  requireSuccess(deviceInit, "Device init");
  const deviceLogin = await run(cliEntry, deviceHome, HOST, ["auth", "login", "--method", "local"]);
  requireSuccess(deviceLogin, "Device login");

  const ownerPut = await run(cliEntry, ownerHome, HOST, ["kv", "put", key, payload, "--space", ownerSpace]);
  requireSuccess(ownerPut, "Owner KV write");
  const request = await run(cliEntry, deviceHome, HOST, [
    "auth", "request", "--cap", `tinycloud.kv:${ownerSpace}:${key.slice(0, key.lastIndexOf("/"))}/:get,metadata`, "--emit", requestFile,
  ]);
  requireSuccess(request, "Device permission request");
  const grant = await run(cliEntry, ownerHome, HOST, ["auth", "grant", requestFile, "--yes"]);
  requireSuccess(grant, "Owner auth grant");
  const cid = requireStringProperty(parseJson(grant.stdout, "Owner auth grant"), "delegationCid", "Owner auth grant");
  await writeFile(grantFile, grant.stdout, "utf8");

  const imported = await run(cliEntry, deviceHome, HOST, ["auth", "import", grantFile]);
  requireSuccess(imported, "Device auth import");

  const scopedReadArgs = ["kv", "get", key, "--space", ownerSpace];
  const beforeRead = await run(cliEntry, deviceHome, HOST, scopedReadArgs);
  requireSuccess(beforeRead, "Pre-revoke scoped read");
  const beforeData = requireStringProperty(
    parseJson(beforeRead.stdout, "Pre-revoke scoped read"),
    "data",
    "Pre-revoke scoped read",
  );
  if (beforeData !== payload) throw new Error("Pre-revoke scoped read returned the wrong data.");

  const revoke = await run(cliEntry, ownerHome, HOST, ["delegation", "revoke", cid, "--yes"]);
  requireSuccess(revoke, "Owner delegation revoke");
  const revokeValue = parseJson(revoke.stdout, "Owner delegation revoke");
  const revokedCid = requireStringProperty(revokeValue, "cid", "Owner delegation revoke");
  const revoked = property(revokeValue, "revoked") === true;
  const targetSpaceSource = requireStringProperty(revokeValue, "targetSpaceSource", "Owner delegation revoke");
  const authorityScopeSource = requireStringProperty(revokeValue, "authorityScopeSource", "Owner delegation revoke");
  const authorityScopeReason = requireStringProperty(revokeValue, "authorityScopeReason", "Owner delegation revoke");
  const validScope = authorityScopeSource === "cid-resource"
    ? targetSpaceSource === "node"
    : authorityScopeSource === "local-signed-grant-artifact" &&
      targetSpaceSource === "local-signed-grant-artifact";
  if (revokedCid !== cid || !revoked || !validScope || authorityScopeReason.length === 0) {
    throw new Error(`Revoke returned an unexpected result: ${redact(revoke.stdout)}`);
  }
  const ownerCaps = await run(cliEntry, ownerHome, HOST, ["auth", "caps"]);
  requireSuccess(ownerCaps, "Owner capability inspection");
  const capEntries = property(parseJson(ownerCaps.stdout, "Owner capability inspection"), "capabilities");
  if (!Array.isArray(capEntries) || capEntries.some((entry) =>
    property(entry, "space") === `urn:cid:${cid}` &&
    Array.isArray(property(entry, "actions")) &&
    (property(entry, "actions") as unknown[]).includes("tinycloud.delegation/revoke")
  )) {
    throw new Error(`Temporary revoke authority was persisted: ${redact(ownerCaps.stdout)}`);
  }


  const afterRead = await run(cliEntry, deviceHome, HOST, scopedReadArgs);
  // This expected nonzero child exercises the same redaction path as failures.
  redact(afterRead.stderr);
  const afterValue = parseJson(afterRead.stderr, "Post-revoke scoped read");
  const afterError = property(afterValue, "error");
  const afterCode = property(afterError, "code");
  const afterMessage = property(afterError, "message");
  const afterMeta = property(afterError, "meta");
  const afterStatus = property(afterMeta, "status");
  const revokedMessage = `delegation-revoked: ${cid}`;
  if (afterRead.exitCode === 0 || afterStatus !== 401 || typeof afterMessage !== "string" || !afterMessage.includes(revokedMessage)) {
    throw new Error(
      `Post-revoke scoped read did not fail with the revocation verdict.\n` +
      `Exit code: ${afterRead.exitCode}\nSTDOUT:\n${redact(afterRead.stdout)}\nSTDERR:\n${redact(afterRead.stderr)}`,
    );
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    nodeVersion,
    ownerSpace,
    key,
    cid,
    before: { command: ["tc", ...scopedReadArgs], exitCode: beforeRead.exitCode, data: beforeData },
    revoke: {
      command: revoke.args,
      exitCode: revoke.exitCode,
      cid: revokedCid,
      revoked,
      targetSpaceSource,
      authorityScopeSource,
      authorityScopeReason,
    },
    after: {
      command: ["tc", ...scopedReadArgs],
      exitCode: afterRead.exitCode,
      code: afterCode,
      message: afterMessage,
      status: afterStatus,
    },
  }) + "\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
