import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";

// Owner-signed SIWE sessions expired an hour ago (or tampered but within
// their lifetime) exercise the built public CLI against a recording node.

// Share modules read the profile store at import, so the in-process share case
// gets its own home before they load.
const shareHome = await mkdtemp(join(tmpdir(), "tc-expired-share-"));
const originalTcHome = process.env.TC_HOME;
process.env.TC_HOME = shareHome;
const { profileConfigPath, profilePath, sessionPath, writeJsonAtomic } = await import("@tinycloud/operations/state");
const { createShareAuthorityAdapters } = await import("../share/adapters.js");
const { shareCliError } = await import("./share.js");

const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";
const cliEntry = join(import.meta.dir, "../../bin/tc");
const requests: string[] = [];
let node: Server<undefined>;

type Posture = "delegate-session" | "local-owner-key" | "owner-openkey";

beforeAll(() => {
  node = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response("{}", { status: 500 });
    },
  });
});

afterAll(async () => {
  node.stop(true);
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(shareHome, { recursive: true, force: true });
});

/** A profile whose stored session is owner-signed and either expired or tampered. */
async function seedProfile(home: string, posture: Posture, state: "expired" | "tampered" = "expired"): Promise<void> {
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
    const expiresAt = new Date(Date.now() + (state === "expired" ? -3_600_000 : 3_600_000)).toISOString();
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
    const signed = await signer.signMessage(prepared.siwe);
    // Flipping the recovery byte keeps the signature well-formed but makes it verify for no owner.
    const signature = state === "tampered" ? `${signed.slice(0, -2)}${signed.endsWith("1b") ? "1c" : "1b"}` : signed;
    await writeJsonAtomic(profileConfigPath("expired"), {
      name: "expired",
      host: node.url.origin,
      chainId: 1,
      spaceName: "secrets",
      did: posture === "delegate-session" ? sessionDid : ownerDid,
      sessionDid,
      ownerDid,
      spaceId,
      posture,
      ...(posture === "local-owner-key"
        ? { authMethod: "local", privateKey: OWNER_KEY, operatorType: "human" }
        : { authMethod: "openkey", operatorType: posture === "delegate-session" ? "agent" : "human" }),
      createdAt: "2026-07-14T12:00:00.000Z",
    });
    await writeJsonAtomic(join(profilePath("expired"), "key.json"), jwk);
    await writeJsonAtomic(sessionPath("expired"), {
      ...wasm.completeSessionSetup({ ...prepared, signature: signed }),
      jwk, address, chainId: 1, spaceId, verificationMethod: sessionDid,
      siwe: prepared.siwe, signature, ownerDid, expiresAt,
    });
  } finally {
    if (previousHome === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = previousHome;
  }
}

async function run(home: string, argv: readonly string[]): Promise<{ exitCode: number; error: Record<string, unknown> }> {
  // No TC_HOST: commands must resolve the profile's host (the recording server).
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  const child = Bun.spawn([process.env.NODE_BINARY ?? "node", ...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { exitCode, error: (JSON.parse(stderr) as { error: Record<string, unknown> }).error };
}

const delegateLogin = {
  code: "AUTH_REQUIRED",
  hint: expect.stringContaining("tc --profile expired auth login --method openkey --paste --manifest"),
};
const localLogin = {
  code: "AUTH_REQUIRED",
  hint: "Sign in again with: tc --profile expired auth login --method local",
};
const ownerLogin = {
  code: "AUTH_REQUIRED",
  hint: "Sign in again with: tc --profile expired auth login --method openkey",
};
const scopedOwnerLogin = {
  code: "AUTH_REQUIRED",
  hint: expect.stringContaining("tc --profile expired auth login --method openkey --paste --manifest"),
};

describe("an expired or invalid stored session needs a new sign-in, not a retry", () => {
  const secrets = (...args: string[]) => [cliEntry, "--profile", "expired", "--json", "secrets", ...args];
  const cases: Array<[string, Posture, "expired" | "tampered", string[], Record<string, unknown>]> = [
    ["delegate-session secrets get", "delegate-session", "expired", secrets("get", "KEY"), delegateLogin],
    ["delegate-session secrets list", "delegate-session", "expired", secrets("list"), delegateLogin],
    ["delegate-session secrets put", "delegate-session", "expired", secrets("put", "KEY", "value"), delegateLogin],
    ["delegate-session secrets delete", "delegate-session", "expired", secrets("delete", "KEY"), delegateLogin],
    ["local-owner-key secrets get", "local-owner-key", "expired", secrets("get", "KEY"), localLogin],
    ["local-owner-key secrets list", "local-owner-key", "expired", secrets("list"), localLogin],
    ["local-owner-key secrets put", "local-owner-key", "expired", secrets("put", "KEY", "value"), localLogin],
    ["local-owner-key secrets delete", "local-owner-key", "expired", secrets("delete", "KEY"), localLogin],
    ["owner-openkey secrets get", "owner-openkey", "expired", secrets("get", "KEY"), scopedOwnerLogin],
    ["owner-openkey secrets list", "owner-openkey", "expired", secrets("list"), scopedOwnerLogin],
    ["owner-openkey secrets put", "owner-openkey", "expired", secrets("put", "KEY", "value"), scopedOwnerLogin],
    ["owner-openkey secrets delete", "owner-openkey", "expired", secrets("delete", "KEY"), scopedOwnerLogin],
    // Within its lifetime, so the secrets expiry pre-check passes; the owner still gets the owner sign-in.
    ["owner-openkey secrets get with a session that no longer verifies", "owner-openkey", "tampered", secrets("get", "KEY"), ownerLogin],
  ];

  test.each(cases)("%s exits 3 with AUTH_REQUIRED before reaching the node", async (_label, posture, state, argv, expected) => {
    const home = await mkdtemp(join(tmpdir(), "tc-expired-session-"));
    try {
      await seedProfile(home, posture, state);
      requests.length = 0;
      const { exitCode, error } = await run(home, argv);
      expect({ exitCode, error }).toMatchObject({ exitCode: 3, error: expected });
      expect(requests).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  test.each([
    ["delegate-session", delegateLogin],
    ["local-owner-key", localLogin],
    ["owner-openkey", ownerLogin],
  ] as const)("%s rejects expired sessions for kv get, auth import and share publish through the public CLI", async (posture, expected) => {
    const home = await mkdtemp(join(tmpdir(), "tc-expired-public-"));
    try {
      await seedProfile(home, posture);
      const artifact = join(home, "delegation.json");
      const source = join(home, "share.txt");
      await writeFile(source, "hello");
      await writeFile(artifact, JSON.stringify({
        kind: "tinycloud.auth.delegation",
        version: 1,
        requestId: "req-expired-session",
        delegation: {
          cid: "bafyexpiredsession",
          spaceId: "secrets",
          path: "vault/secrets/KEY",
          actions: ["tinycloud.kv/get"],
          delegateDID: "did:key:z6MkExpiredSession",
          ownerAddress: "0x0000000000000000000000000000000000000001",
          chainId: 1,
          expiry: new Date(Date.now() + 3_600_000).toISOString(),
          delegationHeader: { Authorization: "header.payload.signature" },
        },
      }));
      for (const [argv, expectedError] of [
        [[cliEntry, "--json", "--profile", "expired", "kv", "get", "KEY"], expected],
        [[cliEntry, "--json", "--profile", "expired", "auth", "import", artifact], expected],
        [[cliEntry, "--json", "--profile", "expired", "share", "publish", source], { code: "AUTH_REQUIRED" }],
      ] as const) {
        requests.length = 0;
        const { exitCode, error } = await run(home, argv);
        expect({ exitCode, error }).toMatchObject({ exitCode: 3, error: expectedError });
        expect(requests).toEqual([]);
        if (argv.includes("publish")) {
          expect(JSON.stringify(error)).toContain(posture === "local-owner-key" ? "auth login --method local" : "builtin:share-publishing");
        }
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("share publish keeps its share-publishing sign-in guidance", async () => {
    await seedProfile(shareHome, "delegate-session");
    const shareOrigin = "https://share.example.test";
    const shareRequests: string[] = [];
    const fetchFn = Object.assign(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      shareRequests.push(url.pathname);
      if (url.pathname === "/.well-known/tinycloud-share/config.json") {
        return Response.json({ version: "tinycloud.share/config-v2", shareOrigin, registryOrigin: shareOrigin, credentialsOrigin: shareOrigin });
      }
      return Response.json({});
    }, { preconnect: () => undefined }) as typeof globalThis.fetch;
    const { targetAdapter } = createShareAuthorityAdapters({
      origin: shareOrigin, nodeOrigin: node.url.origin, profileName: async () => "expired", fetchFn,
    });
    requests.length = 0;
    const failure = await targetAdapter.publish({
      source: new TextEncoder().encode("hello"), filename: "hello.txt", mediaType: "text/plain",
      target: { kind: "bearer" }, expiresAt: new Date(Date.now() + 600_000), origin: shareOrigin,
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ failure: { kind: "owner-space-unresolved", profileName: "expired" } });
    expect(shareCliError(failure)).toMatchObject({
      code: "AUTH_REQUIRED",
      exitCode: 3,
      message: expect.stringContaining("tc --profile expired auth login --device --manifest builtin:share-publishing"),
    });
    expect(requests).toEqual([]);
    expect(shareRequests).not.toContain("/invoke");
  });
});
