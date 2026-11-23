// TC-4082: the proof belongs to one sign-in. A second sign-in, a cancelled wallet, a changed manifest and a sign-out
// in the middle of a proof each leave the active session, and the next sign-in, exactly where they were.
import { afterEach, describe, expect, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";

const DEFAULT_NODE = "https://node.tinycloud.xyz";
const REGISTRY = "https://registry.hosted-owner-resign.test";
const HOSTILE = "https://configured.hosted-owner-resign.test";
const key = "23".repeat(32);
const signer = new PrivateKeySigner(key);
const address = await signer.getAddress();
const applications = `tinycloud:pkh:eip155:1:${address}:applications`;
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

const list = [{ service: "tinycloud.kv", path: "notes/", actions: ["get", "list"] }];
const listAndPut = [{ service: "tinycloud.kv", path: "notes/", actions: ["get", "list", "put"] }];

interface Gates {
  /** Holds the answer to a path until released. */
  hold?: { path: string; release: Promise<void>; reached: () => void };
  /** Rejects this many signatures before signing for real. */
  cancelSignatures?: number;
}

function harness(gates: Gates = {}) {
  const requests: string[] = [];
  const storage = new MemorySessionStorage();
  let cancelled = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.origin === REGISTRY) return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
    if (url.origin === DEFAULT_NODE) {
      if (gates.hold?.path === url.pathname) {
        gates.hold.reached();
        await gates.hold.release;
      }
      if (url.pathname === "/info") return Response.json({ nodeId: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", protocol: 1, version: "1.26.22", features: [] });
      if (url.pathname === "/delegate") return Response.json({ activated: [applications], skipped: [] });
      if (url.pathname === "/invoke") return Response.json([]);
      if (url.pathname === "/session/retire") return Response.json({ retired: true });
    }
    throw new Error(`Unexpected request ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  const node = new TinyCloudNode({
    host: HOSTILE, newUserHost: HOSTILE, tinycloudFallbackHosts: [HOSTILE], tinycloudRegistryUrl: REGISTRY, autoDiscoverLocalNode: false,
    wasmBindings: new NodeWasmBindings(), sessionStorage: storage, requireExistingAccount: true, allowHostedOwnerProof: true,
    autoBootstrapAccount: false, includeAccountRegistryPermissions: false, enablePublicSpace: false,
    signer: {
      getAddress: () => signer.getAddress(),
      getChainId: () => signer.getChainId(),
      signMessage: async (message: string) => {
        if (cancelled < (gates.cancelSignatures ?? 0)) { cancelled += 1; throw new Error("User rejected the request"); }
        return signer.signMessage(message);
      },
    },
    manifest: { app_id: "tc4082-notes", name: "Notes", defaults: false, includePublicSpace: false, permissions: list },
  } as ConstructorParameters<typeof TinyCloudNode>[0]);
  const count = (request: string) => requests.filter((entry) => entry === request).length;
  return { node, requests, storage, count };
}

async function usable(node: TinyCloudNode): Promise<boolean> {
  const listed = await node.kv.list({ prefix: "tc4082-notes/notes/" });
  return listed.ok;
}

describe("a second sign-in after a proven one", () => {
  test("signs in again: a new proof, the new session routes, nothing is refused before signing", async () => {
    const { node, count } = harness();
    await node.signIn();
    const first = node.session?.delegationCid;
    await node.signIn();
    expect(node.session?.delegationCid).not.toBe(first);
    expect(count(`POST ${DEFAULT_NODE}/delegate`)).toBe(2);
    expect(count(`POST ${DEFAULT_NODE}/invoke`)).toBe(2);
    expect(await usable(node)).toBe(true);
  });

  test("a changed manifest and a new sign-in (setManifest + signIn) works the same", async () => {
    const { node, count } = harness();
    await node.signIn();
    node.setManifest({ app_id: "tc4082-notes", name: "Notes", defaults: false, includePublicSpace: false, permissions: listAndPut } as never);
    await node.signIn();
    expect(count(`POST ${DEFAULT_NODE}/delegate`)).toBe(2);
    expect(await usable(node)).toBe(true);
  });

  test("a wallet that cancels the second sign-in does not poison the third", async () => {
    const { node, count } = harness();
    await node.signIn();
    const wallet = node as unknown as { signer: { signMessage: (message: string) => Promise<string> } };
    const sign = wallet.signer.signMessage;
    wallet.signer.signMessage = async () => { throw new Error("User rejected the request"); };
    await expect(node.signIn()).rejects.toThrow("User rejected");
    wallet.signer.signMessage = sign;
    await node.signIn();
    expect(count(`POST ${DEFAULT_NODE}/delegate`)).toBe(2);
    expect(await usable(node)).toBe(true);
  });
});

describe("a wallet that cancels the first sign-in", () => {
  test("leaves nothing behind: the next sign-in proves normally and a restore is not blocked", async () => {
    const { node, count, storage } = harness({ cancelSignatures: 1 });
    await expect(node.signIn()).rejects.toThrow("User rejected");
    expect(storage.exists(address)).toBe(false);
    expect(count(`POST ${DEFAULT_NODE}/delegate`)).toBe(0);
    await node.signIn();
    expect(count(`POST ${DEFAULT_NODE}/delegate`)).toBe(1);
    expect(await usable(node)).toBe(true);
  });
});

describe("a sign-out in the middle of a proof", () => {
  async function signOutWhile(path: "/delegate") {
    let reach!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ hold: { path, release: released, reached: reach } });
    const signIn = h.node.signIn().catch((error) => error);
    await reached;
    const signOut = h.node.signOut();
    release();
    await signOut;
    return { ...h, outcome: await signIn };
  }

  test("after the /delegate was sent, the session is retired at the node", async () => {
    const { count, node, outcome, requests } = await signOutWhile("/delegate");
    expect(count(`POST ${DEFAULT_NODE}/delegate`)).toBe(1);
    await node.nodeSignOutStatus();
    expect(count(`POST ${DEFAULT_NODE}/session/retire`)).toBe(1);
    expect(node.session).toBeUndefined();
    expect(outcome).toBeInstanceOf(Error);
  });

  test("before anything was sent, no retire is sent and no /delegate follows", async () => {
    const { count, node, outcome } = await signOutBeforeDelegate();
    await node.nodeSignOutStatus();
    expect(count(`POST ${DEFAULT_NODE}/delegate`)).toBe(0);
    expect(count(`POST ${DEFAULT_NODE}/session/retire`)).toBe(0);
    expect(node.session).toBeUndefined();
    expect(outcome).toBeInstanceOf(Error);
  });
});

async function signOutBeforeDelegate() {
  // The session is persisted after the wallet signed and before the proof's /delegate: sign out while that is pending.
  // No session key is current yet at that point, so there is nothing a node could be asked to retire.
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const h = harness();
  const save = h.storage.save.bind(h.storage);
  h.storage.save = async (...args: Parameters<typeof save>) => { reach(); await released; return save(...args); };
  const signIn = h.node.signIn().catch((error) => error);
  await reached;
  expect(h.count(`POST ${DEFAULT_NODE}/delegate`)).toBe(0);
  const signOut = h.node.signOut();
  release();
  await signOut;
  return { ...h, outcome: await signIn };
}
