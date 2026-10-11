import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import * as artifacts from "../artifacts.js";
import type {
  InvocationTarget,
  OperationContextSummary,
  OperationResult,
  OperationRuntimeRequirement,
  StoredGrantSkipReason,
} from "../contract.js";
import type { OperationError } from "../errors.js";
import { invokeOperation } from "../invoke.js";
import { isLocalOwnerProfile } from "../profile.js";
import * as runtime from "../runtime.js";
import { readAuthRequests } from "../state.js";

const OWNER_ADDRESS = "0xd559CCd9EB87c530A9a349262669386dE93cf412";
const OWNER = `did:pkh:eip155:1:${OWNER_ADDRESS}`;
const OTHER_OWNER = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
// The node authorizes the EIP-55 space id (S3-T9 found the lowercased form refused).
const SECRETS_SPACE = `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:secrets`;

type ProbeResult = { ok: true; data: unknown } | { ok: false; error: unknown };
type Probe = (path: string) => ProbeResult | Promise<ProbeResult>;

const present = (): ProbeResult => ({ ok: true, data: "ciphertext" });
const notFound = (): ProbeResult => ({ ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: "Key not found" } });
const spaceNotFound = (): ProbeResult => ({
  ok: false,
  error: { code: "KV_NOT_FOUND", service: "kv", message: "KV 404 - Space not found", meta: { status: 404 } },
});
const plain401 = (): ProbeResult => ({
  ok: false,
  error: { code: "AUTH_UNAUTHORIZED", service: "kv", message: "Unauthorized", meta: { status: 401 } },
});
const forbidden = (): ProbeResult => ({
  ok: false,
  error: { code: "AUTH_UNAUTHORIZED", service: "kv", message: "Forbidden", meta: { status: 403 } },
});
const capability401 = (path: string): ProbeResult => ({
  ok: false,
  error: {
    code: "AUTH_UNAUTHORIZED",
    service: "kv",
    message: "Unauthorized Action",
    meta: { status: 401, resource: `${SECRETS_SPACE}/kv/${path}`, requiredAction: "tinycloud.kv/get" },
  },
});
const unavailable = (): ProbeResult => ({
  ok: false,
  error: { code: "NETWORK_ERROR", service: "kv", message: "503", meta: { status: 503 } },
});

interface FakeRuntime {
  summary: OperationContextSummary;
  localOwner: boolean;
  skippedGrantReasons: StoredGrantSkipReason[];
  probes: Record<string, Probe>;
  inspection?: OperationContextSummary;
}

let home: string;
let fake: FakeRuntime;
let requirements: OperationRuntimeRequirement[];
let kvSpaces: string[];
let probeCalls: { path: string; options: unknown }[];
let readSecretCalls: number;

const delegateSummary: OperationContextSummary = {
  profile: "agent",
  host: "https://node.example",
  posture: "delegate-session",
  operatorType: "agent",
  principalDid: "did:key:z6MkAgent",
  sessionDid: "did:key:z6MkAgent",
  ownerDid: OWNER,
  space: `tinycloud:pkh:eip155:1:${OWNER_ADDRESS}:default`,
};

const persisted = spyOn(artifacts, "createOrReusePermissionRequest");
spyOn(runtime, "createInvocationRuntime").mockImplementation(
  async (_target: InvocationTarget, requirement: OperationRuntimeRequirement = "authenticated") => {
    requirements.push(requirement);
    if (requirement === "inspection") {
      return { ok: true, context: { summary: fake.inspection ?? fake.summary, runtime: { node: {}, granted: [] } } };
    }
    const node = {
      kvForSpace(space: string) {
        kvSpaces.push(space);
        return {
          async get(path: string, options: unknown) {
            probeCalls.push({ path, options });
            const name = path.split("/").at(-1)!;
            const probe = fake.probes[name];
            if (probe === undefined) throw new Error(`unexpected probe ${path}`);
            return probe(path);
          },
        };
      },
      readSecret() {
        readSecretCalls += 1;
        throw new Error("status must never read a secret");
      },
    };
    return {
      ok: true,
      context: {
        summary: fake.summary,
        runtime: {
          node,
          granted: [],
          localOwner: fake.localOwner,
          skippedGrantReasons: fake.skippedGrantReasons,
        },
      },
    };
  },
);

beforeEach(async () => {
  home = await mkdtemp(`${tmpdir()}/tinycloud-secrets-status-`);
  process.env.TC_HOME = home;
  requirements = [];
  kvSpaces = [];
  probeCalls = [];
  readSecretCalls = 0;
  persisted.mockClear();
  fake = { summary: delegateSummary, localOwner: false, skippedGrantReasons: [], probes: {} };
});

afterEach(async () => {
  // No request is ever saved: the permission-request store stays empty.
  expect(persisted).not.toHaveBeenCalled();
  expect(await readAuthRequests("agent")).toEqual([]);
  expect(readSecretCalls).toBe(0);
  for (const call of probeCalls) {
    expect(call.options).toEqual({ raw: true, prefix: "", timeout: 15_000 });
  }
  delete process.env.TC_HOME;
  await rm(home, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

function status(input: Record<string, unknown>, target: InvocationTarget = {}) {
  return invokeOperation("tinycloud.secrets.status", 1, { profile: "agent", ...target }, input);
}

test("rule (a): present and pending names give ready or pending, with a link for pending names only", async () => {
  fake.probes = { A: present, B: notFound, C: spaceNotFound };
  const result = await status({ names: ["A", "B", "C", "A"], scope: "Food Drinks" });

  expect(requirements).toEqual(["inspection", "restored"]);
  expect(kvSpaces).toEqual([SECRETS_SPACE]);
  expect(probeCalls.map((call) => call.path).sort()).toEqual([
    "vault/secrets/scoped/food-drinks/A",
    "vault/secrets/scoped/food-drinks/B",
    "vault/secrets/scoped/food-drinks/C",
  ]);
  expect(result).toEqual({
    status: "ok",
    operation: { operationId: "tinycloud.secrets.status", operationVersion: 1 },
    context: delegateSummary,
    output: {
      status: "pending",
      owner: OWNER,
      names: ["A", "B", "C"],
      scope: "food-drinks",
      present: ["A"],
      pending: ["B", "C"],
      denied: [],
      setup: {
        url: `https://secrets.tinycloud.xyz/request?owner=${encodeURIComponent(OWNER)}&name=B&name=C&scope=food-drinks&v=1`,
        names: ["B", "C"],
        scope: "food-drinks",
        owner: OWNER,
        action: "add_secret",
      },
    },
  });

  fake.probes = { A: present };
  expect(await status({ names: ["A"] })).toMatchObject({
    status: "ok",
    output: { status: "ready", present: ["A"], pending: [], denied: [] },
  });
  expect(outputOf(await status({ names: ["A"] }))).not.toHaveProperty("setup");
});

test("rule (a): a local identity, including a hybrid privateKey + OpenKey profile, gets a hint and no link", async () => {
  const hybrid = { posture: "owner-openkey", authMethod: "openkey", privateKey: "0xabc" };
  fake.summary = {
    profile: "agent",
    host: "https://node.example",
    posture: "owner-openkey",
    operatorType: "human",
    principalDid: OWNER,
    sessionDid: "did:key:z6MkSession",
  };
  fake.localOwner = isLocalOwnerProfile(hybrid);
  fake.probes = { A: notFound };
  const result = await status({ names: ["A"] }, { allowOwnerProfile: true });

  expect(fake.localOwner).toBe(true);
  expect(JSON.stringify(outputOf(result))).not.toContain("https://");
  expect(result).toMatchObject({
    status: "ok",
    output: { status: "pending", owner: OWNER, pending: ["A"], hint: expect.stringContaining("tc secrets put A --stdin") },
  });
});

test("rule (b): a plain 401 probe is AUTH_REQUIRED with the profile's sign-in recovery", async () => {
  fake.probes = { A: present, B: plain401 };
  expect(await status({ names: ["A", "B"] })).toMatchObject({
    status: "error",
    error: {
      code: "AUTH_REQUIRED",
      retryable: false,
      details: {
        recovery: {
          action: "sign_in",
          command: "tc --profile agent auth login --method openkey --paste --manifest <manifest.json>",
        },
      },
    },
  });
});

test("rule (b): grant A unavailable (503) and grant B unauthenticated (401), both probes denied, is AUTH_REQUIRED", async () => {
  fake.skippedGrantReasons = ["activation_unavailable", "activation_unauthenticated"];
  fake.probes = { A: forbidden, B: capability401 };
  expect(await status({ names: ["A", "B"] })).toMatchObject({
    status: "error",
    error: { code: "AUTH_REQUIRED", retryable: false },
  });
});

test("rule (c): a probe network failure, or only unavailable activations plus denials, is a retryable NODE_UNREACHABLE", async () => {
  fake.probes = { A: present, B: unavailable };
  expect(await status({ names: ["A", "B"] })).toMatchObject({
    status: "error",
    error: { code: "NODE_UNREACHABLE", retryable: true },
  });

  fake.probes = { A: present, B: () => Promise.reject(new Error("socket hang up")) };
  expect(await status({ names: ["A", "B"] })).toMatchObject({
    status: "error",
    error: { code: "NODE_UNREACHABLE", retryable: true },
  });

  fake.skippedGrantReasons = ["activation_unavailable"];
  fake.probes = { A: forbidden, B: capability401 };
  expect(await status({ names: ["A", "B"] })).toMatchObject({
    status: "error",
    error: { code: "NODE_UNREACHABLE", retryable: true },
  });
});

test("rule (d), control: with no failed activation, a capability 401 is consent_required and nothing is saved", async () => {
  fake.skippedGrantReasons = ["expired"];
  fake.probes = { A: present, B: notFound, C: capability401 };
  expect(await status({ names: ["A", "B", "C"] })).toMatchObject({
    status: "ok",
    output: {
      status: "consent_required",
      owner: OWNER,
      present: ["A"],
      pending: ["B"],
      denied: ["C"],
      setup: { names: ["B"], owner: OWNER, action: "add_secret" },
    },
  });

  fake.probes = { C: forbidden };
  expect(await status({ names: ["C"] })).toMatchObject({
    status: "ok",
    output: { status: "consent_required", present: [], pending: [], denied: ["C"] },
  });
});

test("the owner comes from the live runtime summary, never the inspection summary", async () => {
  // Inspection reads the profile's recorded owner; the restored runtime reports another live identity.
  fake.inspection = delegateSummary;
  fake.summary = { ...delegateSummary, ownerDid: OTHER_OWNER };
  fake.probes = { A: present };

  expect(await status({ names: ["A"], owner: OTHER_OWNER })).toMatchObject({
    status: "ok",
    output: { status: "ready", owner: OTHER_OWNER },
  });
  expect(await status({ names: ["A"], owner: OWNER })).toMatchObject({
    status: "error",
    error: { code: "INPUT_INVALID", details: { reason: "OWNER_MISMATCH" } },
  });
});

test("rejects invalid names, scopes and owners before resolving a runtime", async () => {
  for (const input of [
    { names: [] },
    { names: ["lower"] },
    { names: Array.from({ length: 11 }, (_, index) => `N${index}`) },
    { names: ["A"], scope: "scoped" },
    { names: ["A"], scope: "default" },
    { names: ["A"], owner: "did:pkh:eip155:1:0xD559CCD9EB87C530A9A349262669386DE93CF412" },
    { names: ["A"], extra: true },
  ]) {
    expect(await status(input)).toMatchObject({ status: "error", error: { code: "INPUT_INVALID" } });
  }
  expect(requirements).toEqual([]);
});

/** The error of an error envelope; any other envelope fails the test. */
function errorOf(result: OperationResult<unknown>): OperationError {
  if (result.status !== "error") throw new Error(`expected an error envelope, got ${result.status}`);
  return result.error;
}

/** The output of an ok envelope; any other envelope fails the test. */
function outputOf(result: OperationResult<unknown>): unknown {
  if (result.status !== "ok") throw new Error(`expected an ok envelope, got ${result.status}`);
  return result.output;
}
