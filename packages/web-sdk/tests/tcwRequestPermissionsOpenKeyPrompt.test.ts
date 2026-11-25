/*
 * TinyCloudWeb.requestPermissions when OpenKey signs the grant: OpenKey's own approval replaces the SDK's "additional
 * permissions" prompt, and the app's name reaches it as a display-only presentation on the sign request. A signer that is
 * not OpenKey (a wallet, including OpenKey injected as a wallet without `openkey` configured, or a custom signer that did
 * not declare itself OpenKey) keeps the SDK prompt, with its 30-day option as for any other signer.
 */
import "./support/browserGlobalsShim";
import { describe, expect, mock, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import type { RuntimePermissionGrantOptions } from "@tinycloud/node-sdk/core";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";
import { openKeySignPresentation } from "../src/modules/openKeySignPresentation";

const { TinyCloudWeb } = require("../src/modules/tcw") as { TinyCloudWeb: typeof TinyCloudWebType };

const ICON = "data:image/png;base64,iVBORw0KGgo=";
const MANIFEST = { app_id: "com.test.app", name: "Test App", icon: ICON, permissions: [] };
const ENTRY: PermissionEntry = { service: "tinycloud.delegation", space: "applications", path: "", actions: ["list"] };
const SIWE = "prepared-siwe";
const ALICE = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
const CONNECTED = { address: ALICE, keyId: "key-1", keyType: "MANAGED" };

type SignRequest = { message: string; keyId: string; presentation?: unknown };

function node() {
  const personalSign = mock(async (_message: string): Promise<string> => "0xwallet");
  const grantRuntimePermissions = mock(async (_entries: PermissionEntry[], options?: RuntimePermissionGrantOptions) => {
    await (options?.signMessage ?? personalSign)(SIWE);
    return [];
  });
  return { address: ALICE, personalSign, grantRuntimePermissions, hasRuntimePermissions: () => false };
}

function web(stub: ReturnType<typeof node>, config: Record<string, unknown>) {
  const showModal = mock(async (_options: { allowSuppression?: boolean; onBehalfOf?: string }) => ({ approved: true }));
  const tcw = Object.create(TinyCloudWeb.prototype) as TinyCloudWebType;
  // `session` is an arrow property set in the constructor, which Object.create skips.
  Object.assign(tcw, {
    session: () => undefined,
    config,
    signOutCount: 0,
    signOutInFlight: 0,
    grantAskers: new WeakMap(),
    _manifest: MANIFEST,
    _node: stub,
    _testHooks: { showModal },
  });
  return { tcw, showModal };
}

function openKeyConfig(marker: number | undefined, showsApproval: boolean | "unreported" = true) {
  const signMessage = mock(async (_request: SignRequest, _opts?: { mode?: string }) => ({ signature: "0xopenkey" }));
  const client = {
    authorizeTinyCloud: mock(),
    signMessage,
    lastAuth: CONNECTED,
    signMessagePresentation: marker,
    signMessageShowsApproval: showsApproval === "unreported" ? undefined : showsApproval,
  };
  return { signMessage, config: { openkey: { client } } };
}

describe("an OpenKey client that accepts a presentation", () => {
  test("shows no SDK prompt and sends the app's name and the framed app's name with the sign request", async () => {
    const { signMessage, config } = openKeyConfig(1);
    const { tcw, showModal } = web(node(), config);

    const result = await tcw.requestPermissions([ENTRY], { onBehalfOf: "Account" });

    expect(result.approved).toBe(true);
    expect(showModal).not.toHaveBeenCalled();
    expect(signMessage).toHaveBeenCalledWith(
      { message: SIWE, keyId: "key-1", presentation: { protocolVersion: 1, displayName: "Test App", onBehalfOf: "Account", iconUrl: ICON } },
      { mode: "popup" },
    );
  });

  test("the presentation names no framed app when the request has none", async () => {
    const { signMessage, config } = openKeyConfig(1);
    const { tcw } = web(node(), config);

    await tcw.requestPermissions([ENTRY]);

    const request = signMessage.mock.calls[0]![0];
    expect(request.presentation).toEqual({ protocolVersion: 1, displayName: "Test App", iconUrl: ICON });
  });

  test("the signed message is the grant's message, byte for byte", async () => {
    const { signMessage, config } = openKeyConfig(1);
    const { tcw } = web(node(), config);

    await tcw.requestPermissions([ENTRY]);

    expect(signMessage.mock.calls[0]![0].message).toBe(SIWE);
  });
});

describe("an OpenKey client that does not accept a presentation", () => {
  test("shows no SDK prompt and sends the sign request without a presentation", async () => {
    const { signMessage, config } = openKeyConfig(undefined);
    const { tcw, showModal } = web(node(), config);

    await tcw.requestPermissions([ENTRY]);

    expect(showModal).not.toHaveBeenCalled();
    expect(signMessage).toHaveBeenCalledWith({ message: SIWE, keyId: "key-1" }, { mode: "popup" });
  });

  test("a caller's allowPromptSuppression: false shows no SDK prompt either", async () => {
    const { config } = openKeyConfig(undefined);
    const { tcw, showModal } = web(node(), config);

    await tcw.requestPermissions([ENTRY], { allowPromptSuppression: false });

    expect(showModal).not.toHaveBeenCalled();
  });
});

describe("an OpenKey client whose connected key signs in an external wallet", () => {
  test("shows no SDK prompt: OpenKey's own screen is the only one", async () => {
    const { config } = openKeyConfig(1, false);
    const { tcw, showModal } = web(node(), config);

    await tcw.requestPermissions([ENTRY]);

    expect(showModal).not.toHaveBeenCalled();
  });

  test("shows no SDK prompt when the client does not say whether its approval shows the request", async () => {
    const { config } = openKeyConfig(1, "unreported");
    const { tcw, showModal } = web(node(), config);

    await tcw.requestPermissions([ENTRY]);

    expect(showModal).not.toHaveBeenCalled();
  });
});

describe("a wallet session", () => {
  test("keeps the SDK prompt with its 30-day option", async () => {
    const stub = node();
    const { tcw, showModal } = web(stub, {});

    await tcw.requestPermissions([ENTRY]);

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(showModal.mock.calls[0]![0].allowSuppression).toBeUndefined();
    expect(stub.personalSign).toHaveBeenCalledTimes(1);
  });
});

describe("OpenKey injected as an EIP-1193 wallet, without `openkey` configured", () => {
  test("keeps the SDK prompt, because the SDK cannot tell the wallet is OpenKey (known gap, TC-4343)", async () => {
    const stub = node();
    const { tcw, showModal } = web(stub, {});

    await tcw.requestPermissions([ENTRY]);

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(stub.personalSign).toHaveBeenCalledTimes(1);
  });
});

describe("a runtime permission signer", () => {
  test("declared as OpenKey: no SDK prompt, and the signer receives the presentation", async () => {
    const { tcw, showModal } = web(node(), {});
    const signMessage = mock(async (_message: string, _presentation?: unknown) => "0xapp");
    tcw.setRuntimePermissionSigner({ signMessage }, { openKey: true });

    await tcw.requestPermissions([ENTRY], { onBehalfOf: "Account" });

    expect(showModal).not.toHaveBeenCalled();
    expect(signMessage).toHaveBeenCalledWith(SIWE, { protocolVersion: 1, displayName: "Test App", onBehalfOf: "Account", iconUrl: ICON });
  });

  test("not declared as OpenKey: the SDK prompt keeps its 30-day option and the signer receives the message alone", async () => {
    const { tcw, showModal } = web(node(), {});
    const signMessage = mock(async (_message: string) => "0xapp");
    tcw.setRuntimePermissionSigner({ signMessage });

    await tcw.requestPermissions([ENTRY], { onBehalfOf: "Account" });

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(showModal.mock.calls[0]![0].allowSuppression).toBeUndefined();
    expect(signMessage.mock.calls[0]).toEqual([SIWE]);
  });
});

describe("the presentation's icon", () => {
  test("is sent only as a small png, jpeg or webp data URI", () => {
    for (const type of ["png", "jpeg", "webp"]) {
      const icon = `data:image/${type};base64,AAAA`;
      expect(openKeySignPresentation({ name: "App", icon }, undefined).iconUrl).toBe(icon);
    }
  });

  test("is left out for a web address, another image type, or an icon over 32 KB", () => {
    for (const icon of ["https://example.com/icon.png", "data:image/svg+xml;base64,AAAA", `data:image/png;base64,${"A".repeat(32 * 1024)}`]) {
      expect(openKeySignPresentation({ name: "App", icon }, undefined)).toEqual({ protocolVersion: 1, displayName: "App" });
    }
  });

  test("is left out when the manifest's icon is not a string", () => {
    const icon = ["data:image/png;base64,AAAA"] as unknown as string;
    expect(openKeySignPresentation({ name: "App", icon }, undefined)).toEqual({ protocolVersion: 1, displayName: "App" });
  });
});
