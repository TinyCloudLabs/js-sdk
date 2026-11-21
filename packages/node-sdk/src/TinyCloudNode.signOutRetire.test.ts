import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import type { PersistedSessionData, PermissionEntry } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import type { NodeSignOutStatus } from "./sessionRetire";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";
import { unregisteredLocationRegistryResponse } from "./test-support/unregistered-location-registry";

// TC-3443: sign-out retires the session key on every host the session used,
// sending every root delegation the client holds for that key.
const HOST = "https://primary.retire.test";
const OTHER = "https://other.retire.test";
const DOWN = "https://down.retire.test";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

interface Retire { host: string; iss: string; delegations: string[] }

/** Fake nodes: `/info`, `/delegate` and `/session/retire` on HOST and OTHER; DOWN refuses every connection. */
function fakeNodes() {
  const state = { refuseDelegate: false };
  const retires: Retire[] = [];
  const delegated: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const metadata = unregisteredLocationRegistryResponse(input, HOST, init);
    if (metadata) return metadata;
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === DOWN) throw new TypeError("fetch failed");
    if (url.origin !== HOST && url.origin !== OTHER) throw new Error("Unexpected test destination");
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/info") return Response.json({ protocol: 1, version: "test", features: [], nodeId: `did:key:${url.hostname}` });
    if (url.pathname === "/delegate") {
      delegated.push(authorization!);
      return state.refuseDelegate
        ? new Response("unavailable", { status: 500 })
        : Response.json({ activated: [], skipped: [] });
    }
    if (url.pathname === "/session/retire") {
      const payload = JSON.parse(Buffer.from(authorization!.replace(/^Bearer /, "").split(".")[1]!, "base64url").toString("utf8"));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { delegations: string[] } : { delegations: [] };
      retires.push({ host: url.origin, iss: payload.iss, delegations: body.delegations });
      return Response.json({ did: payload.iss.split("#")[0], retiredAt: new Date().toISOString(), recorded: true });
    }
    throw new Error("Unexpected test endpoint");
  }) as typeof globalThis.fetch;
  return { state, retires, delegated };
}

/** Sign out, then wait for the node calls. */
async function signOutAndRetire(node: TinyCloudNode): Promise<NodeSignOutStatus> {
  await node.signOut();
  return (await node.nodeSignOutStatus())!;
}

async function signedIn(storage = new MemorySessionStorage()) {
  const signer = new PrivateKeySigner(PROOF_PRIVATE_KEY);
  const node = new TinyCloudNode({
    host: HOST, tinycloudRegistryUrl: HOST, signer, wasmBindings: new NodeWasmBindings(),
    sessionStorage: storage, autoBootstrapAccount: false, autoCreateSpace: false,
    includeAccountRegistryPermissions: false, enablePublicSpace: false,
  });
  await node.signIn();
  return { node, address: await signer.getAddress() };
}

const kv = (space: string): PermissionEntry => ({ service: "tinycloud.kv", space, path: "retire/", actions: ["tinycloud.kv/get"] });

test("a sign-in saves the hosts it activated on, and sign-out retires the key there with its root", async () => {
  const nodes = fakeNodes();
  const storage = new MemorySessionStorage();
  const { node, address } = await signedIn(storage);
  const { verificationMethod, delegationHeader } = node.session!;
  // The host list is added to the saved session after activation; let that queued write land.
  let saved: PersistedSessionData | null = null;
  for (let turn = 0; turn < 50 && !saved?.activatedHosts; turn++) {
    saved = await storage.load(address);
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(saved?.activatedHosts).toEqual([HOST]);

  const outcome = await signOutAndRetire(node);
  expect(outcome).toEqual({ confirmed: [HOST], nothingToRecord: [], notConfirmed: [] });
  expect(nodes.retires).toEqual([{ host: HOST, iss: verificationMethod, delegations: [delegationHeader.Authorization] }]);
  expect(storage.exists(address)).toBe(false);

  // A new session's sign-out replaces the status with its own.
  await node.signIn();
  const second = node.session!.verificationMethod;
  expect(await signOutAndRetire(node)).toEqual({ confirmed: [HOST], nothingToRecord: [], notConfirmed: [] });
  expect(nodes.retires.map(({ iss }) => iss)).toEqual([verificationMethod, second]);
});

test("sign-out sends every root for the key across spaces, one that no host accepted included", async () => {
  const nodes = fakeNodes();
  const { node } = await signedIn();
  const sessionRoot = node.session!.delegationHeader.Authorization;
  const [installed] = await node.grantRuntimePermissions([kv("account")]);
  nodes.state.refuseDelegate = true;
  const delegatedBefore = nodes.delegated.length;
  await expect(node.grantRuntimePermissions([kv("applications")])).rejects.toThrow();
  // The refused grant's root reached the host once and was not stored there.
  const unposted = nodes.delegated.slice(delegatedBefore);
  expect(new Set(unposted).size).toBe(1);

  await signOutAndRetire(node);
  const roots = [sessionRoot, installed!.delegationHeader.Authorization, unposted[0]!];
  expect(new Set(roots).size).toBe(3);
  expect(nodes.retires.length).toBeGreaterThan(0);
  for (const retire of nodes.retires) expect([...retire.delegations].sort()).toEqual([...roots].sort());
});

test("sign-out also retires each bootstrap key, with its own root; a host is confirmed once every key recorded", async () => {
  const nodes = fakeNodes();
  const { node } = await signedIn();
  const { verificationMethod, delegationHeader } = node.session!;
  // A bootstrap key the sign-in activated (as account bootstrap does for its spaces).
  const bootstrap = await signedRestorableSession();
  (node as unknown as { bootstrapSessions: unknown[] }).bootstrapSessions.push(bootstrap);

  expect(await signOutAndRetire(node)).toEqual({ confirmed: [HOST], nothingToRecord: [], notConfirmed: [] });
  expect([...nodes.retires].sort((a, b) => a.iss.localeCompare(b.iss))).toEqual([
    { host: HOST, iss: verificationMethod, delegations: [delegationHeader.Authorization] },
    { host: HOST, iss: bootstrap.verificationMethod, delegations: [bootstrap.delegationHeader.Authorization] },
  ].sort((a, b) => a.iss.localeCompare(b.iss)));
});

test("a restored session retires on its saved hosts with every root of its key, whatever its time window; a stray root is never sent", async () => {
  const nodes = fakeNodes();
  const proof = await signedRestorableSession();
  // The same owner's root for a different session key.
  const otherKey = await signedRestorableSession();
  expect(otherKey.verificationMethod).not.toBe(proof.verificationMethod);
  // Roots for this key that are not valid now: one not yet, one no longer.
  const sessionKey = { jwk: proof.jwk, verificationMethod: proof.verificationMethod };
  const notYet = await signedRestorableSession({ sessionKey, notBefore: new Date(Date.now() + 10 * 60_000) });
  const expired = await signedRestorableSession({ sessionKey, expired: true });
  const storage = new MemorySessionStorage();
  await storage.save(proof.address, {
    address: proof.address, chainId: proof.chainId,
    sessionKey: JSON.stringify(proof.jwk), siwe: proof.siwe, signature: proof.signature,
    tinycloudSession: {
      delegationHeader: proof.delegationHeader, delegationCid: proof.delegationCid,
      spaceId: proof.spaceId, verificationMethod: proof.verificationMethod,
    },
    expiresAt: proof.expiresAt, createdAt: new Date().toISOString(), version: "1.0",
    activatedHosts: [OTHER, DOWN],
  });
  const node = new TinyCloudNode({
    host: HOST, tinycloudRegistryUrl: null, wasmBindings: new NodeWasmBindings(),
    sessionStorage: storage, autoBootstrapAccount: false,
  });
  await node.restoreSession({ ...proof, tinycloudHosts: [HOST], activatedHosts: [OTHER, DOWN] });
  // Held grants: another key's (as bootstrap keys' grants are), this key's
  // not-yet-valid and expired roots, and one whose signature is not the owner's.
  const hold = (root: typeof proof, signature = root.signature) =>
    (node as unknown as { runtimePermissionGrants: unknown[] }).runtimePermissionGrants.push({
      session: { ...root },
      delegation: {
        cid: root.delegationCid, delegationHeader: root.delegationHeader, spaceId: root.spaceId,
        path: "", actions: [], expiry: new Date(root.expiresAt), delegateDID: root.verificationMethod,
        ownerAddress: root.address, chainId: root.chainId,
        siweProof: { siwe: root.siwe, signature },
      },
      operations: [],
      expiresAt: new Date(root.expiresAt),
      provenance: "delegated",
    });
  hold(otherKey);
  hold(notYet, otherKey.signature);
  hold(notYet);
  hold(expired);

  // Before this instance ends a session there is no status.
  expect(await node.nodeSignOutStatus()).toBeUndefined();
  await node.signOut();
  // Local sign-out is done while the down host is still being retried.
  expect(await Promise.race([node.nodeSignOutStatus().then(() => "settled"), Promise.resolve("pending")])).toBe("pending");
  expect(node.session === undefined && node.restorableSession === undefined).toBe(true);
  // The saved session, and with it the key, is gone.
  expect(storage.exists(proof.address)).toBe(false);
  const outcome = (await node.nodeSignOutStatus())!;
  expect([...outcome.confirmed].sort()).toEqual([HOST, OTHER].sort());
  expect(outcome.nothingToRecord).toEqual([]);
  expect(outcome.notConfirmed).toEqual([{ host: DOWN, reason: "unreachable", message: "fetch failed" }]);
  for (const retire of nodes.retires) {
    expect(retire.iss).toBe(proof.verificationMethod);
    expect(retire.delegations).toEqual([proof.delegationHeader.Authorization, notYet.delegationHeader.Authorization, expired.delegationHeader.Authorization]);
  }
  // A later sign-out has no key left to retire and leaves the status in place.
  const asked = nodes.retires.length;
  await node.signOut();
  expect(nodes.retires.length).toBe(asked);
  expect(await node.nodeSignOutStatus()).toBe(outcome);
});
