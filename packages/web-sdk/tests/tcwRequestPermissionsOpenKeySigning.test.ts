/*
 * TinyCloudWeb.requestPermissions on an OpenKey session: the runtime grant's SIWE is signed through the OpenKey client
 * the session was established with, never through the wallet provider's `personal_sign` (which an OpenKey session's
 * provider does not implement). A session without an OpenKey client signs through the connected wallet as before.
 */
import "./support/browserGlobalsShim";
import { describe, expect, mock, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import type { RuntimePermissionGrantOptions } from "@tinycloud/node-sdk/core";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../src/modules/tcw") as { TinyCloudWeb: typeof TinyCloudWebType };

const MANIFEST = { app_id: "com.test.app", name: "Test App", icon: "https://example.com/icon.png", permissions: [] };
const ENTRY: PermissionEntry = { service: "tinycloud.delegation", space: "applications", path: "", actions: ["list"] };
const SIWE = "prepared-siwe";

function unsupportedPersonalSign(): Error {
  return Object.assign(new Error("Unsupported wallet method: personal_sign"), { name: "UnsupportedMethodError" });
}

/** A node whose grant signs the way the real one does: with `options.signMessage` when given, else the provider. */
function node() {
  const personalSign = mock(async (): Promise<string> => {
    throw unsupportedPersonalSign();
  });
  const signatures: string[] = [];
  const grantRuntimePermissions = mock(async (_entries: PermissionEntry[], options?: RuntimePermissionGrantOptions) => {
    signatures.push(await (options?.signMessage ?? personalSign)(SIWE));
    return [];
  });
  return { personalSign, signatures, grantRuntimePermissions, hasRuntimePermissions: () => false };
}

function web(stub: ReturnType<typeof node>, config: Record<string, unknown>): TinyCloudWebType {
  const tcw = Object.create(TinyCloudWeb.prototype) as TinyCloudWebType;
  // `session` is an arrow property set in the constructor, which Object.create skips.
  Object.assign(tcw, {
    session: () => undefined,
    config,
    _manifest: MANIFEST,
    _node: stub,
    _testHooks: { showModal: async () => ({ approved: true }) },
  });
  return tcw;
}

describe("TinyCloudWeb.requestPermissions signing", () => {
  test("an OpenKey session signs through the OpenKey client and never calls personal_sign", async () => {
    const stub = node();
    const signMessage = mock(async (_request: { message: string }, _opts?: { mode?: string }) => ({ signature: "0xopenkey" }));
    const tcw = web(stub, { openkey: { client: { authorizeTinyCloud: mock(), signMessage }, mode: "iframe" } });

    const result = await tcw.requestPermissions([ENTRY], { expiryMs: 1000 });

    expect(result.approved).toBe(true);
    expect(signMessage).toHaveBeenCalledWith({ message: SIWE }, { mode: "iframe" });
    expect(stub.personalSign).not.toHaveBeenCalled();
    expect(stub.signatures).toEqual(["0xopenkey"]);
    expect(stub.grantRuntimePermissions.mock.calls[0]?.[1]).toMatchObject({ expiry: 1000 });
  });

  test("the OpenKey client signs in popup mode unless the session was configured otherwise", async () => {
    const stub = node();
    const signMessage = mock(async (_request: { message: string }, _opts?: { mode?: string }) => ({ signature: "0xopenkey" }));
    const tcw = web(stub, { openkey: { client: { authorizeTinyCloud: mock(), signMessage } } });

    await tcw.requestPermissions([ENTRY]);

    expect(signMessage).toHaveBeenCalledWith({ message: SIWE }, { mode: "popup" });
  });

  test("a session without an OpenKey client signs through the connected wallet", async () => {
    const stub = node();
    const tcw = web(stub, {});

    await expect(tcw.requestPermissions([ENTRY])).rejects.toMatchObject({ name: "UnsupportedMethodError" });

    expect(stub.personalSign).toHaveBeenCalledTimes(1);
    expect(stub.grantRuntimePermissions).toHaveBeenCalledWith([ENTRY], undefined);
  });

  test("an OpenKey client that cannot sign a message leaves signing to the connected wallet", async () => {
    const stub = node();
    const tcw = web(stub, { openkey: { client: { authorizeTinyCloud: mock() } } });

    await expect(tcw.requestPermissions([ENTRY])).rejects.toMatchObject({ name: "UnsupportedMethodError" });

    expect(stub.grantRuntimePermissions).toHaveBeenCalledWith([ENTRY], undefined);
  });
});
