import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { openKeyDelegate } from "../test-support/openkey-delegate.js";

// An owner escalation approved through OpenKey must keep authorizing the
// canonical `secrets get`: in the same process (the retry right after the
// grant is stored) and in a fresh one. Nothing on the replay path is mocked:
// real profile files, the real operations runtime and node-sdk activation,
// and a loopback node that activates the CACAO grant and serves the secret.

const SECRET = "HERMETIC_DELEGATION_CANARY";
const CANARY = "tc-609-replayed-grant-canary";
const home = await mkdtemp(join(tmpdir(), "tc-grant-replay-"));
const originalHome = process.env.HOME;
const originalTcHome = process.env.TC_HOME;
process.env.HOME = home;
process.env.TC_HOME = home;
delete process.env.TC_HOST;

interface HermeticNode {
  readonly host: string;
  readonly ownerPrivateKey: string;
  readonly ownerDid: string;
  provisionSecret(): void;
  stop(): void;
}
// The node-sdk loopback fixture lives outside this package's rootDir, so it is
// loaded by URL, as the operations fixtures do.
const hermeticModule = await import(
  new URL("../../../node-sdk/src/test-support/hermetic-encrypted-node.ts", import.meta.url).href
) as { createHermeticEncryptedNode(options: { secretPayloadValue: string }): Promise<HermeticNode> };
// Profile state paths resolve at module load, after TC_HOME points at the test home.
const {
  additionalDelegationsPath,
  profileConfigPath,
  profilePath,
  readAdditionalDelegations,
  sessionPath,
  tinycloudConfigPath,
  writeJsonAtomic,
} = await import("@tinycloud/operations/state");
const { registerSecretsCommand } = await import("./secrets.js");

let hermetic: HermeticNode;
const wasm = new NodeWasmBindings();
const manager = wasm.createSessionManager();
const sessionKey = JSON.parse(manager.jwk("default")!);
const sessionDid = manager.getDID("default");

beforeAll(async () => {
  hermetic = await hermeticModule.createHermeticEncryptedNode({ secretPayloadValue: CANARY });
  hermetic.provisionSecret();
  const owner = new PrivateKeySigner(hermetic.ownerPrivateKey);
  const address = await owner.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, "secrets");
  // The owner's own session holds no secret authority, so a read escalates.
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities: { capabilities: { "": ["tinycloud.capabilities/read"] } },
    address, chainId: 1, domain: "cli.tinycloud.xyz", spaceId, jwk: sessionKey,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expirationTime: expiresAt,
  });
  const signature = await owner.signMessage(prepared.siwe);
  await writeJsonAtomic(tinycloudConfigPath(), { defaultProfile: "owner", version: 1 });
  await writeJsonAtomic(profileConfigPath("owner"), {
    name: "owner", host: hermetic.host, chainId: 1, spaceName: "secrets", spaceId,
    did: hermetic.ownerDid, sessionDid, ownerDid: hermetic.ownerDid,
    authMethod: "openkey", posture: "owner-openkey", operatorType: "human",
    createdAt: "2026-10-04T00:00:00.000Z",
  });
  await writeJsonAtomic(join(profilePath("owner"), "key.json"), sessionKey);
  await writeJsonAtomic(sessionPath("owner"), {
    ...wasm.completeSessionSetup({ ...prepared, signature }),
    jwk: sessionKey, address, chainId: 1, spaceId, verificationMethod: sessionDid,
    siwe: prepared.siwe, signature, ownerDid: hermetic.ownerDid, expiresAt, tinycloudHosts: [hermetic.host],
  });
});

afterAll(async () => {
  hermetic?.stop();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

test("an approved escalation authorizes secrets get in the same process and in a fresh one", async () => {
  const openKey = openKeyDelegate({
    wasm,
    signer: new PrivateKeySigner(hermetic.ownerPrivateKey),
    sessionKey,
    sessionDid,
  });
  let acquisitions = 0;
  let stdout = "";
  const output = process.stdout as unknown as { write: (chunk: unknown) => boolean };
  const originalWrite = output.write;
  const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`secrets get exited with ${code}`);
  }) as typeof process.exit);
  // The owner is at a terminal, so the missing grant goes to OpenKey.
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
  output.write = (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  };
  try {
    const program = new Command();
    program.option("-p, --profile <name>").option("--json");
    registerSecretsCommand(program, async (did, options) => {
      acquisitions += 1;
      return openKey.delegate(did, options);
    });
    await program.parseAsync(["node", "tc", "--profile", "owner", "secrets", "get", SECRET], { from: "node" });
  } finally {
    output.write = originalWrite;
    exit.mockRestore();
    if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
    else Reflect.deleteProperty(process.stderr, "isTTY");
  }

  // One approval, then the immediate canonical retry read the value.
  expect(acquisitions).toBe(1);
  expect(JSON.parse(stdout)).toEqual({ name: SECRET, value: CANARY });
  const stored = await readAdditionalDelegations<{
    delegation: { cid: string; siweProof?: unknown };
    authorityRequest?: { requestId?: unknown };
    authorityRequestAudit?: unknown;
  }>("owner");
  expect(stored).toHaveLength(1);
  // The signed proof replay verifies the grant from, and the request binding
  // replay holds a signed-login record to.
  expect(stored[0]!.delegation.siweProof).toEqual({ siwe: expect.any(String), signature: expect.any(String) });
  expect(stored[0]!.authorityRequest?.requestId).toBe(`cli-grant:${stored[0]!.delegation.cid}`);

  // A new process has only the stored grant; it must replay it, not ask again.
  const freshRead = async () => {
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
    delete env.TC_HOST;
    delete env.TC_PRIVATE_KEY;
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "../../test-support/secrets-json-error.ts"),
      "--profile", "owner", "--json", "secrets", "get", SECRET,
    ], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [childStdout, childStderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout: childStdout, stderr: childStderr };
  };
  const fresh = await freshRead();
  expect({ exitCode: fresh.exitCode, stderr: fresh.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(fresh.stdout)).toEqual({ name: SECRET, value: CANARY });

  // A copy left by an earlier release, with neither its proof nor a binding,
  // is skipped; the read still succeeds and stderr stays machine-readable.
  const { siweProof: _proof, ...proofless } = stored[0]!.delegation;
  const { authorityRequest: _binding, authorityRequestAudit: _audit, ...unbound } = stored[0]!;
  await writeJsonAtomic(additionalDelegationsPath("owner"), [stored[0], { ...unbound, delegation: proofless }]);
  const upgraded = await freshRead();
  expect(upgraded.exitCode).toBe(0);
  expect(JSON.parse(upgraded.stdout)).toEqual({ name: SECRET, value: CANARY });
  expect(JSON.parse(upgraded.stderr)).toEqual({
    warnings: [{ code: "STORED_GRANT_SKIPPED", reason: "proof_missing", grantCid: stored[0]!.delegation.cid }],
  });
  staleGrantCid = stored[0]!.delegation.cid;
});

// Set by the test above, which leaves a stale copy of the grant beside the real one.
let staleGrantCid: string | undefined;
const staleWarning = () => ({ code: "STORED_GRANT_SKIPPED", reason: "proof_missing", grantCid: staleGrantCid });

const cliRuntimes: Array<[string, string[]]> = [
  ["bun", [process.execPath, join(import.meta.dir, "../index.ts")]],
  ["node", [process.env.NODE_BINARY ?? "node", join(import.meta.dir, "../../bin/tc")]],
];

function cliEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  return env;
}

// Root ignores directory permissions, so the write cannot be made to fail.
test.skipIf(process.getuid?.() === 0).each(cliRuntimes)(
  "under %s, a failed -o write reports the skipped grant inside its one JSON error",
  async (_runtime, command) => {
    expect(staleGrantCid).toBeDefined();
    const readOnly = await mkdtemp(join(tmpdir(), "tc-grant-replay-readonly-"));
    await chmod(readOnly, 0o500);
    try {
      const child = Bun.spawn([
        ...command, "--quiet", "--json", "--profile", "owner", "secrets", "get", SECRET, "-o", join(readOnly, "secret.txt"),
      ], { env: cliEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exitCode, stdout }).toEqual({ exitCode: 1, stdout: "" });
      expect(JSON.parse(stderr)).toEqual({
        error: {
          code: "ERROR",
          message: expect.stringContaining("Could not write secret output"),
          warnings: [staleWarning()],
        },
      });
      expect(stderr).not.toContain(CANARY);
    } finally {
      await chmod(readOnly, 0o700);
      await rm(readOnly, { recursive: true, force: true });
    }
  },
);

/** Run the CLI with stdout on a pseudo-terminal and stderr on a pipe. */
async function ptyRun(command: string[], args: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  const runner = Bun.spawn([
    "python3", join(import.meta.dir, "../../test-support/pty-run.py"), ...command, ...args,
  ], { env: cliEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [report, runnerStderr, runnerExit] = await Promise.all([
    new Response(runner.stdout).text(),
    new Response(runner.stderr).text(),
    runner.exited,
  ]);
  expect({ runnerExit, runnerStderr }).toEqual({ runnerExit: 0, runnerStderr: "" });
  return JSON.parse(report) as { exit: number; stdout: string; stderr: string };
}

test.each(cliRuntimes)("under %s, --json with stdout on a terminal keeps stderr machine-readable", async (_runtime, command) => {
  expect(staleGrantCid).toBeDefined();
  for (const quiet of [["--quiet"], []]) {
    // No banner, notice or spinner: stderr is only the warnings line.
    const read = await ptyRun(command, [...quiet, "--json", "--profile", "owner", "secrets", "get", SECRET]);
    expect(read.exit).toBe(0);
    expect(JSON.parse(read.stdout)).toEqual({ name: SECRET, value: CANARY });
    expect(JSON.parse(read.stderr)).toEqual({ warnings: [staleWarning()] });
  }

  const shown = await ptyRun(command, ["--json", "--profile", "owner", "profile", "show", "owner"]);
  expect({ exit: shown.exit, stderr: shown.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.parse(shown.stdout)).toMatchObject({ name: "owner" });

  // A profile that does not exist would also get the "No profile configured" notice.
  const missing = await ptyRun(command, ["--json", "--profile", "nobody", "profile", "show", "nobody"]);
  expect(missing.exit).not.toBe(0);
  expect(JSON.parse(missing.stderr)).toMatchObject({ error: { code: expect.any(String) } });

  // `--json` after `--` is an operand, not the option: errors stay human-readable.
  const operand = await ptyRun(command, ["--quiet", "profile", "show", "--", "--json"]);
  expect(operand.exit).not.toBe(0);
  expect(() => JSON.parse(operand.stderr)).toThrow();
  expect(operand.stderr).toContain("✗");
  // Five CLI processes in a row; Node startup alone can approach the 5s default.
}, 30_000);

test("a plain error from browser approval still carries the skipped grant", async () => {
  expect(staleGrantCid).toBeDefined();
  let stderr = "";
  const errorOutput = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  const originalWrite = errorOutput.write;
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`secrets get exited with ${code}`);
  }) as typeof process.exit);
  // A person at a terminal with stdout redirected: approval runs, output is JSON.
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
  errorOutput.write = (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  };
  try {
    const program = new Command();
    program.option("-p, --profile <name>").option("--json");
    registerSecretsCommand(program, async () => {
      throw new Error("the browser approval window closed");
    });
    // No grant covers this secret, so the read escalates and approval fails.
    await expect(program.parseAsync(["node", "tc", "--profile", "owner", "secrets", "get", "UNGRANTED_SECRET"], { from: "node" }))
      .rejects.toThrow("secrets get exited with 1");
  } finally {
    errorOutput.write = originalWrite;
    exit.mockRestore();
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    if (stderrTTY) Object.defineProperty(process.stderr, "isTTY", stderrTTY);
    else Reflect.deleteProperty(process.stderr, "isTTY");
  }
  expect(JSON.parse(stderr)).toEqual({
    error: { code: "ERROR", message: "the browser approval window closed", warnings: [staleWarning()] },
  });
});
