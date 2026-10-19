import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { PermissionNotInManifestError } from "@tinycloud/node-sdk";

const outputs: any[] = [];
const errors: any[] = [];
const ownerDid = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const spaceId = `tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default`;

// The node serves delegation creation through delegateTo (sign + POST /delegate)
// and account-wide listing through account.delegations.list. It has no
// tinycloud.delegation/create|list invocation, so this fake exposes no
// delegationManager: reaching for one fails the command.
let store: any[];
const sessionServices = new Set(["tinycloud.kv", "tinycloud.sql"]);
const delegateToCalls: any[] = [];
const listCalls: any[] = [];
const fakeNode = {
  delegateTo: async (did: string, permissions: any[], options: { expiry: number }) => {
    delegateToCalls.push({ did, permissions, options });
    // Like the real planDerivation: an entry is covered only if the session holds its
    // service in exactly that space; an entry with no space means "applications".
    const missing = permissions.filter((p) => (p.space ?? "applications") !== "default" || !sessionServices.has(p.service));
    if (missing.length > 0) throw new PermissionNotInManifestError(missing, []);
    const expiry = new Date(Date.now() + options.expiry);
    const delegation = {
      cid: `bafy-created-${store.length + 1}`,
      path: permissions[0].path,
      actions: permissions.flatMap((p) => p.actions),
      expiry,
      delegateDID: did,
      spaceId,
    };
    store.push({
      cid: delegation.cid,
      direction: "granted",
      spaceId,
      counterpartyDid: did,
      delegateDid: did,
      delegatorDid: ownerDid,
      path: delegation.path,
      actions: delegation.actions,
      expiry,
      status: "active",
    });
    return { delegation, prompted: false };
  },
  account: {
    delegations: {
      list: async (options: { direction?: string; preferIndex?: boolean }) => {
        listCalls.push(options);
        const direction = options.direction ?? "all";
        return { ok: true, data: store.filter((d) => direction === "all" || d.direction === direction) };
      },
    },
  },
};

mock.module("../config/profiles.js", () => ({
  ProfileManager: { resolveContext: async () => ({ profile: "owner", host: "https://node.example.test" }) },
}));
mock.module("../lib/sdk.js", () => ({ ensureAuthenticated: async () => fakeNode }));
mock.module("./auth.js", () => ({ finishProfileLogout: async () => 0, prepareProfileRemoteLogout: async () => undefined }));
mock.module("../lib/revoke-delegation.js", () => ({ revokeDelegationOnNode: async () => ({}) }));
mock.module("../output/formatter.js", () => ({
  outputJson: (value: unknown) => outputs.push(value),
  isInteractive: () => false,
}));
mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(public code: string, message: string, public exitCode: number) {
      super(message);
    }
  },
  cliErrorFromService: (error: unknown) => error,
  handleError: (error: unknown) => errors.push(error),
}));

const { registerDelegationCommand } = await import("./delegation.js");

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  registerDelegationCommand(program);
  await program.parseAsync(["node", "tc", "delegation", ...args]);
}

const recipient = "did:key:z6MkrecipientRecipientRecipientRecipientRecipient";

beforeEach(() => {
  store = [];
  outputs.length = 0;
  errors.length = 0;
  delegateToCalls.length = 0;
  listCalls.length = 0;
  sessionServices.add("tinycloud.sql");
});

describe("tc delegation create / list", () => {
  test("a created delegation is returned with its CID and then shown by list", async () => {
    await run("create", "--to", recipient, "--path", "qa-seed/", "--actions", "kv/get,kv/list", "--expiry", "1h");
    expect(errors).toEqual([]);
    const created = outputs[0];
    expect(created).toMatchObject({
      cid: "bafy-created-1",
      delegateDid: recipient,
      path: "qa-seed/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
    });
    const lifetimeMs = Date.parse(created.expiry) - Date.now();
    expect(lifetimeMs).toBeGreaterThan(59 * 60_000);
    expect(lifetimeMs).toBeLessThanOrEqual(60 * 60_000);

    await run("list");
    expect(errors).toEqual([]);
    expect(outputs[1].count).toBe(1);
    expect(outputs[1].delegations[0]).toMatchObject({
      cid: created.cid,
      delegatee: recipient,
      delegator: ownerDid,
      path: "qa-seed/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
      status: "active",
    });
  });

  test("actions from several services become one delegateTo call with an entry per service", async () => {
    await run("create", "--to", recipient, "--path", "data/", "--actions", "kv/get,sql/read");
    expect(errors).toEqual([]);
    expect(delegateToCalls).toHaveLength(1);
    expect(delegateToCalls[0].permissions).toEqual([
      { service: "tinycloud.kv", space: "default", path: "data/", actions: ["tinycloud.kv/get"] },
      { service: "tinycloud.sql", space: "default", path: "data/", actions: ["tinycloud.sql/read"] },
    ]);
  });

  test("a session that lacks a requested service is refused naming the missing ability and path", async () => {
    sessionServices.delete("tinycloud.sql");
    await run("create", "--to", recipient, "--path", "data/", "--actions", "kv/get,sql/read");
    expect(outputs).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "PERMISSION_DENIED", exitCode: 5 });
    expect(errors[0].message).toContain('tinycloud.sql/read on space "default" path "data/"');
    expect(errors[0].message).not.toContain("tinycloud.kv/get");
  });

  test("an action without a service is refused before anything is signed", async () => {
    await run("create", "--to", recipient, "--path", "x/", "--actions", "get");
    expect(delegateToCalls).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "USAGE_ERROR" });
    expect(outputs).toEqual([]);
  });

  test("list --granted and --received filter by direction, and both together are refused", async () => {
    store.push(
      { cid: "bafy-out", direction: "granted", delegateDid: recipient, delegatorDid: ownerDid, actions: [], expiry: new Date(0), status: "active" },
      { cid: "bafy-in", direction: "received", delegateDid: ownerDid, delegatorDid: recipient, actions: [], expiry: new Date(0), status: "active" },
    );
    await run("list", "--granted");
    await run("list", "--received");
    expect(outputs.map((o) => o.delegations.map((d: any) => d.cid))).toEqual([["bafy-out"], ["bafy-in"]]);

    await run("list", "--granted", "--received");
    expect(errors[0]).toMatchObject({ code: "USAGE_ERROR" });
    expect(outputs).toHaveLength(2);
  });

  test("list reads live account state, not the SQLite index that a fresh delegation would miss, and passes --space", async () => {
    await run("list");
    await run("list", "--space", "default");
    expect(listCalls).toEqual([{ direction: "all" }, { direction: "all", space: "default" }]);
    expect(listCalls.every((call) => call.preferIndex === undefined)).toBe(true);
  });

  test("info returns the details of a delegation that create just made", async () => {
    await run("create", "--to", recipient, "--path", "qa-seed/", "--actions", "kv/get", "--expiry", "1h");
    const { cid } = outputs[0];
    await run("info", cid);
    expect(errors).toEqual([]);
    expect(outputs[1]).toMatchObject({ cid, delegatee: recipient, delegator: ownerDid, path: "qa-seed/", status: "active" });
  });

  test("info for an unknown CID exits not-found instead of crashing", async () => {
    await run("info", "bafy-unknown");
    expect(outputs).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "NOT_FOUND" });
  });
});
