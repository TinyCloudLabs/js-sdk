import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";
import { DelegationManager, type SessionInvocationSigner } from "@tinycloud/sdk-core/delegations";
import type { ServiceSession } from "@tinycloud/sdk-services";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Isolated home: set before anything runs, and checked before any write.
const originalHome = { HOME: process.env.HOME, TC_HOME: process.env.TC_HOME };
const testHome = mkdtempSync(join("/var/tmp", "tc2132."));
process.env.HOME = testHome;
process.env.TC_HOME = testHome;
function assertTestHome(): void {
  if (!testHome.startsWith("/var/tmp/tc2132.") || process.env.HOME !== testHome || process.env.TC_HOME !== testHome) {
    throw new Error("test HOME/TC_HOME is not the isolated tc2132 dir");
  }
}
assertTestHome();
afterAll(() => {
  assertTestHome();
  rmSync(testHome, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const HOST = "https://node.example.test";
const AGENT_DID = "did:key:z6MkagentAgentAgentAgentAgentAgentAgentAgent";
const FEATURE = "delegation-issued-query-v1";

type Posture = "delegate-session" | "owner-openkey" | "local-owner-key";
let posture: Posture;
let nodeFeatures: string[];
/** CID -> status of what the agent key issued, in CID order. */
let issued: Array<{ cid: string; status: string }>;
/** CIDs the node refuses to revoke for the agent key (not its delegator). */
let notIssuedByAgent: Set<string>;
let revokeStatus: number | undefined;
let queryStatus: number | undefined;
/** When set, a request that carries a cursor is answered with the node's invalid-cursor 400. */
let queryStatusOnCursor: number | undefined;
let pageSize: number;

type QueryBody = { direction?: string; limit?: number; cursor?: string; space?: string };
type Output = {
  cid?: string;
  revoked?: boolean;
  note?: string;
  count?: number;
  delegations?: Array<Record<string, unknown> & { cid: string; status: string }>;
};
type Failure = { code: string; message: string; exitCode: number; metadata?: { hint?: string } };
const outputs: Output[] = [];
const errors: Failure[] = [];
const requests: Array<{ url: string; headers: Record<string, string>; body?: QueryBody }> = [];
const authorityRequests: unknown[] = [];
const ownerRevokeCalls: unknown[] = [];
const ownerQueryCalls: unknown[] = [];

const signer: SessionInvocationSigner = {
  did: () => AGENT_DID,
  sign: async (attenuation) => `signed-by-agent:${JSON.stringify({ iss: AGENT_DID, prf: [], att: attenuation })}`,
};

function claimsOf(authorization: string): { iss: string; prf: unknown[]; att: Record<string, Record<string, unknown[]>> } {
  return JSON.parse(authorization.slice("signed-by-agent:".length));
}

const record = (cid: string, status: string) => ({
  cid,
  direction: "granted",
  delegatorDid: AGENT_DID,
  delegateDid: "did:key:z6MkrecipientRecipientRecipientRecipientRecipient",
  resources: [{ resource: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:agents/kv/work/", actions: ["tinycloud.kv/get"], caveats: [] }],
  parents: [],
  issuedAt: "2026-10-26T10:00:00Z",
  notBefore: null,
  expiresAt: "2026-11-26T10:00:00Z",
  status,
});

async function nodeFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const headers = init.headers ?? {};
  const body: QueryBody | undefined = init.body === undefined ? undefined : JSON.parse(init.body);
  requests.push({ url, headers, body });
  if (url === `${HOST}/info`) return new Response(JSON.stringify({ nodeId: "did:key:z6MknodeNode", features: nodeFeatures }), { status: 200 });
  if (url === `${HOST}/delegation/query`) {
    if (queryStatus !== undefined) return new Response("chain too deep", { status: queryStatus });
    if (queryStatusOnCursor !== undefined && body?.cursor !== undefined) {
      return new Response("invalid delegation query cursor", { status: queryStatusOnCursor });
    }
    const start = body?.cursor === undefined ? 0 : Number(body.cursor);
    const end = start + Math.min(pageSize, body?.limit ?? 50);
    return new Response(JSON.stringify({
      schemaVersion: 2,
      items: issued.slice(start, end).map(({ cid, status }) => record(cid, status)),
      ...(end < issued.length ? { nextCursor: String(end) } : {}),
    }), { status: 200 });
  }
  if (url === `${HOST}/revoke`) {
    if (revokeStatus !== undefined) return new Response("too deep", { status: revokeStatus });
    const cid = Object.keys(claimsOf(headers.Authorization!).att)[0]!.slice("urn:cid:".length);
    if (notIssuedByAgent.has(cid)) return new Response("Unauthorized Revoker", { status: 403 });
    return new Response(JSON.stringify({ revoked: true, cid }), { status: 200 });
  }
  return new Response("unexpected", { status: 500 });
}

function buildNode() {
  const delegationManager = new DelegationManager({
    hosts: [HOST],
    session: { spaceId: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default" } as ServiceSession,
    invoke: () => ({ Authorization: "must-not-be-used" }),
    fetch: nodeFetch as never,
    sessionInvocationSigner: signer,
  });
  return {
    delegationManager,
    // The owner-profile path of `delegation list`: the account query, which a delegate with --granted must not use.
    account: {
      delegations: {
        query: async (options: unknown) => {
          ownerQueryCalls.push(options);
          return { ok: true, data: { schemaVersion: 2, items: [], nextCursor: undefined } };
        },
      },
    },
  };
}

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async () => ({ profile: "agent", host: HOST, posture }),
    getSession: async () => null,
    getProfile: async () => ({ name: "agent", host: HOST, authMethod: "openkey", posture }),
  },
}));
mock.module("../lib/sdk.js", () => ({ ensureAuthenticated: async () => buildNode() }));
mock.module("../lib/revoke-delegation.js", () => ({
  revokeDelegationOnNode: async (params: { cid: string }) => {
    ownerRevokeCalls.push(params.cid);
    return { cid: params.cid, revoked: true };
  },
}));
mock.module("./auth.js", () => ({
  // An agents-space (or any) revoke grant is requested through this function.
  ensureDelegationAuthority: async (params: unknown) => {
    authorityRequests.push(params);
    return undefined;
  },
  requirePermissionConsent: async () => {},
  finishProfileLogout: async () => 0,
  prepareProfileRemoteLogout: async () => undefined,
}));
mock.module("../output/formatter.js", () => ({
  outputJson: (value: Output) => outputs.push(value),
  isInteractive: () => false,
}));
mock.module("../output/errors.js", () => ({
  CLIError: class CLIError extends Error {
    constructor(
      public code: string,
      message: string,
      public exitCode: number,
      public metadata?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
  cliErrorFromService: (error: unknown) => error,
  handleError: (error: Failure) => errors.push(error),
}));

const { registerDelegationCommand } = await import("./delegation.js");

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  registerDelegationCommand(program);
  await program.parseAsync(["node", "tc", "delegation", ...args]);
}

beforeEach(() => {
  assertTestHome();
  posture = "delegate-session";
  nodeFeatures = [FEATURE];
  issued = [];
  notIssuedByAgent = new Set();
  revokeStatus = undefined;
  queryStatus = undefined;
  queryStatusOnCursor = undefined;
  pageSize = 100;
  outputs.length = 0;
  errors.length = 0;
  requests.length = 0;
  authorityRequests.length = 0;
  ownerRevokeCalls.length = 0;
  ownerQueryCalls.length = 0;
});

describe("tc delegation list --granted from a delegate profile", () => {
  test("lists what the agent key issued across every page, with status, and says the order is by id", async () => {
    issued = [{ cid: "bafy-a", status: "active" }, { cid: "bafy-b", status: "revoked" }, { cid: "bafy-c", status: "ancestor_revoked" }];
    pageSize = 1;

    await run("list", "--granted");

    expect(errors).toEqual([]);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.count).toBe(3);
    expect(outputs[0]!.delegations!.map((d) => [d.cid, d.status])).toEqual([
      ["bafy-a", "active"],
      ["bafy-b", "revoked"],
      ["bafy-c", "ancestor_revoked"],
    ]);
    expect(outputs[0]!.delegations![0]).toEqual({
      cid: "bafy-a",
      delegatee: "did:key:z6MkrecipientRecipientRecipientRecipientRecipient",
      delegator: AGENT_DID,
      direction: "granted",
      status: "active",
      expiry: "2026-11-26T10:00:00.000Z",
      resources: [{ space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:agents", service: "kv", path: "work/", actions: ["tinycloud.kv/get"] }],
    });
    expect(outputs[0]!.note).toBe("Sorted by delegation ID, not by date.");
    expect(ownerQueryCalls).toEqual([]);
    const queries = requests.filter((r) => r.url.endsWith("/delegation/query"));
    expect(queries.map((q) => q.body)).toEqual([
      { direction: "issued", limit: 100 },
      { direction: "issued", limit: 100, cursor: "1" },
      { direction: "issued", limit: 100, cursor: "2" },
    ]);
    for (const query of queries) {
      const claims = claimsOf(query.headers.Authorization!);
      expect(claims.att).toEqual({ [`${AGENT_DID}/delegation`]: { "tinycloud.delegation/list": [{}] } });
      expect(claims.prf).toEqual([]);
    }
  });

  test("--space is sent as the node's space filter", async () => {
    await run("list", "--granted", "--space", "agents");

    expect(requests.find((r) => r.url.endsWith("/delegation/query"))!.body).toEqual({ direction: "issued", limit: 100, space: "agents" });
  });

  test("a node without delegation-issued-query-v1 gets a clear message and the node-error exit code 7", async () => {
    nodeFeatures = [];

    await run("list", "--granted");

    expect(outputs).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "ISSUED_DELEGATIONS_UNAVAILABLE", exitCode: 7 });
    expect(errors[0].message).toBe(`${HOST} can't list the delegations you issued yet.`);
    expect(requests.some((r) => r.url.endsWith("/delegation/query"))).toBe(false);
  });

  test("a chain the node will not evaluate (503) is a retryable node error", async () => {
    queryStatus = 503;

    await run("list", "--granted");

    expect(errors[0]).toMatchObject({ code: "CHAIN_TOO_DEEP", exitCode: 7 });
    expect(errors[0].message).toContain("Try again later");
  });

  test("a cursor the node rejects is one clear error, not a partial list", async () => {
    issued = [{ cid: "bafy-a", status: "active" }, { cid: "bafy-b", status: "active" }];
    pageSize = 1;
    queryStatusOnCursor = 400;

    await run("list", "--granted");

    expect(outputs).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "INVALID_CURSOR", exitCode: 7 });
  });

  test("list without --granted, and --received, keep the account query", async () => {
    await run("list");
    await run("list", "--received");

    expect(ownerQueryCalls).toMatchObject([{ direction: "all" }, { direction: "received" }]);
    expect(requests).toEqual([]);
  });
});

describe("tc delegation revoke from a delegate profile", () => {
  test("posts a proofless revocation signed by the agent key and never asks for revoke authority", async () => {
    issued = [{ cid: "bafy-child", status: "active" }];

    await run("revoke", "bafy-child");

    expect(errors).toEqual([]);
    expect(outputs).toEqual([{ cid: "bafy-child", revoked: true }]);
    const revoke = requests.find((r) => r.url === `${HOST}/revoke`)!;
    const claims = claimsOf(revoke.headers.Authorization!);
    expect(claims.iss).toBe(AGENT_DID);
    expect(claims.prf).toEqual([]);
    expect(claims.att).toEqual({ "urn:cid:bafy-child": { "tinycloud.delegation/revoke": [{}] } });
    // TC-1922: no revoke grant (agents space or otherwise) is requested, and the owner path is not entered.
    expect(authorityRequests).toEqual([]);
    expect(ownerRevokeCalls).toEqual([]);
  });

  test("revokes directly, with no listing first: an already revoked delegation answers 200 and reads as a first revocation", async () => {
    issued = [{ cid: "bafy-old", status: "revoked" }];

    await run("revoke", "bafy-old");

    expect(errors).toEqual([]);
    expect(outputs).toEqual([{ cid: "bafy-old", revoked: true }]);
    expect(requests.map((r) => r.url)).toEqual([`${HOST}/revoke`]);
  });

  test("a node without the issued listing still revokes", async () => {
    nodeFeatures = [];

    await run("revoke", "bafy-child");

    expect(errors).toEqual([]);
    expect(outputs).toEqual([{ cid: "bafy-child", revoked: true }]);
  });

  test("a delegation the agent key did not issue is refused with the node's message and exit code 5", async () => {
    notIssuedByAgent.add("bafy-owner-grant");

    await run("revoke", "bafy-owner-grant");

    expect(outputs).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "REVOKE_UNAUTHORIZED", exitCode: 5 });
    expect(errors[0].message).toBe("The node refused this revocation: Unauthorized Revoker.");
    expect(errors[0]!.metadata?.hint).toContain("delegation list --granted");
    expect(authorityRequests).toEqual([]);
  });

  test("503 is a retryable node error", async () => {
    revokeStatus = 503;

    await run("revoke", "bafy-child");

    expect(errors[0]).toMatchObject({ code: "CHAIN_TOO_DEEP", exitCode: 7 });
  });
});

describe("owner profiles are unchanged", () => {
  test.each(["owner-openkey", "local-owner-key"] as const)("%s: list --granted uses the account query", async (owner) => {
    posture = owner;

    await run("list", "--granted");

    expect(ownerQueryCalls).toMatchObject([{ direction: "granted" }]);
    expect(requests).toEqual([]);
  });

  test.each(["owner-openkey", "local-owner-key"] as const)("%s: revoke goes through the owner revocation flow", async (owner) => {
    posture = owner;

    await run("revoke", "bafy-child");

    expect(ownerRevokeCalls).toEqual(["bafy-child"]);
    expect(requests).toEqual([]);
  });
});
