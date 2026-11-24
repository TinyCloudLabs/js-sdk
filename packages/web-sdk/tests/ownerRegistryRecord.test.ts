/*
 * TC-3891: TinyCloud One calls `tcw.ensureOwnerRegistryRecord()` after an OpenKey sign-in. The owner's record is
 * created, owner-signed through OpenKey `signMessage`, only when the registry has none; an existing record is untouched.
 */
import "./support/browserGlobalsShim";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import { signLocationRecordV2, verifyLocationRecordV2, type LocationRecordV2 } from "@tinycloud/sdk-core";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../src/modules/tcw") as { TinyCloudWeb: typeof TinyCloudWebType };

const REGISTRY_URL = "https://registry.test.local";
const ONE_ORIGIN = "https://tinycloud.one";
const nodeKey = (fill: number) => {
  const publicKey = ed25519.getPublicKey(new Uint8Array(32).fill(fill));
  return `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...publicKey))}`;
};
const NODE = { did: nodeKey(7), url: "https://node.test.local" };
const OTHER_NODE = { did: nodeKey(9), url: "https://other-node.test.local" };

// Bun has no `window`; the SDK reads the page origin from `window.location.origin`.
const globals: { window?: unknown } = globalThis;
let oldWindow: unknown;
let oldFetch: typeof globalThis.fetch;
let registered: LocationRecordV2 | undefined;
let puts: LocationRecordV2[];

beforeEach(() => {
  oldWindow = globals.window;
  oldFetch = globalThis.fetch;
  globals.window = { location: { origin: ONE_ORIGIN } };
  registered = undefined;
  puts = [];
  // The location registry and the node identity probes the publish checks.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const node of [NODE, OTHER_NODE]) {
      if (url === `${node.url}/info`) return Response.json({ nodeId: node.did });
      if (url === `${node.url}/.well-known/tinycloud/node-keys`) return Response.json({ nodeDid: node.did });
    }
    if (!url.startsWith(REGISTRY_URL)) return new Response(`unexpected URL ${url}`, { status: 599 });
    if (init?.method === "PUT") {
      const record = JSON.parse(String(init.body)) as LocationRecordV2;
      puts.push(record);
      registered = record;
      return Response.json({ record, status: "created" }, { status: 201 });
    }
    if (registered) return Response.json({ record: registered });
    return Response.json({ error: "location record not found" }, { status: 404 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globals.window = oldWindow;
  globalThis.fetch = oldFetch;
});

/** A TinyCloudWeb signed in at TinyCloud One through OpenKey (iframe mode), as TinyChat's sign-in leaves it. */
function signedInAtOne() {
  const account = privateKeyToAccount(generatePrivateKey());
  const subject = `did:pkh:eip155:1:${account.address}`;
  const space = `tinycloud:pkh:eip155:1:${account.address.toLowerCase()}:default`;
  const signMessage = mock(async (request: { message: string; keyId: string }, _opts?: { mode?: string }) =>
    ({ signature: await account.signMessage({ message: request.message }) }));
  const client = { authorizeTinyCloud: mock(), signMessage, lastAuth: { address: account.address, keyId: "key-1" } };
  const node = {
    address: account.address,
    did: subject,
    spaceId: space,
    session: { address: account.address },
    activeNodeIdentity: async () => ({ nodeDid: NODE.did, origin: NODE.url }),
  };
  const tcw = Object.create(TinyCloudWeb.prototype) as TinyCloudWebType;
  Object.assign(tcw, {
    config: { openkey: { client, mode: "iframe" }, tinycloudRegistryUrl: REGISTRY_URL },
    signOutCount: 0,
    signOutInFlight: 0,
    _node: node,
  });
  return { tcw, account, subject, space, signMessage };
}

test("sign-in on One creates the owner's record when none exists, signed once through OpenKey", async () => {
  const { tcw, subject, space, signMessage } = signedInAtOne();

  expect(await tcw.ensureOwnerRegistryRecord()).toBe("published");

  expect(signMessage).toHaveBeenCalledTimes(1);
  expect(signMessage.mock.calls[0]![0].keyId).toBe("key-1");
  expect(signMessage.mock.calls[0]![1]).toEqual({ mode: "iframe" });
  expect(puts).toHaveLength(1);
  const record = puts[0]!;
  expect(record.version).toBe(2);
  expect(record.subject).toBe(subject);
  expect(record.nodes).toEqual([NODE]);
  expect(record.spaces).toEqual([{ space, nodes: [{ did: NODE.did, mode: "read-write" }] }]);
  expect(await verifyLocationRecordV2(record)).toBe(true);

  // A second call (the next sign-in) finds the record and asks for nothing.
  expect(await tcw.ensureOwnerRegistryRecord()).toBe("already-current");
  expect(signMessage).toHaveBeenCalledTimes(1);
  expect(puts).toHaveLength(1);
});

test("an existing record is untouched: no signature, no PUT, the stored record is unchanged", async () => {
  const { tcw, account, subject, space, signMessage } = signedInAtOne();
  const existing = await signLocationRecordV2({
    version: 2,
    subject,
    nodes: [OTHER_NODE],
    spaces: [{ space, nodes: [{ did: OTHER_NODE.did, mode: "read-write" }] }],
    encryptionNode: null,
    updated_at: "2026-11-20T00:00:00.000Z",
    sequence: 0,
  }, { type: "did:pkh", signMessage: (message) => account.signMessage({ message }) });
  registered = existing;

  expect(await tcw.ensureOwnerRegistryRecord()).toBe("already-current");

  expect(signMessage).not.toHaveBeenCalled();
  expect(puts).toHaveLength(0);
  expect(registered).toEqual(existing);
});
