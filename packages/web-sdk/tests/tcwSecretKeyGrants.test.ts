import { signedBrowserSession } from "./fixtures/signed-browser-session";
/*
 * TinyCloudWeb: an app's runtime grant of its owner's secrets' own keys (TC-3284) is kept with the session record
 * and activated again after a reload, keeping its signed expiry. Only exact `secrets/` keys on the owner's default
 * network, with decrypt and/or key.create, are kept or restored; one resource that is anything else refuses the
 * whole grant. The node is a stub; storage is in memory; nothing touches a real browser profile.
 */
import "./support/browserGlobalsShim";
import { describe, expect, mock, test } from "bun:test";
import type { PermissionEntry, PersistedSessionData } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk/core";

import { BrowserSessionStorage } from "../src/adapters/BrowserSessionStorage";
import { isSecretKeyResourceSet } from "../src/modules/runtimeGrantPersistence";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../src/modules/tcw") as { TinyCloudWeb: typeof TinyCloudWebType };

const SIGNED_PERSISTED = await signedBrowserSession(undefined, "2".padStart(64, "0"));
const ADDRESS = SIGNED_PERSISTED.address;
const OWNER = { address: ADDRESS, chainId: 1 };
const SESSION_DID = "did:key:z6MkSession";
const HOST = "https://node.test.local";
const MANIFEST = { app_id: "com.test.app", name: "Test App", icon: "https://example.com/icon.png", permissions: [] };
const NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:default`;
const BOTH = ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"];

const key = (path: string, actions: string[] = BOTH, network = NETWORK) =>
  ({ service: "encryption", space: "encryption", path: `${network}/${path}`, actions });
const FIREFLIES = key("secrets/fireflies_api_key");
const MEET = key("secrets/scoped/google-meet/oauth_token");

/** Each of these, alone or beside a valid key, refuses the whole grant. */
const REFUSED = {
  "the secrets/ prefix": key("secrets/"),
  "another network": key("secrets/fireflies_api_key", BOTH, `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:other`),
  "another owner": key("secrets/fireflies_api_key", BOTH, "urn:tinycloud:encryption:did:pkh:eip155:1:0x000000000000000000000000000000000000dEaD:default"),
  "another chain": key("secrets/fireflies_api_key", BOTH, `urn:tinycloud:encryption:did:pkh:eip155:10:${ADDRESS}:default`),
  "a non-secrets key": key("apps/com.test.app/k"),
  "a share key": key("share/x"),
  "a key below a secret's key": key("secrets/fireflies_api_key/x"),
  "an upper-case key path": key("secrets/FIREFLIES_API_KEY"),
  "a non-canonical scope": key("secrets/scoped/Google_Meet/oauth_token"),
  "an action beyond decrypt and key.create": key("secrets/fireflies_api_key", ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.block"]),
  "a caveat": { ...FIREFLIES, caveats: [{ nbf: 1 }] },
  "the network itself": { ...FIREFLIES, path: NETWORK },
  "a kv entry": { service: "kv", space: `tinycloud:pkh:eip155:1:${ADDRESS}:secrets`, path: "vault/secrets/FIREFLIES_API_KEY", actions: ["tinycloud.kv/get"] },
} as const;

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(name: string): string | null {
    return this.items.get(name) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(name: string): void {
    this.items.delete(name);
  }
  setItem(name: string, value: string): void {
    this.items.set(name, value);
  }
}

function session(): PersistedSessionData {
  return {
    address: ADDRESS,
    chainId: 1,
    sessionKey: SIGNED_PERSISTED.sessionKey,
    siwe: SIGNED_PERSISTED.siwe,
    signature: SIGNED_PERSISTED.signature,
    tinycloudSession: {
      delegationHeader: { Authorization: SIGNED_PERSISTED.tinycloudSession!.delegationHeader.Authorization },
      delegationCid: SIGNED_PERSISTED.tinycloudSession!.delegationCid,
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
      verificationMethod: `${SESSION_DID}#z6MkSession`,
    },
    tinycloudHosts: [HOST],
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    version: "1.0",
  };
}

type Resource = NonNullable<PortableDelegation["resources"]>[number];

function grant(cid: string, resources: readonly Resource[], expiresInMs = 24 * 60 * 60_000): PortableDelegation {
  return {
    cid,
    delegationHeader: { Authorization: `Bearer cacao-${cid}` },
    ownerAddress: ADDRESS,
    chainId: 1,
    host: HOST,
    spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
    path: resources[0]!.path,
    actions: resources[0]!.actions,
    resources: [...resources],
    expiry: new Date(Date.now() + expiresInMs),
    delegateDID: SESSION_DID,
    siweProof: { siwe: "grant-siwe", signature: "0xsig" },
  } as PortableDelegation;
}

/** Enough of a TinyCloudNode for a runtime request, the restore, and the SDK's validated activation of a CACAO grant. */
function stubNode(granted: PortableDelegation[] = []) {
  const installed: PortableDelegation[] = [];
  const used: string[] = [];
  const grants = new Map<string, PortableDelegation>();
  /** What the signed bytes of a grant say, when they differ from its stored fields. */
  const signedExpiry = new Map<string, Date>();
  const computeDelegationCid = mock((authorization: string) => authorization.replace("Bearer cacao-", ""));
  return {
    installed,
    used,
    signedExpiry,
    computeDelegationCid,
    address: ADDRESS,
    did: `did:pkh:eip155:1:${ADDRESS}`,
    sessionDid: SESSION_DID,
    hosts: [HOST],
    isSessionOnly: false,
    session: { address: ADDRESS, chainId: 1, sessionKey: "k", siwe: "s", signature: "g" },
    spaceId: undefined,
    hasRuntimePermissions: () => false,
    getRuntimePermissionDelegations: () => installed,
    grantRuntimePermissions: mock(async () => granted),
    restoreSession: mock(async () => undefined),
    verifySessionGrant: mock((proof: { delegationCid: string }) => {
      const known = grants.get(proof.delegationCid);
      return {
        recap: (known?.resources ?? []).map((resource) => ({ ...resource, caveats: resource.caveats ?? [] })),
        expiresAt: signedExpiry.get(proof.delegationCid) ?? known?.expiry ?? new Date(0),
      };
    }),
    useRuntimeDelegation: mock(async (delegation: PortableDelegation) => {
      used.push(delegation.cid);
      installed.push(delegation);
    }),
    know(...list: PortableDelegation[]) {
      for (const g of list) grants.set(g.cid, g);
    },
  };
}

async function web(node = stubNode()) {
  const backing = new MemoryStorage();
  const sessionStorage = new BrowserSessionStorage({ storage: backing });
  await sessionStorage.save(ADDRESS, session());
  const tcw = new TinyCloudWeb({ sessionStorage, ui: false, manifest: MANIFEST });
  const state = tcw as unknown as Record<string, unknown>;
  await (state._initPromise as Promise<unknown>);
  state._node = node;
  state._initPromise = Promise.resolve();
  const privately = tcw as unknown as { restoredNetworkWork: { grants: Promise<void> }; _testHooks: unknown };
  privately._testHooks = { showModal: async () => ({ approved: true }) };
  return { tcw, privately, sessionStorage, node };
}

const cids = async (storage: BrowserSessionStorage) => (await storage.loadRuntimeGrants(ADDRESS)).map((g) => g.cid);
const REQUEST: PermissionEntry[] = [{ service: "tinycloud.encryption", path: FIREFLIES.path, actions: BOTH }];

describe("which grants are a set of the owner's secrets' own keys", () => {
  test("exact and scoped keys, alone or together, with decrypt and/or key.create, either owner spelling", () => {
    for (const resources of [
      [FIREFLIES],
      [MEET],
      [FIREFLIES, MEET],
      [key("secrets/fireflies_api_key", ["tinycloud.encryption/decrypt"])],
      [key("secrets/fireflies_api_key", ["tinycloud.encryption/key.create"])],
      [key("secrets/fireflies_api_key", BOTH, NETWORK.toLowerCase())],
      // As the restore sees it: the signed permission has no space.
      [{ ...FIREFLIES, service: "tinycloud.encryption", space: "" }],
    ]) {
      expect(isSecretKeyResourceSet(resources, OWNER)).toBe(true);
    }
  });

  for (const [name, resource] of Object.entries(REFUSED)) {
    test(`refused: ${name}, alone or beside a valid key`, () => {
      expect(isSecretKeyResourceSet([resource], OWNER)).toBe(false);
      expect(isSecretKeyResourceSet([FIREFLIES, resource, MEET], OWNER)).toBe(false);
    });
  }

  test("refused: an empty set", () => {
    expect(isSecretKeyResourceSet([], OWNER)).toBe(false);
  });

  test("refused: secrets/scoped, the parent of every scoped key, alone or beside a valid key; a name SCOPED inside a scope is a key", () => {
    const parent = key("secrets/scoped");
    expect(isSecretKeyResourceSet([parent], OWNER)).toBe(false);
    expect(isSecretKeyResourceSet([FIREFLIES, parent, MEET], OWNER)).toBe(false);
    expect(isSecretKeyResourceSet([key("secrets/scoped/food/scoped")], OWNER)).toBe(true);
  });
});

describe("an approved request keeps only a secret-key grant", () => {
  test("a grant of exact secret keys is stored with the session", async () => {
    const { tcw, sessionStorage } = await web(stubNode([grant("keys", [FIREFLIES, MEET])]));
    expect((await tcw.requestPermissions(REQUEST)).approved).toBe(true);
    expect(await cids(sessionStorage)).toEqual(["keys"]);
  });

  test("a mixed grant (a valid key beside a refused resource) is not stored", async () => {
    for (const resource of Object.values(REFUSED)) {
      const { tcw, sessionStorage } = await web(stubNode([grant("mixed", [FIREFLIES, resource])]));
      expect((await tcw.requestPermissions(REQUEST)).approved).toBe(true);
      expect(await cids(sessionStorage)).toEqual([]);
    }
  });
});

describe("restore after a reload", () => {
  async function restoreWith(stored: PortableDelegation[], node = stubNode()) {
    node.know(...stored);
    const env = await web(node);
    await env.sessionStorage.saveRuntimeGrants(ADDRESS, stored);
    expect((await env.tcw.restoreSession(ADDRESS)).status).toBe("restored");
    await env.privately.restoredNetworkWork.grants;
    return { ...env, node };
  }

  test("a stored grant of exact and scoped keys is activated again with its original expiry", async () => {
    const own = grant("keys", [FIREFLIES, MEET], 60 * 60_000);
    const { node, sessionStorage } = await restoreWith([own]);
    expect(node.used).toEqual(["keys"]);
    expect(node.installed[0]!.expiry.getTime()).toBe(own.expiry.getTime());
    expect(await cids(sessionStorage)).toEqual(["keys"]);
  });

  for (const [name, resource] of Object.entries(REFUSED)) {
    test(`a stored grant carrying ${name} is not activated and is removed`, async () => {
      const { node, sessionStorage } = await restoreWith([grant("bad", [FIREFLIES, resource])]);
      expect(node.used).toEqual([]);
      expect(await cids(sessionStorage)).toEqual([]);
    });
  }

  test("an expired grant is not activated again", async () => {
    const { node } = await restoreWith([grant("old", [FIREFLIES], -1_000)]);
    expect(node.used).toEqual([]);
    expect(node.computeDelegationCid).not.toHaveBeenCalled();
  });

  test("a stored expiry later than the signed one (tampered) is not activated and is removed", async () => {
    const own = grant("stretched", [FIREFLIES], 7 * 24 * 60 * 60_000);
    const node = stubNode();
    node.signedExpiry.set("stretched", new Date(Date.now() + 60 * 60_000));
    const { sessionStorage } = await restoreWith([own], node);
    expect(node.used).toEqual([]);
    expect(await cids(sessionStorage)).toEqual([]);
  });
});
