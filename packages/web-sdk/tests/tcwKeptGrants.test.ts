import { signedBrowserSession } from "./fixtures/signed-browser-session";
/*
 * TinyCloudWeb: permissions an app asked for through `requestPermissions` stay approved after a page reload, for the
 * app that asked. Only non-elevated grants (no decrypt or key creation, nothing in the secrets space, no caveats) are
 * stored; each stored grant records the apps it was approved for, and a check made for one app does not count a grant
 * approved for another. The node is a stub; storage is in memory; nothing touches a real browser profile.
 */
import "./support/browserGlobalsShim";
import { describe, expect, mock, test } from "bun:test";
import type { PermissionEntry, PersistedSessionData } from "@tinycloud/sdk-core";
import type { PortableDelegation } from "@tinycloud/node-sdk/core";

import { BrowserSessionStorage } from "../src/adapters/BrowserSessionStorage";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../src/modules/tcw") as { TinyCloudWeb: typeof TinyCloudWebType };

const SIGNED_PERSISTED = await signedBrowserSession(undefined, "1".padStart(64, "0"));
const ADDRESS = SIGNED_PERSISTED.address;
const ACCOUNT = `tinycloud:pkh:eip155:1:${ADDRESS}:account`;
const SECRETS = `tinycloud:pkh:eip155:1:${ADDRESS}:secrets`;
const SESSION_DID = "did:key:z6MkSession";
const HOST = "https://node.test.local";
const MANIFEST = { app_id: "com.test.app", name: "Test App", icon: "https://example.com/icon.png", permissions: [] };
const COURIER = "xyz.tinycloud.courier";
const EXPLORER = "xyz.tinycloud.explorer";

type Resource = NonNullable<PortableDelegation["resources"]>[number];

const APPLICATIONS_READ: PermissionEntry = { service: "tinycloud.kv", space: "account", path: "applications/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] };
const APPLICATIONS_READ_RESOURCE: Resource = { service: "tinycloud.kv", space: ACCOUNT, path: "applications/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] };
const SECRETS_LIST: PermissionEntry = { service: "tinycloud.kv", space: "secrets", path: "vault/secrets", actions: ["tinycloud.kv/list"] };
const SECRETS_RESOURCE: Resource = { service: "tinycloud.kv", space: SECRETS, path: "vault/secrets", actions: ["tinycloud.kv/list"] };
const DECRYPT: PermissionEntry = { service: "tinycloud.encryption", path: "network-1", actions: ["decrypt"] };
const DECRYPT_RESOURCE: Resource = { service: "tinycloud.encryption", space: "encryption", path: "network-1", actions: ["decrypt"] };

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
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
    this.items.set(key, value);
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

function grant(cid: string, resources: Resource[] = [APPLICATIONS_READ_RESOURCE], expiresInMs = 24 * 60 * 60_000): PortableDelegation {
  return {
    cid,
    delegationHeader: { Authorization: `Bearer cacao-${cid}` },
    ownerAddress: ADDRESS,
    chainId: 1,
    host: HOST,
    spaceId: resources[0]!.space,
    path: resources[0]!.path,
    actions: resources[0]!.actions,
    resources,
    expiry: new Date(Date.now() + expiresInMs),
    delegateDID: SESSION_DID,
    siweProof: { siwe: "grant-siwe", signature: "0xsig" },
  } as PortableDelegation;
}

/** Enough of a TinyCloudNode for `requestPermissions`, the restore, and the SDK's validated activation of a CACAO grant. */
function stubNode(issues: PortableDelegation[] = []) {
  const installed: PortableDelegation[] = [];
  const known = new Map<string, PortableDelegation>();
  const counted = (cids?: readonly string[]) => installed.filter((g) => cids === undefined || cids.includes(g.cid));
  const covers = (entries: PermissionEntry[], cids?: readonly string[]) =>
    counted(cids).some((g) => entries.every((e) => g.resources?.some((r) => r.space.endsWith(`:${e.space}`) && r.path === e.path) === true));
  const node = {
    installed,
    address: ADDRESS,
    did: `did:pkh:eip155:1:${ADDRESS}`,
    sessionDid: SESSION_DID,
    hosts: [HOST],
    isSessionOnly: false,
    session: { address: ADDRESS, chainId: 1, sessionKey: "k", siwe: "s", signature: "g" },
    spaceId: undefined,
    computeDelegationCid: (authorization: string) => authorization.replace("Bearer cacao-", ""),
    hasRuntimePermissions: mock((entries: PermissionEntry[], options?: { grantCids?: readonly string[] }) => covers(entries, options?.grantCids)),
    getRuntimePermissionDelegations: mock((entries?: PermissionEntry[], options?: { grantCids?: readonly string[] }) =>
      entries === undefined ? installed : counted(options?.grantCids).filter((g) => covers(entries, [g.cid]))),
    grantRuntimePermissions: mock(async (_entries: PermissionEntry[], _options?: { reuseExisting?: boolean }) => {
      installed.push(...issues);
      return issues;
    }),
    restoreSession: mock(async () => undefined),
    verifySessionGrant: mock((proof: { delegationCid: string }) => {
      const stored = known.get(proof.delegationCid);
      return { recap: (stored?.resources ?? []).map((r) => ({ ...r, caveats: [] })), expiresAt: stored?.expiry ?? new Date(0) };
    }),
    useRuntimeDelegation: mock(async (delegation: PortableDelegation) => {
      installed.push(delegation);
    }),
    know(...list: PortableDelegation[]) {
      for (const g of list) known.set(g.cid, g);
    },
  };
  return node;
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
  const privately = tcw as unknown as { signOutCount: number; restoredNetworkWork: { grants: Promise<void> }; _testHooks: unknown };
  return { tcw, privately, backing, sessionStorage, node };
}

type Stored = PortableDelegation & { askedBy?: string[] };
const stored = async (storage: BrowserSessionStorage) => (await storage.loadRuntimeGrants(ADDRESS)) as Stored[];

/** A reload: a new TinyCloudWeb over the same storage, restored, with its grants active again. */
async function reload(previous: Awaited<ReturnType<typeof web>>, node = stubNode()) {
  for (const g of await stored(previous.sessionStorage)) node.know(g);
  const sessionStorage = new BrowserSessionStorage({ storage: previous.backing });
  const tcw = new TinyCloudWeb({ sessionStorage, ui: false, manifest: MANIFEST });
  const state = tcw as unknown as Record<string, unknown>;
  await (state._initPromise as Promise<unknown>);
  state._node = node;
  state._initPromise = Promise.resolve();
  expect((await tcw.restoreSession(ADDRESS)).status).toBe("restored");
  await tcw.permissionsReady();
  return { tcw, node, sessionStorage };
}

describe("grants kept across a reload, for the app that asked", () => {
  test("a non-elevated grant approved for an app is stored with that app and counts for it after a reload, for no other app", async () => {
    const env = await web(stubNode([grant("courier-read")]));
    env.privately._testHooks = { showModal: async () => ({ approved: true }) };

    const result = await env.tcw.requestPermissions([APPLICATIONS_READ], { onBehalfOf: COURIER });

    expect(result.approved).toBe(true);
    expect((await stored(env.sessionStorage)).map((g) => [g.cid, g.askedBy])).toEqual([["courier-read", [COURIER]]]);

    const after = await reload(env);
    expect(after.tcw.hasPermissions([APPLICATIONS_READ], { onBehalfOf: COURIER })).toBe(true);
    expect(after.tcw.hasPermissions([APPLICATIONS_READ], { onBehalfOf: EXPLORER })).toBe(false);
    expect(after.tcw.hasPermissions([APPLICATIONS_READ])).toBe(true);
  });

  test("a grant stored for no app counts for no framed app", async () => {
    const env = await web(stubNode([grant("page-read")]));
    env.privately._testHooks = { showModal: async () => ({ approved: true }) };
    await env.tcw.requestPermissions([APPLICATIONS_READ]);
    expect((await stored(env.sessionStorage)).map((g) => [g.cid, g.askedBy])).toEqual([["page-read", undefined]]);

    const after = await reload(env);

    expect(after.tcw.hasPermissions([APPLICATIONS_READ])).toBe(true);
    expect(after.tcw.hasPermissions([APPLICATIONS_READ], { onBehalfOf: COURIER })).toBe(false);
  });

  test("another app's grant does not satisfy the request without a prompt, and the other app gets a grant of its own", async () => {
    const node = stubNode([grant("explorer-read")]);
    const env = await web(node);
    const showModal = mock(async () => ({ approved: true }));
    env.privately._testHooks = { showModal };
    await env.tcw.requestPermissions([APPLICATIONS_READ], { onBehalfOf: EXPLORER });
    showModal.mockClear();

    // The same app asks again: covered, no prompt.
    await env.tcw.requestPermissions([APPLICATIONS_READ], { onBehalfOf: EXPLORER });
    expect(showModal).not.toHaveBeenCalled();

    // Another app asks for the same permission: it is asked, and a new grant is signed even though one covers it.
    node.installed.length = 1;
    node.grantRuntimePermissions.mockImplementationOnce(async () => {
      const own = grant("courier-read");
      node.installed.push(own);
      return [own];
    });
    await env.tcw.requestPermissions([APPLICATIONS_READ], { onBehalfOf: COURIER });
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(node.grantRuntimePermissions.mock.calls.at(-1)?.[1]).toMatchObject({ reuseExisting: false });
    expect(env.tcw.hasPermissions([APPLICATIONS_READ], { onBehalfOf: COURIER })).toBe(true);
    expect((await stored(env.sessionStorage)).map((g) => [g.cid, g.askedBy])).toEqual([
      ["explorer-read", [EXPLORER]],
      ["courier-read", [COURIER]],
    ]);
  });

  test("an elevated grant is not stored, and its request never offers the 30-day opt-out", async () => {
    for (const [entry, resource] of [[DECRYPT, DECRYPT_RESOURCE], [SECRETS_LIST, SECRETS_RESOURCE]] as const) {
      const env = await web(stubNode([grant(`elevated-${entry.service}`, [resource])]));
      const showModal = mock(async (_options: { allowSuppression?: boolean }) => ({ approved: true }));
      env.privately._testHooks = { showModal };

      expect((await env.tcw.requestPermissions([entry], { onBehalfOf: EXPLORER })).approved).toBe(true);

      expect(await stored(env.sessionStorage)).toEqual([]);
      expect(showModal.mock.calls[0]?.[0].allowSuppression).toBe(false);
    }
  });

  test("a grant that mixes an elevated entry with a non-elevated one is not stored", async () => {
    const env = await web(stubNode([grant("mixed", [APPLICATIONS_READ_RESOURCE, DECRYPT_RESOURCE])]));
    env.privately._testHooks = { showModal: async () => ({ approved: true }) };

    await env.tcw.requestPermissions([APPLICATIONS_READ, DECRYPT], { onBehalfOf: EXPLORER });

    expect(await stored(env.sessionStorage)).toEqual([]);
  });

  test("a signed grant spanning several spaces (one cid, one delegation per space) is not stored", async () => {
    const other: Resource = { ...APPLICATIONS_READ_RESOURCE, space: `tinycloud:pkh:eip155:1:${ADDRESS}:public`, path: "" };
    const env = await web(stubNode([grant("two-spaces", [APPLICATIONS_READ_RESOURCE]), grant("two-spaces", [other])]));
    env.privately._testHooks = { showModal: async () => ({ approved: true }) };

    await env.tcw.requestPermissions([APPLICATIONS_READ], { onBehalfOf: EXPLORER });

    expect(await stored(env.sessionStorage)).toEqual([]);
  });

  test("a request that the session already covers stores nothing", async () => {
    const node = stubNode();
    node.installed.push(grant("held"));
    const env = await web(node);

    expect((await env.tcw.requestPermissions([APPLICATIONS_READ])).approved).toBe(true);

    expect(await stored(env.sessionStorage)).toEqual([]);
    expect(node.grantRuntimePermissions).not.toHaveBeenCalled();
  });

  test("signed out while the prompt was open: the grant is not stored", async () => {
    const env = await web(stubNode([grant("late")]));
    env.privately._testHooks = {
      showModal: async () => {
        env.privately.signOutCount += 1;
        return { approved: true };
      },
    };

    await env.tcw.requestPermissions([APPLICATIONS_READ], { onBehalfOf: COURIER });

    expect(await stored(env.sessionStorage)).toEqual([]);
  });

  test("a stored grant keeps its own signed expiry and a restore does not extend it", async () => {
    const env = await web(stubNode([grant("short", [APPLICATIONS_READ_RESOURCE], 90 * 60_000)]));
    env.privately._testHooks = { showModal: async () => ({ approved: true }) };
    await env.tcw.requestPermissions([APPLICATIONS_READ], { onBehalfOf: COURIER });
    const [before] = await stored(env.sessionStorage);

    const after = await reload(env);

    const [kept] = await stored(after.sessionStorage);
    expect(kept?.expiry.getTime()).toBe(before!.expiry.getTime());
    expect(after.node.installed.map((g) => g.cid)).toEqual(["short"]);
  });
});

describe("restore refuses a stored grant that is no longer one that is kept", () => {
  test("a stored grant whose signed permissions are elevated is not activated, and is removed", async () => {
    const env = await web();
    const planted = grant("planted", [APPLICATIONS_READ_RESOURCE]);
    await env.sessionStorage.saveRuntimeGrants(ADDRESS, [{ ...planted, askedBy: [EXPLORER] } as Stored]);
    const node = stubNode();
    // The signed bytes say the grant also reaches the secrets space; the stored (unsigned) fields do not.
    node.verifySessionGrant.mockImplementation(() => ({
      recap: [APPLICATIONS_READ_RESOURCE, SECRETS_RESOURCE].map((r) => ({ ...r, caveats: [] })),
      expiresAt: planted.expiry,
    }));

    const after = await reload(env, node);

    expect(after.node.installed).toEqual([]);
    expect(await stored(after.sessionStorage)).toEqual([]);
    expect(after.tcw.hasPermissions([APPLICATIONS_READ], { onBehalfOf: EXPLORER })).toBe(false);
  });

  test("a stored grant for another owner's space is not activated", async () => {
    const env = await web();
    const foreign = grant("foreign", [{ ...APPLICATIONS_READ_RESOURCE, space: "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000aa:account" }]);
    await env.sessionStorage.saveRuntimeGrants(ADDRESS, [foreign]);

    const after = await reload(env);

    expect(after.node.installed).toEqual([]);
    expect(await stored(after.sessionStorage)).toEqual([]);
  });

  test("permissionsReady waits for the stored grants to be active again", async () => {
    const env = await web();
    const own = grant("own");
    await env.sessionStorage.saveRuntimeGrants(ADDRESS, [{ ...own, askedBy: [COURIER] } as Stored]);
    const node = stubNode();
    node.know(own);
    const release = Promise.withResolvers<void>();
    node.useRuntimeDelegation.mockImplementation(async (delegation: PortableDelegation) => {
      await release.promise;
      node.installed.push(delegation);
    });
    const sessionStorage = new BrowserSessionStorage({ storage: env.backing });
    const tcw = new TinyCloudWeb({ sessionStorage, ui: false, manifest: MANIFEST });
    const state = tcw as unknown as Record<string, unknown>;
    await (state._initPromise as Promise<unknown>);
    state._node = node;
    state._initPromise = Promise.resolve();
    expect((await tcw.restoreSession(ADDRESS)).status).toBe("restored");

    let ready = false;
    const waiting = tcw.permissionsReady().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    release.resolve();
    await waiting;

    expect(tcw.hasPermissions([APPLICATIONS_READ], { onBehalfOf: COURIER })).toBe(true);
  });
});
