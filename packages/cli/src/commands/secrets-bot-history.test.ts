import { beforeEach, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";

// TinyChat's bot-history key and its data live under a reserved scope: `secrets list` and `secrets delete` never show
// or delete them (a delete would make the history unreadable).

// `secrets/scoped/<scope>/bot-history`: the scope, taken from the SDK's own path.
const BOT_HISTORY_SCOPE = BOT_HISTORY_KEY_PATH.split("/")[2]!;

let operations: string[] = [];
let outputs: Record<string, unknown>[] = [];
let errors: Array<{ code?: string }> = [];

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    withLock: async <T>(_name: string, action: () => Promise<T>) => action(),
    resolveContext: async () => ({ profile: "default", host: "https://tinycloud.test" }),
    getProfile: async () => ({
      name: "default", host: "https://tinycloud.test", chainId: 1, spaceName: "default",
      authMethod: "local", posture: "local-owner-key",
    }),
    getSession: async () => null,
  },
}));

const node = {
  secrets: {
    list: async (options?: { scope?: string }) => {
      operations.push(`list:${options?.scope ?? ""}`);
      return { ok: true, data: [] };
    },
    delete: async (name: string, options?: { scope?: string }) => {
      operations.push(`delete:${options?.scope ?? ""}:${name}`);
      return { ok: true, data: undefined };
    },
  },
};
const realSdk = await import("../lib/sdk.js");
mock.module("../lib/sdk.js", () => ({ ...realSdk, ensureAuthenticated: async () => node }));

const realFormatter = await import("../output/formatter.js");
mock.module("../output/formatter.js", () => ({
  ...realFormatter,
  outputJson: (payload: Record<string, unknown>) => { outputs.push(payload); },
  shouldOutputJson: () => true,
  withSpinner: async (_label: string, fn: () => unknown) => await fn(),
}));

const realErrors = await import("../output/errors.js");
mock.module("../output/errors.js", () => ({ ...realErrors, handleError: (error: { code?: string }) => { errors.push(error); } }));

const { registerSecretsCommand } = await import("./secrets.js");

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.option("-p, --profile <name>").option("--json");
  registerSecretsCommand(program);
  await program.parseAsync(["node", "tc", "secrets", ...args], { from: "node" });
}

beforeEach(() => {
  operations = [];
  outputs = [];
  errors = [];
});

// The scope as typed, in the spellings that canonicalise to it.
const SPELLINGS = [BOT_HISTORY_SCOPE, BOT_HISTORY_SCOPE.toUpperCase(), ` ${BOT_HISTORY_SCOPE.replaceAll("-", " ")} `];

for (const scope of SPELLINGS) {
  test(`secrets list --scope ${JSON.stringify(scope)} is refused and lists nothing`, async () => {
    await run("list", "--scope", scope);

    expect(errors.map((error) => error.code)).toEqual(["INVALID_SECRET_SCOPE"]);
    expect(operations).toEqual([]);
    expect(outputs).toEqual([]);
  });

  test(`secrets delete --scope ${JSON.stringify(scope)} is refused and deletes nothing`, async () => {
    await run("delete", "SESSION", "--scope", scope);

    expect(errors.map((error) => error.code)).toEqual(["INVALID_SECRET_SCOPE"]);
    expect(operations).toEqual([]);
    expect(outputs).toEqual([]);
  });
}

test("a scope that only starts like the bot-history scope is listed and deleted as any other", async () => {
  const other = BOT_HISTORY_SCOPE.slice(0, BOT_HISTORY_SCOPE.indexOf("-"));
  await run("list", "--scope", other);
  await run("delete", "SESSION", "--scope", other);

  expect(errors).toEqual([]);
  expect(operations).toEqual([`list:${other}`, `delete:${other}:SESSION`]);
});
