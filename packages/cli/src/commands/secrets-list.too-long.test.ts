import { beforeEach, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { MAX_SECRET_NAME_LENGTH, MAX_SECRET_SCOPE_LENGTH } from "@tinycloud/sdk-core";

// TC-3284 (Naomi 14:33Z): a secret whose name or scope is over 64 characters (stored before the cap) is still listed,
// never hidden, with Monica's note that this version can't read or delete it and which CLI can.

const LONG_NAME = `A${"B".repeat(MAX_SECRET_NAME_LENGTH)}`;
const EXACT_NAME = `A${"B".repeat(MAX_SECRET_NAME_LENGTH - 1)}`;
const LONG_SCOPE = "a".repeat(MAX_SECRET_SCOPE_LENGTH + 1);
const NAME_ONLY = "Name is longer than 64 characters, so this version can't read or delete it. Rename it with CLI version 1.8.0 or earlier.";
const SCOPE_ONLY = "Scope is longer than 64 characters, so this version can't read or delete it. Move it to a shorter scope with CLI version 1.8.0 or earlier.";
const BOTH = "Name and scope are longer than 64 characters, so this version can't read or delete it. Rename it and move it to a shorter scope with CLI version 1.8.0 or earlier.";

let stored: Record<string, string[]> = {};
let listCalls: (string | undefined)[] = [];
let outputs: Record<string, unknown>[] = [];
let errors: unknown[] = [];

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
      listCalls.push(options?.scope);
      return { ok: true, data: stored[options?.scope ?? ""] ?? [] };
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
mock.module("../output/errors.js", () => ({ ...realErrors, handleError: (error: unknown) => { errors.push(error); } }));

const { registerSecretsCommand } = await import("./secrets.js");

async function list(...args: string[]): Promise<void> {
  const program = new Command();
  program.option("-p, --profile <name>").option("--json");
  registerSecretsCommand(program);
  await program.parseAsync(["node", "tc", "secrets", "list", ...args], { from: "node" });
}

beforeEach(() => {
  stored = {};
  listCalls = [];
  outputs = [];
  errors = [];
});

test("a name over 64 characters is listed with the name note; a name of exactly 64 has none", async () => {
  stored[""] = ["API_KEY", EXACT_NAME, LONG_NAME];

  await list();

  expect(errors).toEqual([]);
  expect(outputs).toEqual([{
    secrets: ["API_KEY", EXACT_NAME, LONG_NAME],
    count: 3,
    unreadable: [{ name: LONG_NAME, note: NAME_ONLY }],
  }]);
});

test("a scope over 64 characters is listed with the scope note on every entry in it", async () => {
  stored[LONG_SCOPE] = ["API_KEY", "TOKEN"];

  await list("--scope", LONG_SCOPE);

  expect(errors).toEqual([]);
  expect(listCalls).toEqual([LONG_SCOPE]);
  expect(outputs[0]).toMatchObject({
    secrets: ["API_KEY", "TOKEN"],
    count: 2,
    unreadable: [{ name: "API_KEY", note: SCOPE_ONLY }, { name: "TOKEN", note: SCOPE_ONLY }],
    scope: LONG_SCOPE,
  });
});

test("a name and a scope both over 64 characters get the combined note", async () => {
  stored[LONG_SCOPE] = [LONG_NAME, "TOKEN"];

  await list("--scope", LONG_SCOPE);

  expect(errors).toEqual([]);
  expect(outputs[0]).toMatchObject({
    count: 2,
    unreadable: [{ name: LONG_NAME, note: BOTH }, { name: "TOKEN", note: SCOPE_ONLY }],
  });
});

test("a list with nothing over the cap has no unreadable entries", async () => {
  stored[""] = ["API_KEY", EXACT_NAME];

  await list();

  expect(outputs).toEqual([{ secrets: ["API_KEY", EXACT_NAME], count: 2 }]);
});
