import { beforeEach, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";

// TinyChat's bot-history key and its data live under a reserved scope: no secrets command lists, deletes or writes
// them (a delete would make the history unreadable, and a write would replace it). Every surface refuses the scope
// before it signs in, asks or touches anything, in every spelling that canonicalises to it.

// `secrets/scoped/<scope>/bot-history`: the scope, taken from the SDK's own path.
const BOT_HISTORY_SCOPE = BOT_HISTORY_KEY_PATH.split("/")[2]!;

let operations: string[] = [];
let signIns = 0;
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
    listAll: async () => {
      operations.push("listAll");
      return { ok: true, data: [] };
    },
    put: async (name: string, _value: string, options?: { scope?: string }) => {
      operations.push(`put:${options?.scope ?? ""}:${name}`);
      return { ok: true, data: undefined };
    },
    delete: async (name: string, options?: { scope?: string }) => {
      operations.push(`delete:${options?.scope ?? ""}:${name}`);
      return { ok: true, data: undefined };
    },
  },
};
const realSdk = await import("../lib/sdk.js");
mock.module("../lib/sdk.js", () => ({
  ...realSdk,
  ensureAuthenticated: async () => {
    signIns += 1;
    return node;
  },
}));

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
  signIns = 0;
  outputs = [];
  errors = [];
});

// The scope as typed, in the spellings that canonicalise to it: lower, Title-Case, upper, and spaced.
const SPELLINGS = [
  BOT_HISTORY_SCOPE,
  BOT_HISTORY_SCOPE.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join("-"),
  BOT_HISTORY_SCOPE.toUpperCase(),
  ` ${BOT_HISTORY_SCOPE.replaceAll("-", " ")} `,
];

// One entry per surface that lists, deletes or writes secrets.
const SURFACES: Array<[string, (scope: string) => string[]]> = [
  ["secrets list", (scope) => ["list", "--scope", scope]],
  ["secrets delete", (scope) => ["delete", "SESSION", "--scope", scope]],
  ["secrets put", (scope) => ["put", "SESSION", "value", "--scope", scope]],
  ["secrets put --stdin", (scope) => ["put", "SESSION", "--stdin", "--scope", scope]],
  ["secrets migrate", (scope) => ["migrate", "--scope", scope]],
  ["secrets request", (scope) => ["request", "SESSION", "--scope", scope]],
  ["secrets manage", (scope) => ["manage", "SESSION", "--scope", scope, "--no-open"]],
];

for (const [surface, args] of SURFACES) {
  for (const scope of SPELLINGS) {
    test(`${surface} --scope ${JSON.stringify(scope)} is refused before anything is signed in, shown or changed`, async () => {
      await run(...args(scope));

      expect(errors.map((error) => error.code)).toEqual(["INVALID_SECRET_SCOPE"]);
      expect({ signIns, operations, outputs }).toEqual({ signIns: 0, operations: [], outputs: [] });
    });
  }
}

test("a scope that only starts like the bot-history scope is listed, written and deleted as any other", async () => {
  const other = BOT_HISTORY_SCOPE.slice(0, BOT_HISTORY_SCOPE.indexOf("-"));
  await run("list", "--scope", other);
  await run("put", "SESSION", "value", "--scope", other);
  await run("delete", "SESSION", "--scope", other);

  expect(errors).toEqual([]);
  expect(operations).toEqual([`list:${other}`, `put:${other}:SESSION`, `delete:${other}:SESSION`]);
});
