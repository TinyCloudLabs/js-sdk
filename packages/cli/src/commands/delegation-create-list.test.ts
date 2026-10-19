import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { PermissionNotInManifestError } from "@tinycloud/node-sdk";

const outputs: any[] = [];
const errors: any[] = [];
const ownerDid = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const sessionKeyDid = "did:key:z6MksessionSessionSessionSessionSessionSession";
const spaceUri = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default";

// The node serves delegation creation through delegateTo (sign + POST /delegate)
// and lists it through POST /delegation/query, where a session-signed delegation
// has the SESSION KEY as its delegator. The account-wide `account.delegations.list`
// (capabilities/read, filtered to owner-signed) never returns it, so this fake
// exposes only `query`: reaching for `list` or a delegationManager fails the command.
let store: any[];
let queryHidesNewDelegations = false;
let sessionCanQuery = true;
let newDelegationStatus = "active";
const sessionServices = new Set(["tinycloud.kv", "tinycloud.sql"]);
const delegateToCalls: any[] = [];
const queryCalls: any[] = [];
const fakeNode = {
  delegateTo: async (did: string, permissions: any[], options: { expiry: number }) => {
    delegateToCalls.push({ did, permissions, options });
    // Like the real planDerivation: an entry is covered only if the session holds its
    // service in exactly that space; an entry with no space means "applications".
    const missing = permissions.filter((p) => (p.space ?? "applications") !== "default" || !sessionServices.has(p.service));
    if (missing.length > 0) throw new PermissionNotInManifestError(missing, []);
    const expiry = new Date(Date.now() + options.expiry);
    const cid = `bafy-created-${store.length + 1}`;
    if (!queryHidesNewDelegations) {
      store.push({
        cid,
        direction: "granted",
        delegatorDid: sessionKeyDid,
        delegateDid: did,
        resources: permissions.map((p) => ({ resource: `${spaceUri}/${p.service.replace("tinycloud.", "")}/${p.path}`, actions: p.actions, caveats: [] })),
        parents: [],
        issuedAt: new Date(),
        notBefore: null,
        expiresAt: expiry,
        status: newDelegationStatus,
      });
    }
    return { delegation: { cid, expiry, delegateDID: did }, prompted: false };
  },
  account: {
    delegations: {
      query: async (options: { direction?: string; space?: string; limit?: number; cursor?: string }) => {
        queryCalls.push(options);
        if (!sessionCanQuery) return { ok: false, error: { code: "PERMISSION_DENIED", message: "403" } };
        const direction = options.direction ?? "all";
        const matching = store.filter((d) => direction === "all" || d.direction === direction);
        const start = options.cursor ? Number(options.cursor) : 0;
        const end = start + 1; // one record per page, to exercise paging
        return {
          ok: true,
          data: { schemaVersion: 2, items: matching.slice(start, end), nextCursor: end < matching.length ? String(end) : undefined },
        };
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
  queryHidesNewDelegations = false;
  sessionCanQuery = true;
  newDelegationStatus = "active";
  outputs.length = 0;
  errors.length = 0;
  delegateToCalls.length = 0;
  queryCalls.length = 0;
  sessionServices.add("tinycloud.sql");
});

describe("tc delegation create / list / info", () => {
  test("a created delegation is read back, returned with its CID, and then shown by list and info", async () => {
    await run("create", "--to", recipient, "--path", "qa-seed/", "--actions", "kv/get,kv/list", "--expiry", "1h");
    expect(errors).toEqual([]);
    const created = outputs[0];
    expect(created).toMatchObject({
      cid: "bafy-created-1",
      delegateDid: recipient,
      delegatorDid: sessionKeyDid,
      path: "qa-seed/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
      status: "active",
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
      delegator: sessionKeyDid,
      status: "active",
      resources: [{ space: spaceUri, service: "kv", path: "qa-seed/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] }],
    });

    await run("info", created.cid);
    expect(errors).toEqual([]);
    expect(outputs[2]).toMatchObject({ cid: created.cid, delegator: sessionKeyDid, status: "active" });
  });

  test("create fails, and prints no CID, when the node does not list the delegation it accepted", async () => {
    queryHidesNewDelegations = true;
    await run("create", "--to", recipient, "--path", "qa-seed/", "--actions", "kv/get");
    expect(outputs).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "DELEGATION_NOT_CONFIRMED" });
    expect(errors[0].message).toContain("bafy-created-1");
  });

  test("create fails when the node lists the new delegation as anything but active", async () => {
    newDelegationStatus = "pending";
    await run("create", "--to", recipient, "--path", "qa-seed/", "--actions", "kv/get");
    expect(outputs).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "DELEGATION_NOT_CONFIRMED" });
    expect(errors[0].message).toContain("pending");
  });

  test("a did:key with a #fragment, as `tc profile show` prints it, is accepted", async () => {
    await run("create", "--to", `${recipient}#${recipient.slice("did:key:".length)}`, "--path", "x/", "--actions", "kv/get");
    expect(errors).toEqual([]);
    expect(delegateToCalls[0].did).toBe(recipient);
    expect(outputs[0].delegateDid).toBe(recipient);
  });

  test("list pages through every result", async () => {
    await run("create", "--to", recipient, "--path", "a/", "--actions", "kv/get");
    await run("create", "--to", recipient, "--path", "b/", "--actions", "kv/get");
    await run("list");
    expect(outputs[2].delegations.map((d: any) => d.cid)).toEqual(["bafy-created-1", "bafy-created-2"]);
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

  test("a session without delegation/list gets a typed error that says to log in again, from list, info and create's read-back", async () => {
    sessionCanQuery = false;
    await run("list");
    await run("info", "bafy-any");
    await run("create", "--to", recipient, "--path", "qa-seed/", "--actions", "kv/get");
    expect(outputs).toEqual([]);
    expect(errors).toHaveLength(3);
    for (const error of errors) {
      expect(error).toMatchObject({ code: "PERMISSION_DENIED", exitCode: 5 });
      expect(error.message).toContain("tinycloud.delegation/list");
      expect(error.message).toMatch(/auth login/);
    }
  });

  test("list --granted and --received filter by direction, and both together are refused", async () => {
    const base = { delegatorDid: ownerDid, delegateDid: recipient, resources: [], parents: [], issuedAt: null, notBefore: null, expiresAt: null, status: "active" };
    store.push({ ...base, cid: "bafy-out", direction: "granted" }, { ...base, cid: "bafy-in", direction: "received" });
    await run("list", "--granted");
    await run("list", "--received");
    expect(outputs.map((o) => o.delegations.map((d: any) => d.cid))).toEqual([["bafy-out"], ["bafy-in"]]);

    await run("list", "--granted", "--received");
    expect(errors[0]).toMatchObject({ code: "USAGE_ERROR" });
    expect(outputs).toHaveLength(2);
  });

  test("list passes --space to the node query", async () => {
    await run("list", "--space", "default");
    expect(queryCalls[0]).toMatchObject({ direction: "all", space: "default" });
  });

  test("info for an unknown CID exits not-found", async () => {
    await run("info", "bafy-unknown");
    expect(outputs).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "NOT_FOUND" });
  });
});
