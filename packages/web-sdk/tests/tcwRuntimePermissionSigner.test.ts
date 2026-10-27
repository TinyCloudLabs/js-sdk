/*
 * TinyCloudWeb.setRuntimePermissionSigner: the signer signs runtime permission grants only. It is bound to the session
 * it was set for: sign-out, a new sign-in, a restore, or a session for another account clear it. The node is a stub
 * that signs a grant the way the real one does (the caller's `signMessage`, else the wallet's `personal_sign`).
 */
import "./support/browserGlobalsShim";
import { describe, expect, mock, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import type { RuntimePermissionGrantOptions } from "@tinycloud/node-sdk/core";

import { BrowserSessionStorage } from "../src/adapters/BrowserSessionStorage";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../src/modules/tcw") as { TinyCloudWeb: typeof TinyCloudWebType };

const ALICE = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
const BOB = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const MANIFEST = { app_id: "com.test.app", name: "Test App", icon: "https://example.com/icon.png", permissions: [] };
const ENTRY: PermissionEntry = { service: "tinycloud.delegation", space: "applications", path: "", actions: ["list"] };
const SIWE = "prepared-siwe";

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

function recordingSigner(signature: string) {
  return { signMessage: mock(async (_message: string) => signature) };
}

async function web(options: { covered?: boolean } = {}) {
  const walletSign = mock(async (_message: string) => "0xwallet");
  const signatures: string[] = [];
  const node = {
    address: ALICE as string | undefined,
    isSessionOnly: false,
    session: { address: ALICE, chainId: 1, sessionKey: "k", siwe: "s", signature: "g" },
    hasRuntimePermissions: () => options.covered === true,
    getRuntimePermissionDelegations: () => [],
    grantRuntimePermissions: mock(async (_entries: PermissionEntry[], grant?: RuntimePermissionGrantOptions) => {
      signatures.push(await (grant?.signMessage ?? walletSign)(SIWE));
      return [];
    }),
    signOut: mock(async () => undefined),
  };
  const tcw = new TinyCloudWeb({ sessionStorage: new BrowserSessionStorage({ storage: new MemoryStorage() }), ui: false, manifest: MANIFEST });
  const state = tcw as unknown as Record<string, unknown>;
  await (state._initPromise as Promise<unknown>);
  state._node = node;
  state._initPromise = Promise.resolve();
  state._testHooks = { showModal: async () => ({ approved: true }) };
  return { tcw, node, walletSign, signatures };
}

describe("setRuntimePermissionSigner", () => {
  test("a set signer signs the grant and the wallet is never asked", async () => {
    const { tcw, walletSign, signatures } = await web();
    const signer = recordingSigner("0xapp");
    tcw.setRuntimePermissionSigner(signer);

    await tcw.requestPermissions([ENTRY]);

    expect(signer.signMessage).toHaveBeenCalledWith(SIWE);
    expect(walletSign).not.toHaveBeenCalled();
    expect(signatures).toEqual(["0xapp"]);
  });

  test("it takes precedence over an OpenKey client", async () => {
    const { tcw, signatures } = await web();
    const openkeySign = mock(async () => ({ signature: "0xopenkey" }));
    (tcw as unknown as { config: Record<string, unknown> }).config.openkey = { client: { authorizeTinyCloud: mock(), signMessage: openkeySign } };
    tcw.setRuntimePermissionSigner(recordingSigner("0xapp"));

    await tcw.requestPermissions([ENTRY]);

    expect(openkeySign).not.toHaveBeenCalled();
    expect(signatures).toEqual(["0xapp"]);
  });

  test("a permission the session already holds does not use the signer", async () => {
    const { tcw } = await web({ covered: true });
    const signer = recordingSigner("0xapp");
    tcw.setRuntimePermissionSigner(signer);

    await tcw.requestPermissions([ENTRY]);

    expect(signer.signMessage).not.toHaveBeenCalled();
  });

  test("clearing it returns signing to the wallet", async () => {
    const { tcw, signatures } = await web();
    const signer = recordingSigner("0xapp");
    tcw.setRuntimePermissionSigner(signer);
    tcw.setRuntimePermissionSigner(undefined);

    await tcw.requestPermissions([ENTRY]);

    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signatures).toEqual(["0xwallet"]);
  });

  test("it needs a session", async () => {
    const { tcw, node } = await web();
    node.address = undefined;

    expect(() => tcw.setRuntimePermissionSigner(recordingSigner("0xapp"))).toThrow("signed-in session");
  });

  test("sign-out clears it", async () => {
    const { tcw, signatures } = await web();
    const signer = recordingSigner("0xapp");
    tcw.setRuntimePermissionSigner(signer);

    await tcw.signOut();
    await tcw.requestPermissions([ENTRY]);

    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signatures).toEqual(["0xwallet"]);
  });

  test("a restore clears it", async () => {
    const { tcw, signatures } = await web();
    const signer = recordingSigner("0xapp");
    tcw.setRuntimePermissionSigner(signer);

    await tcw.restoreSession().catch(() => undefined);
    await tcw.requestPermissions([ENTRY]);

    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signatures).toEqual(["0xwallet"]);
  });

  test("a new sign-in clears it and never calls it", async () => {
    const { tcw, signatures } = await web();
    const signer = recordingSigner("0xapp");
    tcw.setRuntimePermissionSigner(signer);

    await tcw.signIn().catch(() => undefined);
    await tcw.requestPermissions([ENTRY]);

    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signatures).toEqual(["0xwallet"]);
  });

  test("a session for another account does not use it, and it is cleared", async () => {
    const { tcw, node, signatures } = await web();
    const signer = recordingSigner("0xalice");
    tcw.setRuntimePermissionSigner(signer);
    node.address = BOB;

    await tcw.requestPermissions([ENTRY]);
    node.address = ALICE;
    await tcw.requestPermissions([ENTRY]);

    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signatures).toEqual(["0xwallet", "0xwallet"]);
  });
});
