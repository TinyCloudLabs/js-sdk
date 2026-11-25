import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { Command } from "commander";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ExitCode } from "../config/constants.js";

// TC-4248: an owner `secrets migrate` of many secrets asks for their keys in as many approvals as the activation
// origin's header limit needs: one at a 256k ingress, several at 32k, one after another before anything moves, each
// naming exact keys only. The plan is reported on every owner run, dry runs included.

const NETWORK_ID = "urn:tinycloud:encryption:did:pkh:eip155:1:0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf:default";
const KEYS = Array.from({ length: 140 }, (_, i) => i % 3 === 0
  ? `secrets/scoped/app-${i % 7}/service_api_key_${i}`
  : `secrets/openai_project_api_key_number_${i}`);
const COMBINED = "Create a key for each of your older-format secrets and encrypt the secret with it. This needs access to all your encrypted data, because only that access can read the older format.";
/** Request 1's first two entries: write on every secret and decrypt with the network (TC-4246). */
const WRITE_AND_NETWORK: PermissionEntry[] = [
  {
    service: "tinycloud.kv", space: "secrets", path: "vault/secrets/", skipPrefix: true,
    actions: ["tinycloud.kv/list", "tinycloud.kv/get", "tinycloud.kv/put"],
  },
  { service: "tinycloud.encryption", path: NETWORK_ID, skipPrefix: true, actions: ["tinycloud.encryption/decrypt"] },
];
let approvals: { requested: PermissionEntry[]; reason: string }[] = [];
let outputs: Record<string, unknown>[] = [];
let errors: unknown[] = [];
let stderr: string[] = [];
let ingressLimit = 0;
/** The 1-based number of the key approval the owner declines (approval 0 is the read one); 0: none. */
let declineKeyApproval = 0;
const HELD_UNTIL = new Date(2026, 10, 24, 14, 41);
let checkedOrigins: string[] = [];

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

// The registry routes the network to its own encryption origin; that origin is the one checked.
const node = {
  getEncryptionNetworkIdForSpace: () => NETWORK_ID,
  secrets: {},
  resolveRegisteredDelegationHost: async () => "https://enc.tinycloud.test",
  getRuntimePermissionDelegations: () => [{ expiry: HELD_UNTIL }],
};
// Imported after mock.module so the command under test loads the mocks (as secrets-migrate.approvals.test.ts).
const realSdk = await import("../lib/sdk.js");
mock.module("../lib/sdk.js", () => ({ ...realSdk, ensureAuthenticated: async () => node }));

const realAuth = await import("./auth.js");
mock.module("./auth.js", () => ({
  ...realAuth,
  ensureDelegationAuthority: async (params: { requested: PermissionEntry[]; reason: string }) => {
    if (declineKeyApproval > 0 && approvals.length === declineKeyApproval) {
      throw new realErrors.CLIError("CANCELLED", "Interrupted before approval.", ExitCode.CANCELLED);
    }
    approvals.push({ requested: params.requested, reason: params.reason });
  },
}));

let moved = 0;
mock.module("@tinycloud/sdk-services/secrets/migrate", () => ({
  migrateSecrets: async (_secrets: unknown, options: {
    dryRun?: boolean;
    authorizeKeys?: (keyPaths: readonly string[]) => Promise<void>;
    previewKeys?: (keyPaths: readonly string[]) => Promise<void>;
  }) => {
    if (options.dryRun) await options.previewKeys?.(KEYS);
    else await options.authorizeKeys?.(KEYS);
    moved = options.dryRun ? 0 : KEYS.length;
    return { ok: true, data: { dryRun: options.dryRun === true, total: KEYS.length, moved: KEYS.length, already: 0, staysOnNetwork: 0, skipped: {} } };
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
mock.module("../output/errors.js", () => ({ ...realErrors, handleError: (error: unknown) => { errors.push(error); } }));

const { registerSecretsCommand } = await import("./secrets.js");

const realFetch = globalThis.fetch;
const realWrite = process.stderr.write.bind(process.stderr);
globalThis.fetch = (async (url: URL, init: RequestInit) => {
  checkedOrigins.push(new URL(url).origin);
  const bytes = Math.max(...Object.values(init.headers as Record<string, string>).map((value) => value.length));
  return bytes <= ingressLimit
    ? new Response("{}", { status: 200 })
    : new Response("<title>400 Request Header Or Cookie Too Large</title>", { status: 400 });
}) as unknown as typeof fetch;
process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
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

const keyApprovals = () => approvals.slice(1);
const keyPathsOf = (requested: PermissionEntry[]) => requested.map((entry) => entry.path.slice(NETWORK_ID.length + 1));

beforeEach(() => {
  approvals = [];
  outputs = [];
  errors = [];
  stderr = [];
  checkedOrigins = [];
  moved = 0;
  declineKeyApproval = 0;
});

test("at a 256k ingress, 140 keys are one key approval with today's reason", async () => {
  ingressLimit = 256 * 1024 - 17;

  await migrate();

  expect(errors).toEqual([]);
  expect(keyApprovals()).toHaveLength(1);
  expect(keyApprovals()[0]!.reason).toBe(COMBINED);
  expect(keyApprovals()[0]!.requested.slice(0, 2)).toEqual(WRITE_AND_NETWORK);
  expect(keyPathsOf(keyApprovals()[0]!.requested.slice(2))).toEqual([...KEYS].sort());
  expect(outputs[0]!.keyApprovals).toEqual({ requests: 1, budgetBytes: 183_488, budgetSource: "measured" });
  expect(checkedOrigins).toEqual(["https://enc.tinycloud.test"]);
  expect(stderr).toContain("Key approvals: 1 (each up to 183,488 bytes, measured on this node).\n");
});

test("at a 32k ingress, the keys are split into numbered exact-key approvals asked back to back", async () => {
  ingressLimit = 32_751;

  await migrate();

  expect(errors).toEqual([]);
  const asked = keyApprovals();
  expect(asked.length).toBeGreaterThan(1);
  expect(asked.map((approval) => approval.reason)).toEqual(asked.map((_, i) => i === 0
    ? `Create a key for each of your older-format secrets and encrypt the secret with it (approval 1 of ${asked.length}). This needs access to all your encrypted data, because only that access can read the older format.`
    : `Create a key for each secret being moved and encrypt the secret with it (approval ${i + 1} of ${asked.length}). This reaches only those secrets, not the rest of your encrypted data.`));
  expect(asked[0]!.requested.slice(0, 2)).toEqual(WRITE_AND_NETWORK);
  const keyEntries = asked.map((approval, i) => (i === 0 ? approval.requested.slice(2) : approval.requested));
  expect(keyEntries.flatMap((requested) => keyPathsOf(requested))).toEqual([...KEYS].sort());
  for (const requested of keyEntries) {
    for (const entry of requested) {
      expect(entry).toEqual({
        service: "tinycloud.encryption", path: `${NETWORK_ID}/${keyPathsOf([entry])[0]}`, skipPrefix: true,
        actions: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"],
      });
    }
  }
  expect(outputs[0]!.keyApprovals).toEqual({ requests: asked.length, budgetBytes: 22_925, budgetSource: "fallback" });
  expect(checkedOrigins).toEqual(Array(3).fill("https://enc.tinycloud.test"));
  expect(stderr).toContain(`Key approvals: ${asked.length} (each up to 22,925 bytes, safe default; this node's limit was not measured).\n`);
});

test("a dry run reports the plan and asks for no key", async () => {
  ingressLimit = 256 * 1024 - 17;

  await migrate("--dry-run");

  expect(errors).toEqual([]);
  expect(approvals).toHaveLength(1);
  expect(outputs[0]!.keyApprovals).toEqual({ requests: 1, budgetBytes: 183_488, budgetSource: "measured" });
  expect(moved).toBe(0);
});

for (const [declined, held] of [
  [2, "Approval 1 stays valid until 2:41 PM."],
  [3, "Approvals 1 to 2 stay valid until 2:41 PM."],
] as const) {
  test(`a split move whose key approval ${declined} is declined moves nothing and says which key approvals stay held`, async () => {
    ingressLimit = 32_751;
    declineKeyApproval = declined;

    await migrate();

    expect(moved).toBe(0);
    expect(outputs).toEqual([]);
    expect(keyApprovals()).toHaveLength(declined - 1);
    const [error] = errors as { code: string; exitCode: number; message: string }[];
    const n = Number(/ of (\d+) was declined/.exec(error!.message)?.[1]);
    expect(n).toBeGreaterThan(declined);
    expect({ code: error!.code, exitCode: error!.exitCode, message: error!.message }).toEqual({
      code: "CANCELLED",
      exitCode: ExitCode.CANCELLED,
      message: `Approval ${declined} of ${n} was declined, so no secret was moved. ${held} To move the secrets, run \`tc secrets migrate\`.`,
    });
  });
}

test("a move asked in one key approval keeps today's error when it is declined", async () => {
  ingressLimit = 256 * 1024 - 17;
  declineKeyApproval = 1;

  await migrate();

  expect(moved).toBe(0);
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toBe("Interrupted before approval.");
});
