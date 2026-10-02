import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";
import { withRecapCaveat } from "./test-support/recap-caveat.js";

// Sessions saved by scoped login must keep serving the CLI. Restore
// re-verifies the signed SIWE, so the WASM verifier's caveat encoding (Maps,
// `undefined` for JSON null) has to survive node-sdk's restore.

const home = await mkdtemp(join(tmpdir(), "tc-caveated-session-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { refreshOpenKeySession } = await import("../commands/auth.js");
const { ensureAuthenticated } = await import("../lib/sdk.js");
const { createShareAuthorityAdapters } = await import("../share/adapters.js");
const { sharePublishingPermissions } = await import("../share/publishing-manifest.js");

const host = "https://node.example.test";
const shareOrigin = "https://share.example.test";
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const spaceId = wasm.makeSpaceId(address, 1, "default");
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const nodeDid = wasm.createSessionManager().getDID("default").split("#")[0]!;
const requested = sharePublishingPermissions();
const originalFetch = globalThis.fetch;

/** An owner-signed session over the share-publishing manifest; `caveat`, when given, is signed onto every action. */
async function signedProof(caveat?: Record<string, unknown>) {
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of requested) {
    (abilities[permission.service.slice("tinycloud.".length)] ??= {})[permission.path] = permission.actions;
  }
  const prepared = wasm.prepareSession({
    abilities, address, chainId: 1, domain: "cli.example.test", spaceId, jwk: key,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expirationTime: new Date(Date.now() + 3600_000).toISOString(),
  });
  if (caveat) prepared.siwe = withRecapCaveat(prepared.siwe, caveat);
  const signature = await signer.signMessage(prepared.siwe);
  return { ...wasm.completeSessionSetup({ ...prepared, signature }), jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did, address, chainId: 1, spaceId, siwe: prepared.siwe, signature };
}

async function login(caveat?: Record<string, unknown>): Promise<void> {
  const proof = await signedProof(caveat);
  await refreshOpenKeySession("publisher", host, { permissions: requested, openKeyAcquisition: async () => proof });
}

/** A TinyCloud node and Share service double: KV and sharing calls succeed. */
function nodeAndShareDouble(): typeof globalThis.fetch {
  return Object.assign(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/.well-known/tinycloud-share/config.json") {
      return Response.json({ version: "tinycloud.share/config-v2", shareOrigin, registryOrigin: shareOrigin, credentialsOrigin: shareOrigin });
    }
    if (url.pathname === "/info") return Response.json({ nodeId: nodeDid });
    return Response.json({});
  }, { preconnect: () => undefined }) as typeof globalThis.fetch;
}

async function publishBearer(fetchFn: typeof globalThis.fetch) {
  const { targetAdapter } = createShareAuthorityAdapters({ origin: shareOrigin, nodeOrigin: host, profileName: async () => "publisher", fetchFn });
  return targetAdapter.publish({
    source: new TextEncoder().encode("hello"), filename: "hello.txt", mediaType: "text/plain",
    target: { kind: "bearer" }, expiresAt: new Date(Date.now() + 600_000), origin: shareOrigin,
  });
}

function caveatsOf(entries: readonly { caveats?: unknown }[]): string[] {
  return [...new Set(entries.map((entry) => JSON.stringify(entry.caveats ?? [])))];
}

beforeEach(async () => {
  await ProfileManager.ensureConfigDir();
  await ProfileManager.setKey("publisher", key);
  await ProfileManager.setProfile("publisher", { name: "publisher", host, did, sessionDid: did, chainId: 1, spaceName: "default", createdAt: new Date().toISOString() });
  await ProfileManager.clearSession("publisher");
  globalThis.fetch = nodeAndShareDouble();
});
afterEach(() => { globalThis.fetch = originalFetch; });
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

describe("a scoped session with signed caveats", () => {
  test("restores with its caveats and reads KV; Share refuses to sub-delegate caveated authority", async () => {
    await login({ tenant: "alpha" });
    const saved = await ProfileManager.getSession("publisher") as { permissions: PermissionEntry[] };
    expect(caveatsOf(saved.permissions)).toEqual([JSON.stringify([{ tenant: "alpha" }])]);

    const node = await ensureAuthenticated(await ProfileManager.resolveContext({ profile: "publisher" }));
    expect(caveatsOf(node.getVerifiedSessionCapabilities())).toEqual([JSON.stringify([{ tenant: "alpha" }])]);
    const read = await node.kv.get("xyz.tinycloud.share/shares/existing");
    expect(read.ok).toBe(true);

    // The publish path restores and uploads; SharingService then fails closed
    // on caveated authority, since it cannot reproduce the caveats on a child
    // delegation (sdk-core SharingService.findSuitableKeyForDelegation).
    await expect(publishBearer(nodeAndShareDouble())).rejects.toMatchObject({ failure: { kind: "scope-denied", capability: "sharing delegation" } });
  });

  test("an unrestricted OpenKey session restored without a signer publishes a bearer share", async () => {
    await login();
    const published = await publishBearer(nodeAndShareDouble());
    expect(published).toMatchObject({ protocol: "tinycloud-share", metadata: { target: { kind: "bearer", spaceId } } });
  });

  test("a signed JSON null inside a caveat logs in, persists, restores and renews", async () => {
    const caveat = { nested: { value: null } };
    await login(caveat);
    const saved = await ProfileManager.getSession("publisher") as { permissions: PermissionEntry[] };
    expect(caveatsOf(saved.permissions)).toEqual([JSON.stringify([caveat])]);

    const node = await ensureAuthenticated(await ProfileManager.resolveContext({ profile: "publisher" }));
    expect(caveatsOf(node.getVerifiedSessionCapabilities())).toEqual([JSON.stringify([caveat])]);
    expect((await node.kv.get("xyz.tinycloud.share/shares/existing")).ok).toBe(true);

    // Same signed restriction: a renewal, not a narrowing.
    await login(caveat);
    expect(caveatsOf((await ProfileManager.getSession("publisher") as { permissions: PermissionEntry[] }).permissions)).toEqual([JSON.stringify([caveat])]);
  });
});
