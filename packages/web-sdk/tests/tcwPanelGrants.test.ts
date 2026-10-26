/*
 * TinyCloudWeb: the panel's permission request and the grant it leaves behind. A request stores only the panel's own
 * grant; a restore after a reload activates the stored grant again (verified from its signed bytes), never fails
 * because of it, and removes one the node refuses; the panel is offered the request only with a signer and manifest.
 * The node is a stub; storage is in memory; nothing touches a real browser profile.
 */
import "./support/browserGlobalsShim";
import { describe, expect, mock, test } from "bun:test";
import type { PermissionEntry, PersistedSessionData } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk/core";

import { BrowserSessionStorage } from "../src/adapters/BrowserSessionStorage";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../src/modules/tcw") as { TinyCloudWeb: typeof TinyCloudWebType };

const ADDRESS = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
const APPLICATIONS = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
const SESSION_DID = "did:key:z6MkSession";
const HOST = "https://node.test.local";
const ENTRY: PermissionEntry = { service: "tinycloud.delegation", space: "applications", path: "", actions: ["list"] };
const MANIFEST = { app_id: "com.test.app", name: "Test App", icon: "https://example.com/icon.png", permissions: [] };

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  failWrites = false;
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException("quota", "QuotaExceededError");
    this.items.set(key, value);
  }
}

function session(): PersistedSessionData {
  return {
    address: ADDRESS,
    chainId: 1,
    sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "private" }),
    siwe: "siwe",
    signature: "signature",
    tinycloudSession: {
      delegationHeader: { Authorization: "Bearer persisted" },
      delegationCid: "bafy-persisted",
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
      verificationMethod: `${SESSION_DID}#z6MkSession`,
    },
    tinycloudHosts: [HOST],
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    version: "1.0",
  };
}

const LIST = { service: "delegation", space: APPLICATIONS, path: "", actions: ["tinycloud.delegation/list"] };

function grant(cid: string, over: { resources?: PortableDelegation["resources"]; expiresInMs?: number } = {}): PortableDelegation {
  return {
    cid,
    delegationHeader: { Authorization: `Bearer cacao-${cid}` },
    ownerAddress: ADDRESS,
    chainId: 1,
    host: HOST,
    spaceId: APPLICATIONS,
    path: "",
    actions: ["tinycloud.delegation/list"],
    resources: over.resources ?? [LIST],
    expiry: new Date(Date.now() + (over.expiresInMs ?? 24 * 60 * 60_000)),
    delegateDID: SESSION_DID,
    siweProof: { siwe: "grant-siwe", signature: "0xsig" },
  } as PortableDelegation;
}

interface StubNodeOptions {
  /** What `grantRuntimePermissions` returns. */
  granted?: PortableDelegation[];
  /** The node already holds a runtime grant covering the request (the short-circuit). */
  covered?: PortableDelegation[];
  /** The key this session's grants must be issued to. */
  sessionDid?: string;
  signer?: boolean;
  session?: boolean;
}

/** Enough of a TinyCloudNode for the panel request, the restore, and the SDK's validated activation of a CACAO grant. */
function stubNode(options: StubNodeOptions = {}) {
  const installed: PortableDelegation[] = [];
  const used: string[] = [];
  const grants = new Map<string, PortableDelegation>();
  const computeDelegationCid = mock((authorization: string) => authorization.replace("Bearer cacao-", ""));
  return {
    installed,
    used,
    computeDelegationCid,
    address: ADDRESS,
    did: `did:pkh:eip155:1:${ADDRESS}`,
    sessionDid: options.sessionDid ?? SESSION_DID,
    hosts: [HOST],
    isSessionOnly: options.signer === false,
    session: options.session === false ? undefined : { address: ADDRESS, chainId: 1, sessionKey: "k", siwe: "s", signature: "g" },
    spaceId: undefined,
    hasRuntimePermissions: () => options.covered !== undefined,
    getRuntimePermissionDelegations: (permissions?: PermissionEntry[]) =>
      permissions === undefined ? installed : (options.covered ?? []),
    grantRuntimePermissions: mock(async () => options.granted ?? []),
    restoreSession: mock(async () => undefined),
    verifySessionGrant: mock((proof: { delegationCid: string }) => ({
      recap: [{ ...LIST, caveats: [] }],
      expiresAt: grants.get(proof.delegationCid)?.expiry ?? new Date(0),
    })),
    useRuntimeDelegation: mock(async (delegation: PortableDelegation) => {
      used.push(delegation.cid);
      installed.push(delegation);
    }),
    /** The grants the stub node knows the signed bytes of. */
    know(...list: PortableDelegation[]) {
      for (const g of list) grants.set(g.cid, g);
    },
  };
}

async function web(options: { node?: ReturnType<typeof stubNode>; manifest?: boolean } = {}) {
  const backing = new MemoryStorage();
  const sessionStorage = new BrowserSessionStorage({ storage: backing });
  await sessionStorage.save(ADDRESS, session());
  const tcw = new TinyCloudWeb({ sessionStorage, ui: false, ...(options.manifest === false ? {} : { manifest: MANIFEST }) });
  const state = tcw as unknown as Record<string, unknown>;
  await (state._initPromise as Promise<unknown>);
  const node = options.node ?? stubNode();
  state._node = node;
  state._initPromise = Promise.resolve();
  const privately = tcw as unknown as {
    canRequestPanelPermissions(): boolean;
    requestPanelPermissions(entries: PermissionEntry[], options: { expiryMs: number }): Promise<{ approved: boolean }>;
    signOutCount: number;
    _testHooks: unknown;
  };
  return { tcw, privately, backing, sessionStorage, node };
}

const cids = async (storage: BrowserSessionStorage) => (await storage.loadRuntimeGrants(ADDRESS)).map((g) => g.cid);

describe("the panel's request stores the panel's own grant", () => {
  test("approve: the grant is stored with the session", async () => {
    const own = grant("own");
    const { privately, sessionStorage } = await web({ node: stubNode({ granted: [own] }) });
    privately._testHooks = { showModal: async () => ({ approved: true }) };

    const result = await privately.requestPanelPermissions([ENTRY], { expiryMs: 1000 });

    expect(result).toEqual({ approved: true });
    expect(await cids(sessionStorage)).toEqual(["own"]);
  });

  test("a larger grant that already covers the request is not stored", async () => {
    const larger = grant("wide", {
      resources: [{ ...LIST, actions: ["tinycloud.delegation/list", "tinycloud.delegation/create", "tinycloud.delegation/revoke"] }],
    });
    const { privately, sessionStorage } = await web({ node: stubNode({ covered: [larger] }) });

    const result = await privately.requestPanelPermissions([ENTRY], { expiryMs: 1000 });

    expect(result).toEqual({ approved: true });
    expect(await cids(sessionStorage)).toEqual([]);
  });

  test("decline: nothing is stored", async () => {
    const { privately, sessionStorage } = await web({ node: stubNode({ granted: [grant("own")] }) });
    privately._testHooks = { showModal: async () => ({ approved: false }) };

    expect(await privately.requestPanelPermissions([ENTRY], { expiryMs: 1000 })).toEqual({ approved: false });
    expect(await cids(sessionStorage)).toEqual([]);
  });

  test("signed out while the prompt was open: the grant is not stored", async () => {
    const { privately, sessionStorage } = await web({ node: stubNode({ granted: [grant("own")] }) });
    privately._testHooks = {
      showModal: async () => {
        privately.signOutCount += 1;
        return { approved: true };
      },
    };

    await privately.requestPanelPermissions([ENTRY], { expiryMs: 1000 });

    expect(await cids(sessionStorage)).toEqual([]);
  });

  test("a storage that refuses the write does not fail an approved request", async () => {
    const { privately, backing } = await web({ node: stubNode({ granted: [grant("own")] }) });
    privately._testHooks = { showModal: async () => ({ approved: true }) };
    backing.failWrites = true;

    expect(await privately.requestPanelPermissions([ENTRY], { expiryMs: 1000 })).toEqual({ approved: true });
  });
});

describe("the panel is offered the request only when the page can show the prompt", () => {
  test("a manifest, a page signer and a session: yes", async () => {
    expect((await web()).privately.canRequestPanelPermissions()).toBe(true);
  });

  test("no manifest: no", async () => {
    expect((await web({ manifest: false })).privately.canRequestPanelPermissions()).toBe(false);
  });

  test("no page signer (session-only): no", async () => {
    expect((await web({ node: stubNode({ signer: false }) })).privately.canRequestPanelPermissions()).toBe(false);
  });

  test("no session (signed out): no", async () => {
    expect((await web({ node: stubNode({ session: false }) })).privately.canRequestPanelPermissions()).toBe(false);
  });
});

describe("restore after a reload", () => {
  async function restoreWith(options: {
    node?: ReturnType<typeof stubNode>;
    stored: PortableDelegation[];
    failWritesAfterSeeding?: boolean;
  }) {
    const node = options.node ?? stubNode();
    node.know(...options.stored);
    const env = await web({ node });
    await env.sessionStorage.saveRuntimeGrants(ADDRESS, options.stored);
    if (options.failWritesAfterSeeding) env.backing.failWrites = true;
    const result = await env.tcw.restoreSession(ADDRESS);
    return { ...env, result, node };
  }

  test("grant, reload: the stored grant is activated again and the session is restored", async () => {
    const own = grant("own");
    const { result, node, sessionStorage } = await restoreWith({ stored: [own] });

    expect(result.status).toBe("restored");
    expect(node.used).toEqual(["own"]);
    expect(await cids(sessionStorage)).toEqual(["own"]);
  });

  test("the grant is verified from its signed bytes, not from stored fields", async () => {
    const own = grant("own");
    const node = stubNode();
    node.know(own);
    // The signed bytes say the grant lasts less than the stored (unsigned) expiry claims.
    node.verifySessionGrant.mockImplementation(() => ({ recap: [{ ...LIST, caveats: [] }], expiresAt: new Date(own.expiry.getTime() - 60_000) }));
    const { result, sessionStorage } = await restoreWith({ node, stored: [own] });

    expect(result.status).toBe("restored");
    expect(node.used).toEqual([]);
    expect(await cids(sessionStorage)).toEqual([]);
  });

  test("an expired grant is not activated again", async () => {
    const { result, node } = await restoreWith({ stored: [grant("old", { expiresInMs: -1_000 })] });

    expect(result.status).toBe("restored");
    expect(node.used).toEqual([]);
    expect(node.computeDelegationCid).not.toHaveBeenCalled();
  });

  test("a grant issued to another session key is skipped and removed; the session is restored", async () => {
    const { result, node, sessionStorage } = await restoreWith({
      node: stubNode({ sessionDid: "did:key:z6MkSomeoneElse" }),
      stored: [grant("mine")],
    });

    expect(result.status).toBe("restored");
    expect(node.used).toEqual([]);
    expect(await cids(sessionStorage)).toEqual([]);
  });

  test("a stored grant that is larger than the panel's entry is not activated", async () => {
    const larger = grant("wide", { resources: [{ ...LIST, actions: ["tinycloud.delegation/list", "tinycloud.delegation/revoke"] }] });
    const node = stubNode();
    node.verifySessionGrant.mockImplementation(() => ({
      recap: [{ ...LIST, actions: ["tinycloud.delegation/list", "tinycloud.delegation/revoke"], caveats: [] }],
      expiresAt: larger.expiry,
    }));
    const { result, sessionStorage } = await restoreWith({ node, stored: [larger] });

    expect(result.status).toBe("restored");
    expect(node.used).toEqual([]);
    expect(await cids(sessionStorage)).toEqual([]);
  });

  test("a failing activation (the node cannot be reached) keeps the grant for the next reload", async () => {
    const node = stubNode();
    node.useRuntimeDelegation.mockImplementation(async () => {
      throw Object.assign(new Error("host unreachable"), { code: "ACTIVATION_TRANSPORT_FAILED" });
    });
    const { result, sessionStorage } = await restoreWith({ node, stored: [grant("own")] });

    expect(result.status).toBe("restored");
    expect(await cids(sessionStorage)).toEqual(["own"]);
  });

  test("a node that refuses the grant (a 4xx at activation) removes it; the session is restored", async () => {
    const node = stubNode();
    node.useRuntimeDelegation.mockImplementation(async () => {
      throw Object.assign(new Error("Failed to activate"), { cause: { success: false, status: 403 } });
    });
    const { result, sessionStorage } = await restoreWith({ node, stored: [grant("own")] });

    expect(result.status).toBe("restored");
    expect(await cids(sessionStorage)).toEqual([]);
  });

  test("a storage that refuses writes (quota) does not fail the restore", async () => {
    const { result, node } = await restoreWith({
      node: stubNode({ sessionDid: "did:key:z6MkSomeoneElse" }),
      stored: [grant("mine")],
      failWritesAfterSeeding: true,
    });

    expect(result.status).toBe("restored");
    expect(result.error).toBeUndefined();
    expect(node.used).toEqual([]);
  });

  test("a storage that cannot be read does not fail the restore", async () => {
    const node = stubNode();
    const env = await web({ node });
    await env.sessionStorage.saveRuntimeGrants(ADDRESS, [grant("own")]);
    env.sessionStorage.loadRuntimeGrants = async () => {
      throw new Error("blocked");
    };

    const result = await env.tcw.restoreSession(ADDRESS);

    expect(result.status).toBe("restored");
  });
});
