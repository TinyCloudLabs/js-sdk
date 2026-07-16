import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { TinyCloudNode } from "@tinycloud/node-sdk";

const PRIVATE_KEY = "1".repeat(64);
let home: string | undefined;

afterEach(async () => {
  delete process.env.TC_PRIVATE_KEY;
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true });
    home = undefined;
  }
});

test("production secrets get accepts flag and environment private-key overrides without an OpenKey session", async () => {
  for (const flag of [true, false]) {
    const result = await runWithPrivateKey({ flag });
    expect(result.signInCalls).toBe(1);
    expect(result.output).not.toContain(PRIVATE_KEY);
    expect(result.output).not.toContain("SESSION_NOT_FOUND");
    expect(result.output).toContain("NODE_ERROR");
  }
});

async function runWithPrivateKey(options: Readonly<{ flag: boolean }>): Promise<{
  signInCalls: number;
  output: string;
}> {
  const firstRun = home === undefined;
  if (firstRun) home = await mkdtemp(`${tmpdir()}/tinycloud-cli-private-key-`);
  process.env.TC_HOME = home;
  if (!options.flag) process.env.TC_PRIVATE_KEY = PRIVATE_KEY;

  const { profileConfigPath, writeJsonAtomic } = await import("@tinycloud/operations/state");
  if (firstRun) {
    await writeJsonAtomic(profileConfigPath("openkey"), {
      name: "openkey",
      host: "https://node.invalid",
      chainId: 1,
      spaceName: "secrets",
      spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets",
      did: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
      posture: "owner-openkey",
      operatorType: "human",
      authMethod: "openkey",
      createdAt: "2026-07-15T00:00:00.000Z",
    });
  }

  let signInCalls = 0;
  const signIn = spyOn(TinyCloudNode.prototype, "signIn").mockImplementation(async () => {
    signInCalls += 1;
    throw new Error(`private-key canary ${PRIVATE_KEY}`);
  });
  const writes: string[] = [];
  const stdout = process.stdout as unknown as { write(chunk: unknown): boolean };
  const stderr = process.stderr as unknown as { write(chunk: unknown): boolean };
  const originalStdout = stdout.write;
  const originalStderr = stderr.write;
  const originalExit = process.exit;
  stdout.write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  stderr.write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  process.exit = ((code?: number): never => {
    throw new Error(`process exit ${code ?? 0}`);
  }) as typeof process.exit;

  try {
    const { registerSecretsCommand } = await import("./secrets.js");
    const program = new Command();
    program.option("-p, --profile <name>");
    program.option("-H, --host <url>");
    program.option("--json");
    registerSecretsCommand(program);
    const args = [
      "node",
      "tc",
      "--profile",
      "openkey",
      "--json",
      "secrets",
      "get",
      "HERMETIC_PRIVATE_KEY_CANARY",
      ...(options.flag ? ["--private-key", PRIVATE_KEY] : []),
    ];
    await program.parseAsync(args, { from: "node" }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.startsWith("process exit")) throw error;
    });
  } finally {
    stdout.write = originalStdout;
    stderr.write = originalStderr;
    process.exit = originalExit;
    signIn.mockRestore();
  }

  return { signInCalls, output: writes.join("") };
}
