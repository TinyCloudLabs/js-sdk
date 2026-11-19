import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NamedKeyError } from "@tinycloud/node-sdk/encryption-keys";
import { registerKeysCommand, type KeysCommandDeps } from "./keys.js";
import { Command } from "commander";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const NETWORK_ID = `urn:tinycloud:encryption:${OWNER}:default`;

const state = {
  profile: { namedKeys: { prefix: "qa", resource: `${NETWORK_ID}/qa/` } as unknown, ownerDid: OWNER } as Record<string, unknown>,
  errors: [] as any[],
  outputs: [] as unknown[],
  stdout: [] as Uint8Array[],
  authCalls: 0,
  clientCalls: [] as string[],
  failWith: undefined as undefined | { code: string; status?: number },
  networkMissing: 0,
  networkCreated: 0,
  networkCreateFails: false,
  networkStaysMissing: false,
};

// A stand-in client: the envelope is a reversible xor of the plaintext, so the CLI's
// own file and stdout handling is what the round trip exercises.
const xor = (bytes: Uint8Array) => bytes.map((b) => b ^ 0x5a);
const stubClient = {
  ensureKey: async (path: string) => {
    state.clientCalls.push(`ensure ${path}`);
    if (state.networkMissing > 0) throw new NamedKeyError("NETWORK_NOT_FOUND", "no network");
    if (state.failWith) throw new NamedKeyError(state.failWith.code as ConstructorParameters<typeof NamedKeyError>[0], "failed", { status: state.failWith.status });
    return { networkId: NETWORK_ID, keyPath: path, alg: "a", keyVersion: 1, publicEncryptionKey: "AA==", state: "active", kind: "deterministic" };
  },
  encrypt: async (path: string, plaintext: Uint8Array) => {
    state.clientCalls.push(`encrypt ${path}`);
    if (state.networkMissing > 0) throw new NamedKeyError("NETWORK_NOT_FOUND", "no network");
    return { v: 2, networkId: NETWORK_ID, keyPath: path, alg: "a", keyVersion: 1, encryptedSymmetricKey: "AA==", encryptedSymmetricKeyHash: "00", ciphertext: Buffer.from(xor(plaintext)).toString("base64") };
  },
  decrypt: async (envelope: { keyPath: string; ciphertext: string }) => {
    state.clientCalls.push(`decrypt ${envelope.keyPath}`);
    if (state.failWith) throw new NamedKeyError(state.failWith.code as ConstructorParameters<typeof NamedKeyError>[0], "failed", { status: state.failWith.status });
    return xor(Buffer.from(envelope.ciphertext, "base64"));
  },
};

const deps = {
  resolveContext: async () => ({ profile: "keys-test", host: "https://host" }),
  getProfile: async () => state.profile,
  authenticate: async () => {
    state.authCalls += 1;
    return { ensureEncryptionNetwork: async () => {
      state.networkCreated += 1;
      if (state.networkCreateFails) throw new Error("create failed");
      if (!state.networkStaysMissing) state.networkMissing = 0;
    } };
  },
  createClient: () => stubClient,
  outputJson: (payload: unknown) => { state.outputs.push(payload); },
  handleError: (error: unknown) => { state.errors.push(error); },
} as unknown as KeysCommandDeps;

async function runKeys(args: string[]): Promise<void> {
  const program = new Command();
  registerKeysCommand(program, deps);
  await program.parseAsync(["node", "tc", "keys", ...args], { from: "node" });
}

let dir: string;
const realStdoutWrite = process.stdout.write;
afterEach(() => { process.stdout.write = realStdoutWrite; });
beforeEach(async () => {
  state.profile = { namedKeys: { prefix: "qa", resource: `${NETWORK_ID}/qa/` }, ownerDid: OWNER };
  state.errors = []; state.outputs = []; state.stdout = []; state.authCalls = 0; state.clientCalls = []; state.failWith = undefined; state.networkMissing = 0; state.networkCreated = 0; state.networkCreateFails = false; state.networkStaysMissing = false;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp("/var/tmp/tc2034-keys-unit-");
  process.stdout.write = ((chunk: unknown) => {
    state.stdout.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array));
    return true;
  }) as typeof process.stdout.write;
});

describe("tc keys", () => {
  test("ensure reports the key", async () => {
    await runKeys(["ensure", "qa/k1"]);
    expect(state.errors).toEqual([]);
    expect(state.outputs).toEqual([expect.objectContaining({ keyPath: "qa/k1", state: "active", kind: "deterministic" })]);
  });

  test("encrypt then decrypt round trip through files returns the original bytes", async () => {
    const plain = join(dir, "plain.bin");
    const envelope = join(dir, "env.json");
    const out = join(dir, "out.bin");
    const bytes = Uint8Array.from([0, 255, 1, 128, 7, 200]);
    await writeFile(plain, bytes);

    await runKeys(["encrypt", "qa/k1", "--in", plain, "--out", envelope]);
    expect(state.errors).toEqual([]);
    expect(JSON.parse(await readFile(envelope, "utf8"))).toMatchObject({ v: 2, keyPath: "qa/k1", networkId: NETWORK_ID });

    await runKeys(["decrypt", "--in", envelope, "--out", out]);
    expect(state.errors).toEqual([]);
    expect(new Uint8Array(await readFile(out))).toEqual(bytes);
  });

  test("encrypt writes the envelope JSON to stdout and decrypt writes raw bytes to stdout", async () => {
    const plain = join(dir, "plain.bin");
    const envelope = join(dir, "env.json");
    const bytes = Uint8Array.from([9, 0, 255]);
    await writeFile(plain, bytes);

    await runKeys(["encrypt", "qa/k1", "--in", plain]);
    const json = Buffer.concat(state.stdout).toString("utf8");
    expect(JSON.parse(json).keyPath).toBe("qa/k1");
    await writeFile(envelope, json);

    state.stdout = [];
    await runKeys(["decrypt", "--in", envelope]);
    expect(new Uint8Array(Buffer.concat(state.stdout))).toEqual(bytes);
  });

  test.each([["qa", "the prefix itself"], ["qax/k", "a sibling prefix"], ["other/k", "another prefix"]])(
    "ensure and encrypt refuse %s (%s) before authenticating, exit 5",
    async (path) => {
      await runKeys(["ensure", path]);
      await runKeys(["encrypt", path, "--in", join(dir, "none")]);
      expect(state.errors).toHaveLength(2);
      for (const error of state.errors) expect(error).toMatchObject({ code: "KEY_OUTSIDE_GRANTED_PREFIX", exitCode: 5 });
      expect(state.authCalls).toBe(0);
      expect(state.clientCalls).toEqual([]);
    },
  );

  test("decrypt refuses an envelope outside the granted prefix before authenticating, exit 5", async () => {
    const envelope = join(dir, "env.json");
    await writeFile(envelope, JSON.stringify({ v: 2, networkId: NETWORK_ID, keyPath: "other/k", ciphertext: "AA==" }));
    await runKeys(["decrypt", "--in", envelope]);
    expect(state.errors[0]).toMatchObject({ code: "KEY_OUTSIDE_GRANTED_PREFIX", exitCode: 5 });
    expect(state.authCalls).toBe(0);
  });

  test("decrypt refuses an envelope from another network before authenticating, exit 5", async () => {
    const envelope = join(dir, "env.json");
    await writeFile(envelope, JSON.stringify({ v: 2, networkId: "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000001:default", keyPath: "qa/k1", ciphertext: "AA==" }));
    await runKeys(["decrypt", "--in", envelope]);
    expect(state.errors[0]).toMatchObject({ exitCode: 5 });
    expect(state.authCalls).toBe(0);
  });

  test("a profile signed in without --keys is refused with exit 5", async () => {
    state.profile = { ownerDid: OWNER };
    await runKeys(["ensure", "qa/k1"]);
    expect(state.errors[0]).toMatchObject({ code: "KEYS_NOT_GRANTED", exitCode: 5 });
    expect(state.authCalls).toBe(0);
  });

  test("a non-envelope input is a usage error (exit 2)", async () => {
    const envelope = join(dir, "env.json");
    await writeFile(envelope, "not json");
    await runKeys(["decrypt", "--in", envelope]);
    expect(state.errors[0]).toMatchObject({ code: "INVALID_ENVELOPE", exitCode: 2 });
  });

  test("node 401/403 answers map to PERMISSION_DENIED (exit 5) and a missing key to NOT_FOUND (exit 4)", async () => {
    state.failWith = { code: "NODE_ERROR", status: 401 };
    await runKeys(["ensure", "qa/k1"]);
    state.failWith = { code: "KEY_NOT_FOUND" };
    await runKeys(["ensure", "qa/k1"]);
    expect(state.errors[0]).toMatchObject({ code: "PERMISSION_DENIED", exitCode: 5 });
    expect(state.errors[1]).toMatchObject({ code: "NOT_FOUND", exitCode: 4 });
  });

  test("ensure creates a missing encryption network once and retries once", async () => {
    state.networkMissing = 1;
    await runKeys(["ensure", "qa/k1"]);
    expect(state.errors).toEqual([]);
    expect(state.networkCreated).toBe(1);
    expect(state.clientCalls).toEqual(["ensure qa/k1", "ensure qa/k1"]);
    expect(state.outputs).toEqual([expect.objectContaining({ keyPath: "qa/k1" })]);
  });

  test("encrypt creates a missing encryption network once and retries once", async () => {
    state.networkMissing = 1;
    const plain = join(dir, "plain.bin");
    await writeFile(plain, Uint8Array.from([1, 2, 3]));
    await runKeys(["encrypt", "qa/k1", "--in", plain, "--out", join(dir, "env.json")]);
    expect(state.errors).toEqual([]);
    expect(state.networkCreated).toBe(1);
    expect(state.clientCalls).toEqual(["encrypt qa/k1", "encrypt qa/k1"]);
  });

  test("a network that is still missing after one setup is reported, not retried again", async () => {
    state.networkMissing = 1;
    state.networkStaysMissing = true;
    await runKeys(["ensure", "qa/k1"]);
    expect(state.networkCreated).toBe(1);
    expect(state.clientCalls).toHaveLength(2);
    expect(state.errors).toHaveLength(1);
  });

  test("a failing network setup is reported and not retried", async () => {
    state.networkMissing = 1;
    state.networkCreateFails = true;
    await runKeys(["ensure", "qa/k1"]);
    expect(state.networkCreated).toBe(1);
    expect(state.clientCalls).toEqual(["ensure qa/k1"]);
    expect(state.errors).toHaveLength(1);
  });
});
