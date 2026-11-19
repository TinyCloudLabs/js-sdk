import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import * as fsPromises from "node:fs/promises";
import { AccountService, DelegationManager, KVService, SpaceService } from "@tinycloud/sdk-core";
import { ServiceContext, SQLService } from "@tinycloud/sdk-services";

/**
 * Every `tc account` subcommand runs against the production AccountService,
 * SpaceService, KVService, SQLService and DelegationManager, wired as the node
 * SDK wires them, over a fake `invoke`/`invokeAny`/`fetch`. The `invoke` fake
 * records the (space, service, path, action) each call asks to be signed for, so
 * the abilities come from production code, not hand-written labels. The gate must
 * request a superset of what was recorded, or a command could pass the gate and
 * then 401.
 */
const OWNER = "tinycloud:pkh:eip155:1:0x2F9faD83Dbbb1E6bF56Acb7e651225C070B7774b";
const PRIMARY = `${OWNER}:default`;
const ACCOUNT = `${OWNER}:account`;
const OTHER = `${OWNER}:applications`;

interface Invocation { action: string; space: string; path: string }
let invoked: Invocation[] = [];
let gateRequests: { service: string; space: string; path: string; actions: string[] }[][] = [];
let errors: unknown[] = [];
let authMethod = "openkey";
let lastAction = "";

const json = (body: unknown, status = 200) => ({
  ok: status < 400, status, statusText: "",
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body, text: async () => JSON.stringify(body),
  clone() { return this; },
}) as never;

/** What the node would answer, by the action the previous invoke() was signed for. */
function answer(url: string): unknown {
  if (url.endsWith("/revoke")) return { revoked: true, cid: "bafycid" };
  if (lastAction === "tinycloud.space/list") {
    return [PRIMARY, OTHER, ACCOUNT].map((id) => ({ id, name: id.split(":").pop(), owner: "did:pkh:eip155:1:0x2F9faD83Dbbb1E6bF56Acb7e651225C070B7774b" }));
  }
  if (lastAction === "tinycloud.kv/list") return [];
  if (lastAction.startsWith("tinycloud.sql/")) return { columns: [], rows: [], rowCount: 0, changes: 0 };
  return {};
}

const session = {
  delegationHeader: { Authorization: "session" }, delegationCid: "bafysession", spaceId: PRIMARY,
  verificationMethod: "did:key:session", jwk: {},
} as never;

const invoke = (sess: { spaceId: string }, service: string, path: string, action: string) => {
  lastAction = action;
  invoked.push({ action, space: sess.spaceId, path });
  return { Authorization: "x" };
};
const invokeAny = (_sess: unknown, entries: { resource?: string; spaceId?: string; path: string; action: string }[]) => {
  for (const entry of entries) {
    lastAction = entry.action;
    invoked.push({ action: entry.action, space: entry.spaceId ?? entry.resource ?? "", path: entry.path });
  }
  return { Authorization: "x" };
};
const fetchFake = async (url: string) => json(answer(url));

function scoped(spaceId: string): ServiceContext {
  const context = new ServiceContext({ invoke: invoke as never, invokeAny: invokeAny as never, fetch: fetchFake as never, hosts: ["https://node.test"] });
  context.setSession({ ...(session as object), spaceId } as never);
  return context;
}

// Wired as TinyCloudNode wires them (account getter, createSpaceScopedKVService, sqlForSpace).
const newService = () => {
  const spaces = new SpaceService({
    hosts: ["https://node.test"], session, invoke: invoke as never, fetch: fetchFake as never,
    userDid: "did:pkh:eip155:1:0x2F9faD83Dbbb1E6bF56Acb7e651225C070B7774b",
    createKVService: (spaceId) => {
      const kv = new KVService({});
      kv.initialize(scoped(spaceId));
      return kv;
    },
  });
  const sql = new SQLService({});
  sql.initialize(scoped(ACCOUNT));
  const manager = new DelegationManager({
    hosts: ["https://node.test"], accountSpaceId: ACCOUNT, session,
    invoke: invoke as never, invokeAny: invokeAny as never, fetch: fetchFake as never,
    // A local-key profile has the owner wallet; an OpenKey profile does not.
    signOwnerRevocation: authMethod === "local" ? async () => "owner-signature" : undefined,
  });
  return new AccountService({
    getDid: () => "did:pkh:eip155:1:0x2F9faD83Dbbb1E6bF56Acb7e651225C070B7774b",
    getHost: () => "https://node.test",
    getPrimarySpaceId: () => PRIMARY,
    getAccountSpaceId: () => ACCOUNT,
    getSpaces: () => spaces,
    getDelegationManager: () => manager,
    getAccountDb: () => sql.db("account"),
  });
};
let service = newService();

const node: { hasRuntimePermissions: (entries: typeof gateRequests[number]) => boolean; readonly account: AccountService } = {
  hasRuntimePermissions: (entries) => { gateRequests.push(entries); return true; },
  get account() { return service; },
};

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async () => ({ profile: "cli-test", host: "https://node.test" }),
    getProfile: async () => ({ authMethod }),
  },
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
  beforeEach(() => { invoked = []; gateRequests = []; errors = []; authMethod = "openkey"; lastAction = ""; service = newService(); });

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

describe("tc account delegations revoke", () => {
  beforeEach(() => { invoked = []; gateRequests = []; errors = []; authMethod = "openkey"; lastAction = ""; service = newService(); });

  const revoke = async () => {
    const program = new Command();
    registerAccountCommand(program);
    await program.parseAsync(["node", "tc", "account", "delegations", "revoke", "bafycid", "--space", "default"], { from: "node" });
  };

  test("a local-key profile signs with the owner wallet: no session ability is invoked or demanded", async () => {
    authMethod = "local";
    service = newService();
    node.hasRuntimePermissions = () => false; // a session holding nothing must not block it
    try {
      await revoke();
    } finally {
      node.hasRuntimePermissions = (entries) => { gateRequests.push(entries); return true; };
    }

    expect(errors).toEqual([]);
    expect(invoked).toEqual([]);
  });

  test("an OpenKey session can only revoke through a raw urn:cid ability no grant carries, so the gate refuses first", async () => {
    // What production code does without an owner signer (the reason the gate refuses):
    await service.delegations.revoke({ cid: "bafycid", space: "default" });
    expect(invoked).toEqual([{ action: "tinycloud.delegation/revoke", space: "urn:cid:bafycid", path: "" }]);

    invoked = [];
    await revoke();
    expect(invoked).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ code: "ACCOUNT_REVOKE_UNSUPPORTED", exitCode: 5 })]);
  });
});
