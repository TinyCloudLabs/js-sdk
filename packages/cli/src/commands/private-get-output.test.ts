import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

const vaultGetCalls: unknown[] = [];
const errors: unknown[] = [];

mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async () => ({ profile: "test", host: "https://node.test" }) },
}));
mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => ({
    replication: { status: async () => [{ state: "ready" }] },
    vault: {
      unlock: async () => ({ ok: true }),
      get: async (_key: string, options: unknown) => {
        vaultGetCalls.push(options);
        return { ok: true, data: { data: "vault-secret" } };
      },
    },
    kv: {
      withPrefix: () => ({
        get: async () => ({ ok: true, data: { data: JSON.stringify({ value: "var-secret" }) } }),
      }),
    },
  }),
}));
mock.module("@tinycloud/node-sdk", () => ({
  PrivateKeySigner: class PrivateKeySigner { constructor(_key: string) {} },
}));
mock.module("../output/formatter.js", () => ({
  outputJson: () => {},
  withSpinner: async (_message: string, action: () => unknown) => action(),
}));
mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error { constructor(public code: string, message: string, public exitCode: number) { super(message); } },
  cliErrorFromService: (error: unknown) => error,
  handleError: (error: unknown) => errors.push(error),
}));

const { registerVaultCommand } = await import("./vault.js");
const { registerVarsCommand } = await import("./vars.js");

async function run(register: (program: Command) => void, args: string[]): Promise<void> {
  const program = new Command();
  register(program);
  await program.parseAsync(["node", "tc", ...args], { from: "node" });
}

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  errors.length = 0;
  vaultGetCalls.length = 0;
});

describe("private command get outputs", () => {
  test("vault get -o creates a 0600 file", async () => {
    dir = await mkdtemp(join(tmpdir(), "tc-vault-output-"));
    const path = join(dir, "secret");

    await run(registerVaultCommand, ["vault", "get", "KEY", "-o", path, "--private-key", "test"]);

    expect(errors).toEqual([]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  test("vault existence reads stay network-only with replication enabled", async () => {
    await run(registerVaultCommand, ["vault", "get", "KEY", "--private-key", "test"]);

    expect(errors).toEqual([]);
    expect(vaultGetCalls).toEqual([{ source: "network" }]);
  });

  test("vars get -o creates a 0600 file", async () => {
    dir = await mkdtemp(join(tmpdir(), "tc-vars-output-"));
    const path = join(dir, "variable");

    await run(registerVarsCommand, ["vars", "get", "KEY", "-o", path, "--private-key", "test"]);

    expect(errors).toEqual([]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
