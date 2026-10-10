import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PortableDelegation } from "@tinycloud/node-sdk";
import { pathToFileURL } from "node:url";
const { mintCompactDelegation } = await import(new URL("../../../node-sdk/src/test-support/compact-delegation.ts", import.meta.url).href) as {
  mintCompactDelegation(options: { audience: string; expSecs: number; host?: string }): Promise<{
    delegation: PortableDelegation;
    ownerDid: string;
    spaceId: string;
  }>;
};

// Owner-signed SIWE sessions expired an hour ago (or tampered but within
// their lifetime) exercise the built public CLI against a recording node.

// Share modules read the profile store at import, so the in-process share case
// gets its own home before they load.
const shareHome = await mkdtemp(join(tmpdir(), "tc-expired-share-"));
const originalTcHome = process.env.TC_HOME;
process.env.TC_HOME = shareHome;
const { authRequestsPath, profileConfigPath, profilePath, sessionPath, withTinyCloudStateRoot, writeJsonAtomic } = await import("@tinycloud/operations/state");
const { createShareAuthorityAdapters } = await import("../share/adapters.js");
const { shareCliError } = await import("./share.js");

const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";
const cliEntry = join(import.meta.dir, "../../bin/tc");
const requests: string[] = [];
const localRequests: string[] = [];
let node: Server<undefined>;
let localNode: Server<undefined>;

type Posture = "delegate-session" | "local-owner-key" | "owner-openkey";

beforeAll(() => {
  node = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response("{}", { status: 500 });
    },
  });
  localNode = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      localRequests.push(`${request.method} ${path}`);
      if (path === "/healthz") return new Response("ok", { status: 200 });
      if (path === "/info") return Response.json({ nodeId: "did:key:z6MkLocalNodeTc674" });
      return new Response("{}", { status: 404 });
    },
  });
});

afterAll(async () => {
  node.stop(true);
  localNode.stop(true);
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(shareHome, { recursive: true, force: true });
});

/** A profile whose stored session is owner-signed and either expired or tampered. */
async function seedProfile(home: string, posture: Posture, state: "expired" | "tampered" = "expired", localNodeUrl?: string): Promise<void> {
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
      ...(localNodeUrl === undefined ? {} : { localNodeUrl }),
      createdAt: "2026-07-14T12:00:00.000Z",
    });
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


const fixedClockPath = join(import.meta.dir, "../../test-support/fixed-clock.mjs");

async function seedImportedProfile(
  home: string,
  profileName: string,
  expSecs: number,
  localNodeUrl?: string,
): Promise<{ artifactPath: string; delegation: PortableDelegation; ownerDid: string; sessionDid: string; spaceId: string; jwk: object }> {
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  const sessionDid = manager.getDID("default");
  const imported = await mintCompactDelegation({
    audience: sessionDid.split("#", 1)[0]!,
    expSecs,
    host: node.url.origin,
  });
  const profile = {
    name: profileName,
    host: node.url.origin,
    chainId: 1,
    spaceName: "secrets",
    did: sessionDid,
    sessionDid,
    ownerDid: imported.ownerDid,
    spaceId: imported.spaceId,
    posture: "delegate-session",
    operatorType: "agent",
    authMethod: "openkey",
    ...(localNodeUrl === undefined ? {} : { localNodeUrl }),
  };
  await withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(profileName), profile);
    await writeJsonAtomic(join(profilePath(profileName), "key.json"), JSON.parse(manager.jwk("default")!));
  });
  const artifactPath = join(home, "delegation.json");
  await writeFile(artifactPath, JSON.stringify(imported.delegation));
  return {
    artifactPath,
    delegation: imported.delegation,
    ownerDid: imported.ownerDid,
    sessionDid,
    spaceId: imported.spaceId,
    jwk: JSON.parse(manager.jwk("default")!),
  };
}
async function seedImportedSession(
  home: string,
  profileName: string,
  seeded: { delegation: PortableDelegation; sessionDid: string; spaceId: string; jwk: object },
): Promise<void> {
  await withTinyCloudStateRoot(home, () => writeJsonAtomic(sessionPath(profileName), {
    delegationHeader: seeded.delegation.delegationHeader,
    delegationCid: seeded.delegation.cid,
    spaceId: seeded.spaceId,
    jwk: seeded.jwk,
    verificationMethod: seeded.sessionDid,
  }));
}

async function runBuiltCli(
  home: string,
  argv: readonly string[],
  nowMs?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; error?: Record<string, unknown> }> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home };
  delete env.TC_HOST;
  delete env.TC_PRIVATE_KEY;
  if (nowMs !== undefined) env.TC_TEST_NOW_MS = String(nowMs);
  else delete env.TC_TEST_NOW_MS;
  const child = Bun.spawn([
    process.env.NODE_BINARY ?? "node",
    ...(nowMs === undefined ? [] : ["--import", pathToFileURL(fixedClockPath).href]),
    cliEntry,
    ...argv,
  ], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const error = exitCode === 0 ? undefined : (JSON.parse(stderr) as { error: Record<string, unknown> }).error;
  return { exitCode, stdout, stderr, ...(error === undefined ? {} : { error }) };
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

  // TC-674 regression: fails before the fix
  test("imports a live delegation, then rejects it at signed expiry before node access", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-imported-expiry-"));
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    try {
      const seeded = await seedImportedProfile(home, "imported", expiry);
      requests.length = 0;
      const imported = await runBuiltCli(home, [
        "--profile", "imported", "--json", "auth", "import", seeded.artifactPath,
      ], expiry * 1000 - 60_000);
      expect(imported).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(imported.stdout)).toMatchObject({ imported: true, activated: true });
      expect(requests).toEqual([]);

      const expiredNow = expiry * 1000;
      for (const argv of [
        ["--profile", "imported", "--json", "kv", "get", "KEY"],
        ["--profile", "imported", "--json", "secrets", "get", "KEY"],
        ["--profile", "imported", "--json", "secrets", "list"],
      ]) {
        const result = await runBuiltCli(home, argv, expiredNow);
        expect(result.exitCode, JSON.stringify({ argv, result })).toBe(3);
        expect(result.error).toMatchObject({
          code: "AUTH_REQUIRED",
          hint: expect.stringContaining("tc --profile imported auth login --method openkey --paste --manifest"),
        });
        expect(requests).toEqual([]);
      }

      const context = await runBuiltCli(home, ["--profile", "imported", "--json", "context"], expiredNow);
      expect(context.exitCode).toBe(0);
      expect(JSON.parse(context.stdout)).toMatchObject({
        session: { state: "expired", expiresAt: new Date(expiredNow).toISOString() },
      });

      const liveRead = await runBuiltCli(home, ["--profile", "imported", "--json", "kv", "get", "KEY"], expiredNow - 1);
      expect(liveRead.exitCode).not.toBe(3);
      expect(requests).toContain("POST /invoke");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
  // TC-674 regression: fails before the fix
  test("rejects an older imported session before node access", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-imported-old-expiry-"));
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    try {
      const seeded = await seedImportedProfile(home, "older", expiry);
      await seedImportedSession(home, "older", seeded);
      requests.length = 0;
      for (const argv of [
        ["--profile", "older", "--json", "kv", "get", "KEY"],
        ["--profile", "older", "--json", "secrets", "get", "KEY"],
        ["--profile", "older", "--json", "secrets", "list"],
        ["--profile", "older", "--json", "auth", "import", seeded.artifactPath],
      ]) {
        const result = await runBuiltCli(home, argv, expiry * 1000);
        expect(result.exitCode, JSON.stringify({ argv, result })).toBe(3);
        expect(result.error).toMatchObject({
          code: "AUTH_REQUIRED",
          hint: expect.stringContaining("tc --profile older auth login --method openkey --paste --manifest"),
        });
        expect(requests).toEqual([]);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  // TC-674 regression: fails before the fix
  test("defers local-node probing until an imported session verifies", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-imported-local-expiry-"));
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    try {
      const seeded = await seedImportedProfile(home, "local-expired", expiry, localNode.url.origin);
      await seedImportedSession(home, "local-expired", seeded);
      requests.length = 0;
      localRequests.length = 0;
      for (const argv of [
        ["--profile", "local-expired", "--json", "kv", "get", "KEY"],
        ["--profile", "local-expired", "--json", "secrets", "get", "KEY"],
      ]) {
        const result = await runBuiltCli(home, argv, expiry * 1000);
        expect(result.exitCode, JSON.stringify({ argv, result })).toBe(3);
        expect(result.error).toMatchObject({
          code: "AUTH_REQUIRED",
          hint: expect.stringContaining("tc --profile local-expired auth login --method openkey --paste --manifest"),
        });
        expect(requests).toEqual([]);
        expect(localRequests).toEqual([]);
      }

      localRequests.length = 0;
      const live = await runBuiltCli(home, ["--profile", "local-expired", "--json", "kv", "get", "KEY"], expiry * 1000 - 1);
      expect(live.exitCode).not.toBe(3);
      expect(localRequests[0]).toBe("GET /healthz");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
  // TC-674 regression: fails before the fix
  test("refuses an expired SIWE delegate before local-node probes", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-expired-siwe-local-"));
    try {
      await seedProfile(home, "delegate-session", "expired", localNode.url.origin);
      requests.length = 0;
      localRequests.length = 0;
      const result = await runBuiltCli(home, ["--profile", "expired", "--json", "kv", "get", "KEY"]);
      expect(result.exitCode).toBe(3);
      expect(result.error).toMatchObject({
        code: "AUTH_REQUIRED",
        hint: expect.stringContaining("tc --profile expired auth login --method openkey --paste --manifest"),
      });
      expect(requests).toEqual([]);
      expect(localRequests).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  // TC-674 control: passes before and after
  test("auth request without --grant probes local discovery using an expired session's fallback host", async () => {
    const home = await mkdtemp(join(tmpdir(), "tc-auth-request-expired-"));
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    try {
      const seeded = await seedImportedProfile(home, "requester", expiry, localNode.url.origin);
      await seedImportedSession(home, "requester", seeded);
      requests.length = 0;
      localRequests.length = 0;
      const argv = [
        "--profile", "requester", "--json", "auth", "request",
        "--cap", "tinycloud.kv:secrets:vault/secrets/KEY:get", "--emit",
      ];
      const request = await runBuiltCli(home, argv, expiry * 1000);
      expect(request.exitCode).toBe(0);
      expect(JSON.parse(request.stdout)).toMatchObject({ host: localNode.url.origin });
      const records = await withTinyCloudStateRoot(home, async () =>
        JSON.parse(await readFile(authRequestsPath("requester"), "utf8")) as Array<{ host: string }>);
      expect(records[0]?.host).toBe(localNode.url.origin);
      expect(localRequests).toEqual(["GET /healthz", "GET /info"]);
      expect(requests).toEqual([]);

      localRequests.length = 0;
      const granted = await runBuiltCli(home, [...argv, "--grant", "--yes"], expiry * 1000);
      expect(granted.exitCode).toBe(3);
      expect(granted.error).toMatchObject({ code: "AUTH_REQUIRED" });
      expect(localRequests).toEqual([]);
      expect(requests).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
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

  test("an unexpired imported session still gets Share publishing sign-in guidance", async () => {
    // TC-674 control: an unexpired imported session still reaches the SIWE-only Share guard.
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const imported = await seedImportedProfile(shareHome, "expired", exp);
    await withTinyCloudStateRoot(shareHome, () => writeJsonAtomic(sessionPath("expired"), {
      delegationHeader: imported.delegation.delegationHeader,
      delegationCid: imported.delegation.cid,
      spaceId: imported.spaceId,
      jwk: imported.jwk,
      verificationMethod: imported.sessionDid,
    }));
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
