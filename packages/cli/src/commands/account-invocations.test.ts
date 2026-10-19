import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import * as fsPromises from "node:fs/promises";
import { AccountService } from "@tinycloud/sdk-core";

/**
 * Every `tc account` subcommand runs against a real AccountService whose
 * node-facing seams (spaces, kv, sql, delegations) record the ability each call
 * would invoke. The gate must request a superset of what was invoked, or a
 * command could pass the gate and then 401.
 */
const OWNER = "tinycloud:pkh:eip155:1:0xabc";
const PRIMARY = `${OWNER}:default`;
const ACCOUNT = `${OWNER}:account`;
const OTHER = `${OWNER}:applications`;

interface Invocation { action: string; space: string; path: string }
let invoked: Invocation[] = [];
let gateRequests: { service: string; space: string; path: string; actions: string[] }[][] = [];
let errors: unknown[] = [];

const ok = <T>(data: T) => ({ ok: true as const, data });
const record = (action: string, space: string, path = "") => invoked.push({ action, space, path });

function pathOf(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (Array.isArray(arg)) return String(arg[0] ?? "");
  const prefix = (arg as { prefix?: string } | undefined)?.prefix;
  return prefix ?? "";
}

function kvFor(space: string) {
  const op = (action: string, data: unknown) => async (arg?: unknown) => {
    record(action, space, pathOf(arg));
    return ok(data);
  };
  return {
    get: op("tinycloud.kv/get", { data: {}, headers: {} }),
    batchGet: op("tinycloud.kv/get", []),
    put: op("tinycloud.kv/put", undefined),
    list: op("tinycloud.kv/list", { keys: [] }),
    delete: op("tinycloud.kv/del", undefined),
    head: op("tinycloud.kv/metadata", undefined),
  };
}

const spaceInfo = (id: string, name: string) => ({ id, name, owner: "did:pkh:eip155:1:0xabc", type: "owned" });

const db = {
  query: async () => { record("tinycloud.sql/read", ACCOUNT, "account"); return ok({ columns: [], rows: [] }); },
  batch: async () => { record("tinycloud.sql/write", ACCOUNT, "account"); return ok({ results: [] }); },
  execute: async () => { record("tinycloud.sql/write", ACCOUNT, "account"); return ok({}); },
  migrations: {
    apply: async () => {
      for (const action of ["read", "write", "schema"]) record(`tinycloud.sql/${action}`, ACCOUNT, "account");
      return ok({});
    },
  },
};

const spaces = {
  list: async () => { record("tinycloud.space/list", PRIMARY); return ok([spaceInfo(PRIMARY, "default"), spaceInfo(OTHER, "applications"), spaceInfo(ACCOUNT, "account")]); },
  get: (id: string) => ({
    kv: kvFor(id),
    delegations: {
      list: async () => { record("tinycloud.capabilities/read", id); return ok([]); },
      listReceived: async () => { record("tinycloud.capabilities/read", id); return ok([]); },
      revoke: async () => { record("tinycloud.delegation/revoke", id); return ok(undefined); },
    },
  }),
};

// A fresh service per test: it memoizes that the index schema is applied.
const newService = () => new AccountService({
  getDid: () => "did:pkh:eip155:1:0xabc",
  getHost: () => "https://node.test",
  getPrimarySpaceId: () => PRIMARY,
  getAccountSpaceId: () => ACCOUNT,
  getSpaces: () => spaces as never,
  getDelegationManager: () => ({
    query: async () => { record("tinycloud.delegation/list", ACCOUNT); return ok([]); },
    revoke: async () => { record("tinycloud.delegation/list", ACCOUNT); return ok(undefined); },
  }) as never,
  getAccountDb: () => db as never,
});

let service = newService();

const node = {
  hasRuntimePermissions: (entries: typeof gateRequests[number]) => { gateRequests.push(entries); return true; },
  spaces: spaces,
  get account() { return service; },
};

mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async () => ({ profile: "cli-test", host: "https://node.test" }) },
}));
mock.module("../lib/permissions.js", () => ({
  resolvePermissionSpaces: async (entries: { space: string }[]) =>
    entries.map((entry) => ({ ...entry, space: entry.space.startsWith("tinycloud:") ? entry.space : `${OWNER}:${entry.space}` })),
}));
mock.module("../lib/sdk.js", () => ({ ensureAuthenticated: async () => node }));
mock.module("../output/formatter.js", () => ({
  outputJson: () => {}, output: () => {}, outputError: () => {}, isInteractive: () => false,
  withSpinner: async (_label: string, fn: () => unknown) => await fn(),
  shouldOutputJson: () => true, formatTable: () => "", formatField: () => "", formatBytes: () => "",
  formatTimeAgo: () => "", formatCheck: () => "", formatSection: () => "",
}));
mock.module("../output/theme.js", () => ({
  theme: new Proxy({}, { get: () => (value: string) => value }),
}));
mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(public code: string, message: string, public exitCode: number) { super(message); }
  },
  cliErrorFromService: (error: { code: string; message: string }) => Object.assign(new Error(error.message), { code: error.code }),
  handleError: (error: unknown) => { errors.push(error); },
  wrapError: (error: unknown) => error,
  setActiveProfileName: () => {},
}));
mock.module("node:fs/promises", () => ({
  ...fsPromises,
  readFile: async () => JSON.stringify({ app_id: "com.notes.app", name: "Notes", defaults: false }),
}));
mock.module("open", () => ({ default: async () => {} }));

const { registerAccountCommand } = await import("./account.js");

const commands: string[][] = [
  ["status"],
  ["apps", "list"],
  ["apps", "list", "--live"],
  ["apps", "info", "com.notes.app"],
  ["apps", "register", "manifest.json"],
  ["apps", "remove", "com.notes.app"],
  ["spaces", "list"],
  ["spaces", "list", "--live"],
  ["spaces", "info", OTHER],
  ["spaces", "register", OTHER, "--name", "applications", "--owner", "did:pkh:eip155:1:0xabc"],
  ["spaces", "sync"],
  ["spaces", "remove", OTHER],
  ["delegations", "list"],
  ["delegations", "list", "--live"],
  ["delegations", "list", "--granted"],
  ["delegations", "revoke", "bafycid", "--space", "default"],
  ["index", "ensure"],
  ["index", "status"],
  ["index", "rebuild"],
  ["index", "query", "select 1"],
];

const covers = (
  entries: { space: string; path: string; actions: string[] }[],
  call: Invocation,
) => entries.some((entry) =>
  entry.space === call.space && entry.actions.includes(call.action) && call.path.startsWith(entry.path));

describe("tc account: the gate requests everything the command invokes", () => {
  beforeEach(() => { invoked = []; gateRequests = []; errors = []; service = newService(); });

  test.each(commands.map((args) => [args.join(" "), args] as const))("%s", async (_title, args) => {
    const program = new Command();
    registerAccountCommand(program);
    await program.parseAsync(["node", "tc", "account", ...args], { from: "node" });

    expect(errors).toEqual([]);
    expect(gateRequests.length).toBeGreaterThan(0);
    expect(invoked.length).toBeGreaterThan(0);
    // The gate may ask in stages; everything it asked for together must cover the command.
    const requested = gateRequests.flat();
    const uncovered = invoked.filter((call) => !covers(requested, call));
    expect(uncovered.map((call) => `${call.action} ${call.space.slice(OWNER.length + 1)}/${call.path}`)).toEqual([]);
  });
});
