import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ExitCode } from "../config/constants.js";

// TC-4246: an owner `secrets migrate` lists and classifies with read access only (none asked when the sign-in holds
// it), then asks ONE approval to move: write on every secret, decrypt with the network and each pending secret's own
// key, for one hour. It splits only when the request would not fit the node's header limit. The real migrateSecrets
// runs against a fake vault, so a rerun after a stop asks for exactly the rest.

const OWNER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const NETWORK_ID = `urn:tinycloud:encryption:did:pkh:eip155:1:${OWNER}:default`;
const KV = "tinycloud.kv";
const READ = ["tinycloud.kv/list", "tinycloud.kv/get"];
const WRITE = [...READ, "tinycloud.kv/put"];
const KEY_ACTIONS = ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"];
const ONE_HOUR_MS = 3_600_000;

/** 140 v1 secrets, global and scoped, plus 4 records only the old DataVault shape reads (read_failed). */
const SECRETS = [
  ...Array.from({ length: 140 }, (_, i) => i % 3 === 0
    ? { name: `SERVICE_API_KEY_${i}`, scope: `app-${i % 7}` }
    : { name: `OPENAI_PROJECT_API_KEY_NUMBER_${i}` }),
  ...Array.from({ length: 4 }, (_, i) => ({ name: `LEGACY_RECORD_${i}` })),
];
const keyPathOf = (secret: { name: string; scope?: string }) => secret.scope === undefined
  ? `secrets/${secret.name.toLowerCase()}`
  : `secrets/scoped/${secret.scope}/${secret.name.toLowerCase()}`;
const LEGACY = new Set(SECRETS.slice(140).map(keyPathOf));

/** Key paths already on their own key. A real reseal moves one; a stop after `stopAfter` reseals ends the run. */
let moved = new Set<string>();
let stopAfter = Infinity;
let reseals = 0;
let prompts: { requested: PermissionEntry[]; reason: string; expiryOption: unknown }[] = [];
/** What the sign-in session already holds: read on every secret, or nothing. */
let signInHoldsRead = true;
let ingressLimit = 256 * 1024 - 17;
let declinePrompt = 0;
let outputs: Record<string, unknown>[] = [];
let errors: unknown[] = [];

const vault = {
  resealToKey: async (_vaultKey: string, keyPath: string, options: { dryRun: boolean }) => {
    if (LEGACY.has(keyPath)) return { status: "skipped", reason: "read_failed" };
    if (moved.has(keyPath)) return { status: "already" };
    if (options.dryRun) return { status: "pending" };
    if (reseals >= stopAfter) throw new Error("stopped part way");
    reseals += 1;
    moved.add(keyPath);
    return { status: "moved" };
  },
};

const sameEntry = (a: PermissionEntry, b: PermissionEntry) => a.service === b.service && a.path === b.path &&
  b.actions.every((action) => a.actions.includes(action));
const node = {
  getEncryptionNetworkIdForSpace: () => NETWORK_ID,
  secrets: { vault, listAll: async () => ({ ok: true, data: SECRETS }) },
  resolveRegisteredDelegationHost: async () => "https://enc.tinycloud.test",
  getRuntimePermissionDelegations: () => [{ expiry: new Date(Date.now() + ONE_HOUR_MS) }],
  // The sign-in covers read on every secret when `signInHoldsRead`; approvals granted in this run cover theirs.
  hasRuntimePermissions: (requested: PermissionEntry[]) => requested.every((entry) =>
    (signInHoldsRead && entry.service === KV && entry.actions.every((action) => READ.includes(action))) ||
    prompts.some((prompt) => prompt.requested.some((held) => sameEntry(held, entry)))),
};

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

// Imported after mock.module so the command under test loads the mocks (as secrets-migrate.approvals.test.ts).
const realSdk = await import("../lib/sdk.js");
mock.module("../lib/sdk.js", () => ({ ...realSdk, ensureAuthenticated: async () => node }));

const realErrors = await import("../output/errors.js");
const realAuth = await import("./auth.js");
// As the real one: nothing is asked when the session already covers the request; otherwise one owner screen.
mock.module("./auth.js", () => ({
  ...realAuth,
  ensureDelegationAuthority: async (params: { node: typeof node; requested: PermissionEntry[]; reason: string; expiryOption: unknown }) => {
    if (params.node.hasRuntimePermissions(params.requested)) return;
    if (declinePrompt > 0 && prompts.length + 1 === declinePrompt) {
      throw new realErrors.CLIError("CANCELLED", "Interrupted before approval.", ExitCode.CANCELLED);
    }
    prompts.push({ requested: params.requested, reason: params.reason, expiryOption: params.expiryOption });
  },
}));

const realFormatter = await import("../output/formatter.js");
mock.module("../output/formatter.js", () => ({
  ...realFormatter,
  outputJson: (payload: Record<string, unknown>) => { outputs.push(payload); },
  shouldOutputJson: () => true,
  withSpinner: async (_label: string, fn: () => unknown) => await fn(),
}));
mock.module("../output/errors.js", () => ({ ...realErrors, handleError: (error: unknown) => { errors.push(error); } }));

const { registerSecretsCommand } = await import("./secrets.js");

const realFetch = globalThis.fetch;
const realWrite = process.stderr.write.bind(process.stderr);
globalThis.fetch = (async (_url: URL, init: RequestInit) => {
  const bytes = Math.max(...Object.values(init.headers as Record<string, string>).map((value) => value.length));
  return bytes <= ingressLimit
    ? new Response("{}", { status: 200 })
    : new Response("<title>400 Request Header Or Cookie Too Large</title>", { status: 400 });
}) as unknown as typeof fetch;
process.stderr.write = (() => true) as typeof process.stderr.write;
afterAll(() => {
  globalThis.fetch = realFetch;
  process.stderr.write = realWrite;
});

async function migrate(...args: string[]): Promise<void> {
  const program = new Command();
  program.option("-p, --profile <name>").option("--json");
  registerSecretsCommand(program);
  await program.parseAsync(["node", "tc", "secrets", "migrate", ...args], { from: "node" });
}

const keyEntry = (keyPath: string): PermissionEntry => ({
  service: "tinycloud.encryption", path: `${NETWORK_ID}/${keyPath}`, actions: KEY_ACTIONS, skipPrefix: true,
});
const kvEntry = (actions: string[]): PermissionEntry => ({ service: KV, space: "secrets", path: "vault/secrets/", actions, skipPrefix: true });
const networkEntry: PermissionEntry = { service: "tinycloud.encryption", path: NETWORK_ID, actions: ["tinycloud.encryption/decrypt"], skipPrefix: true };
const pendingKeys = () => SECRETS.slice(0, 140).map(keyPathOf).filter((keyPath) => !moved.has(keyPath)).sort();

beforeEach(() => {
  moved = new Set();
  stopAfter = Infinity;
  reseals = 0;
  prompts = [];
  signInHoldsRead = true;
  ingressLimit = 256 * 1024 - 17;
  declinePrompt = 0;
  outputs = [];
  errors = [];
});

test("with read in the sign-in, a 140-secret move is one owner approval: write, network decrypt and each key, for 1 hour", async () => {
  const keys = pendingKeys();

  await migrate();

  expect(errors).toEqual([]);
  expect(prompts).toHaveLength(1);
  // No wider than the old approval 1 (list, read, write and network decrypt) together with the key approval.
  expect(prompts[0]!.requested).toEqual([kvEntry(WRITE), networkEntry, ...keys.map(keyEntry)]);
  expect(prompts[0]!.expiryOption).toBe(ONE_HOUR_MS);
  expect(prompts[0]!.reason).toBe("Create a key for each of your older-format secrets and move the secret onto it. This needs access to all your encrypted data, because only that access can read the older format.");
  expect(outputs).toEqual([expect.objectContaining({
    moved: 140, already: 0, skipped: { read_failed: 4 },
    keyApprovals: { requests: 1, budgetBytes: 183_488, budgetSource: "measured" },
  })]);
});

test("without read in the sign-in, the list is asked for first and the move is still one approval", async () => {
  signInHoldsRead = false;

  await migrate();

  expect(errors).toEqual([]);
  expect(prompts.map((prompt) => prompt.requested.length)).toEqual([1, 142]);
  expect(prompts[0]!.requested).toEqual([kvEntry(READ)]);
  expect(outputs[0]).toMatchObject({ moved: 140 });
});

test("a run stopped part way is rerun with one approval naming exactly the secrets left", async () => {
  stopAfter = 60;
  await migrate();
  expect(errors).toHaveLength(1);
  expect(moved.size).toBe(60);

  const left = pendingKeys();
  prompts = [];
  errors = [];
  stopAfter = Infinity;
  await migrate();

  expect(errors).toEqual([]);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]!.requested).toEqual([kvEntry(WRITE), networkEntry, ...left.map(keyEntry)]);
  expect(outputs).toEqual([expect.objectContaining({ moved: 80, already: 60, skipped: { read_failed: 4 } })]);
});

test("with nothing left to move, nothing beyond read is asked", async () => {
  for (const keyPath of pendingKeys()) moved.add(keyPath);

  await migrate();

  expect(errors).toEqual([]);
  expect(prompts).toEqual([]);
  expect(outputs).toEqual([expect.objectContaining({ moved: 0, already: 140, skipped: { read_failed: 4 } })]);
});

test("a dry run asks for read only and plans the same one approval", async () => {
  signInHoldsRead = false;

  await migrate("--dry-run");

  expect(errors).toEqual([]);
  expect(prompts.map((prompt) => prompt.requested)).toEqual([[kvEntry(READ)]]);
  expect(outputs).toEqual([expect.objectContaining({
    dryRun: true, moved: 140, skipped: { read_failed: 4 }, keyApprovals: { requests: 1, budgetBytes: 183_488, budgetSource: "measured" },
  })]);
  expect(moved.size).toBe(0);
});

test("at a 32k ingress, the first approval carries write and network decrypt with its keys, the rest keys only", async () => {
  ingressLimit = 32_751;

  await migrate();

  expect(errors).toEqual([]);
  expect(prompts.length).toBeGreaterThan(1);
  const [first, ...rest] = prompts;
  expect(first!.requested.slice(0, 2)).toEqual([kvEntry(WRITE), networkEntry]);
  // Every other entry, in every approval, is one exact key with decrypt and key creation: never a prefix.
  const keyEntries = [...first!.requested.slice(2), ...rest.flatMap((prompt) => prompt.requested)];
  expect(keyEntries.map((entry) => keyEntry(entry.path.slice(NETWORK_ID.length + 1)))).toEqual(keyEntries);
  expect(keyEntries.map((entry) => entry.path))
    .toEqual(SECRETS.slice(0, 140).map(keyPathOf).sort().map((keyPath) => `${NETWORK_ID}/${keyPath}`));
  expect(prompts.every((prompt) => prompt.expiryOption === ONE_HOUR_MS)).toBe(true);
  expect(prompts.map((prompt) => prompt.reason)).toEqual(prompts.map((_, i) => i === 0
    ? `Create a key for each of your older-format secrets and move the secret onto it (approval 1 of ${prompts.length}). This needs access to all your encrypted data, because only that access can read the older format.`
    : `Create a key for each secret being moved and move the secret onto it (approval ${i + 1} of ${prompts.length}). This reaches only those secrets, not the rest of your encrypted data.`));
  expect(outputs[0]).toMatchObject({ moved: 140, keyApprovals: { requests: prompts.length, budgetBytes: 22_925, budgetSource: "fallback" } });
});

test("declining the second approval of a split move moves nothing and says the first stays held", async () => {
  ingressLimit = 32_751;
  declinePrompt = 2;

  await migrate();

  expect(moved.size).toBe(0);
  expect(outputs).toEqual([]);
  const [error] = errors as { code: string; message: string }[];
  expect(error!.code).toBe("CANCELLED");
  expect(error!.message).toMatch(/^Approval 2 of \d+ was declined, so no secret was moved\. Approval 1 stays valid until .+\. To move the secrets, run `tc secrets migrate`\.$/);
});
