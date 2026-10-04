import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { profileConfigPath, profilePath, sessionPath, writeJsonAtomic } from "@tinycloud/operations/state";

// Real modules end to end: the child process runs the secrets command from
// source against a stored session that is a real owner-signed SIWE whose
// expiry has passed. The node is a local server that records every request.
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";
const entry = join(import.meta.dir, "../../test-support/secrets-json-error.ts");
const requests: string[] = [];
let node: Server<undefined>;

beforeAll(() => {
  node = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response("{}", { status: 500 });
    },
  });
});

afterAll(() => {
  node.stop(true);
});

/** A profile whose stored session is owner-signed and expired an hour ago. */
async function seedExpiredProfile(home: string, posture: "delegate-session" | "local-owner-key"): Promise<void> {
  const previousHome = process.env.TC_HOME;
  process.env.TC_HOME = home;
  try {
    const wasm = new NodeWasmBindings();
    const signer = new PrivateKeySigner(OWNER_KEY);
    const address = await signer.getAddress();
    const ownerDid = `did:pkh:eip155:1:${address}`;
    const spaceId = wasm.makeSpaceId(address, 1, "secrets");
    const manager = wasm.createSessionManager();
    const jwk = JSON.parse(manager.jwk("default")!);
    const sessionDid = manager.getDID("default");
    const expiresAt = new Date(Date.now() - 3_600_000).toISOString();
    const prepared = wasm.prepareSession({
      abilities: {
        capabilities: { "": ["tinycloud.capabilities/read"] },
        kv: { "vault/secrets/": ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/del"] },
      },
      rawAbilities: { [`urn:tinycloud:encryption:${ownerDid}:default`]: ["tinycloud.encryption/decrypt"] },
      address, chainId: 1, domain: "cli.example.test", spaceId, jwk,
      issuedAt: new Date(Date.now() - 7_200_000).toISOString(),
      expirationTime: expiresAt,
    });
    const signature = await signer.signMessage(prepared.siwe);
    await writeJsonAtomic(profileConfigPath("expired"), {
      name: "expired",
      host: node.url.origin,
      chainId: 1,
      spaceName: "secrets",
      did: posture === "local-owner-key" ? ownerDid : sessionDid,
      sessionDid,
      ownerDid,
      spaceId,
      posture,
      ...(posture === "local-owner-key"
        ? { authMethod: "local", privateKey: OWNER_KEY, operatorType: "human" }
        : { authMethod: "openkey", operatorType: "agent" }),
      createdAt: "2026-07-14T12:00:00.000Z",
    });
    await writeJsonAtomic(join(profilePath("expired"), "key.json"), jwk);
    await writeJsonAtomic(sessionPath("expired"), {
      ...wasm.completeSessionSetup({ ...prepared, signature }),
      jwk, address, chainId: 1, spaceId, verificationMethod: sessionDid,
      siwe: prepared.siwe, signature, ownerDid, expiresAt,
    });
  } finally {
    if (previousHome === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = previousHome;
  }
}

async function runSecrets(home: string, args: string[]): Promise<{ exitCode: number; error: Record<string, unknown> }> {
  const child = Bun.spawn([process.execPath, entry, "--profile", "expired", "--json", "secrets", ...args], {
    env: { ...process.env, HOME: home, TC_HOME: home, TC_HOST: "", TC_PRIVATE_KEY: "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { exitCode, error: (JSON.parse(stderr) as { error: Record<string, unknown> }).error };
}

describe("an expired stored session needs a new sign-in, not a retry", () => {
  const delegateLogin = {
    code: "AUTH_REQUIRED",
    message: 'The session for profile "expired" has expired or is no longer valid.',
    hint: expect.stringContaining("tc --profile expired auth login --method openkey --paste --manifest"),
  };
  const localLogin = {
    code: "AUTH_REQUIRED",
    hint: "Sign in again with: tc --profile expired auth login --method local",
  };
  const cases: Array<[string, "delegate-session" | "local-owner-key", string[], Record<string, unknown>]> = [
    ["delegate-session secrets get", "delegate-session", ["get", "KEY"], delegateLogin],
    ["delegate-session secrets list", "delegate-session", ["list"], delegateLogin],
    ["delegate-session secrets put", "delegate-session", ["put", "KEY", "value"], delegateLogin],
    ["delegate-session secrets delete", "delegate-session", ["delete", "KEY"], delegateLogin],
    ["local-owner-key secrets get", "local-owner-key", ["get", "KEY"], localLogin],
    ["local-owner-key secrets list", "local-owner-key", ["list"], localLogin],
  ];

  test.each(cases)("%s exits 3 with AUTH_REQUIRED before reaching the node", async (_label, posture, args, expected) => {
    const home = await mkdtemp(join(tmpdir(), "tc-expired-session-"));
    try {
      await seedExpiredProfile(home, posture);
      requests.length = 0;
      const { exitCode, error } = await runSecrets(home, args);
      expect({ exitCode, error }).toMatchObject({ exitCode: 3, error: expected });
      expect(requests).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
