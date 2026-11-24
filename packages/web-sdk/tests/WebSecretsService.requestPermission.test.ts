import { describe, expect, it, mock } from "bun:test";
import type { ISecretsService, PermissionEntry } from "@tinycloud/sdk-core";

import { WebSecretsService } from "../src/modules/WebSecretsService";
import type { RequestPermissionsOptions } from "../src/modules/requestPermissionsCore";

// TC-3801: a web read with `requestPermission: true` asks this page's prompt
// for exactly the secret's own key on this space's network, once, then reads
// again; without the flag it never asks.

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:default`;
const KEY = `${NETWORK}/secrets/scoped/food/api_key`;
const DENIED = {
  ok: false as const,
  error: {
    code: "DECRYPT_DENIED",
    service: "vault",
    key: "secrets/scoped/food/API_KEY",
    message: "No live grant to decrypt API_KEY; ask for permissionHint, or read with requestPermission.",
    permissionHint: { service: "tinycloud.encryption", path: KEY, actions: ["tinycloud.encryption/decrypt"] },
  },
};
const ENTRY = { value: "v", type: "text", createdAt: "t0", updatedAt: "t0" };
/** Every secret-key ask: 1 h, and the prompt always shows. */
const SECRET_KEY_ASK: RequestPermissionsOptions = { expiryMs: 60 * 60_000, allowPromptSuppression: false };

const refusedWith = (path: string) => ({
  ...DENIED,
  error: { ...DENIED.error, permissionHint: { ...DENIED.error.permissionHint, path } },
});

/** A node that reads only once a grant on KEY was approved. */
function harness(answers: boolean[] = []) {
  let granted = false;
  const asks: PermissionEntry[][] = [];
  const askOptions: (RequestPermissionsOptions | undefined)[] = [];
  const read = <T>(data: T) => mock(async (_name: string, _options?: unknown) => (granted ? { ok: true as const, data } : DENIED));
  const base = {
    vault: {},
    isUnlocked: true,
    unlock: mock(async () => ({ ok: true, data: undefined })),
    lock: mock(() => {}),
    get: read("v"),
    getEntry: read(ENTRY),
  };
  const secrets = new WebSecretsService({
    getService: () => base as unknown as ISecretsService,
    getManifest: () => undefined,
    getEncryptionNetworkId: () => NETWORK,
    requestPermissions: async (entries, options) => {
      asks.push(entries);
      askOptions.push(options);
      const approved = answers.shift() ?? true;
      if (approved) granted = true;
      return { approved };
    },
  });
  return { secrets, base, asks, askOptions, grant: () => { granted = true; } };
}

/** A node whose every read is refused with `refused`; records what was asked. */
function refusingHarness(refused: unknown) {
  const asks: PermissionEntry[][] = [];
  const secrets = new WebSecretsService({
    getService: () => ({ get: mock(async () => refused) }) as unknown as ISecretsService,
    getManifest: () => undefined,
    getEncryptionNetworkId: () => NETWORK,
    requestPermissions: async (entries) => {
      asks.push(entries);
      return { approved: false };
    },
  });
  return { secrets, asks };
}

const EXACT_ASK = [[{ service: "tinycloud.encryption", path: KEY, actions: ["decrypt"], skipPrefix: true }]];

describe("WebSecretsService requestPermission (TC-3801)", () => {
  it("no grant, opted in: one ask for exactly the secret's key, then get and getEntry read", async () => {
    const { secrets, base, asks } = harness();
    expect(await secrets.get("API_KEY", { scope: "food", requestPermission: true })).toEqual({ ok: true, data: "v" });
    expect(asks).toEqual(EXACT_ASK);
    // The node reads without the flag both times: the ask is this page's.
    expect(base.get.mock.calls).toEqual([["API_KEY", { scope: "food" }], ["API_KEY", { scope: "food" }]]);

    const fresh = harness();
    expect(await fresh.secrets.getEntry("API_KEY", { scope: "food", requestPermission: true })).toEqual({ ok: true, data: ENTRY });
    expect(fresh.asks).toEqual(EXACT_ASK);
  });

  it("the ask is for one hour and always shows the prompt, so a 30-day opt-out cannot grant a secret's key silently", async () => {
    const { secrets, askOptions } = harness();
    await secrets.get("API_KEY", { scope: "food", requestPermission: true });
    const fresh = harness();
    await fresh.secrets.getEntry("API_KEY", { scope: "food", requestPermission: true });
    expect([...askOptions, ...fresh.askOptions]).toEqual([SECRET_KEY_ASK, SECRET_KEY_ASK]);
  });

  it("no flag: DECRYPT_DENIED and no ask", async () => {
    const { secrets, base, asks } = harness();
    expect(await secrets.get("API_KEY", { scope: "food" })).toEqual(DENIED);
    expect(await secrets.getEntry("API_KEY", { scope: "food" })).toEqual(DENIED);
    expect(asks).toEqual([]);
    expect(base.get).toHaveBeenCalledWith("API_KEY", { scope: "food" });
  });

  it("grant already held: no ask", async () => {
    const { secrets, asks, grant } = harness();
    grant();
    expect(await secrets.get("API_KEY", { scope: "food", requestPermission: true })).toEqual({ ok: true, data: "v" });
    expect(asks).toEqual([]);
  });

  it("a declined ask is PERMISSION_DENIED, and the next opted-in read asks again", async () => {
    const { secrets, asks } = harness([false, true]);
    expect(await secrets.get("API_KEY", { scope: "food", requestPermission: true })).toEqual({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        service: "secrets",
        message: "Permission request for tinycloud.encryption/decrypt on API_KEY was declined.",
      },
    });
    expect(asks).toHaveLength(1);
    expect(await secrets.get("API_KEY", { scope: "food", requestPermission: true })).toEqual({ ok: true, data: "v" });
    expect(asks).toEqual([...EXACT_ASK, ...EXACT_ASK]);
  });

  it("a closed or failed prompt is PERMISSION_DENIED, and the next opted-in read asks again", async () => {
    const { base } = harness();
    let calls = 0;
    const closing = new WebSecretsService({
      getService: () => base as unknown as ISecretsService,
      getManifest: () => undefined,
      getEncryptionNetworkId: () => NETWORK,
      requestPermissions: async () => {
        calls++;
        throw new Error("modal closed");
      },
    });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await closing.get("API_KEY", { scope: "food", requestPermission: true });
      expect(result.ok ? undefined : result.error).toMatchObject({ code: "PERMISSION_DENIED", message: "modal closed" });
      expect(calls).toBe(attempt);
    }
  });

  it("asks for nothing when the refusal names any key but this secret's own", async () => {
    for (const path of [NETWORK, `${NETWORK}/secrets/scoped/food/other_key`, `${NETWORK}/secrets/`, `x/secrets/scoped/food/api_key`]) {
      const refused = refusedWith(path);
      const { secrets, asks } = refusingHarness(refused);
      expect(await secrets.get("API_KEY", { scope: "food", requestPermission: true })).toEqual(refused);
      expect(asks).toEqual([]);
    }
  });

  it("a hint for another owner or another network asks nothing; one differing only in address case asks for this space's key", async () => {
    const otherOwner = `urn:tinycloud:encryption:did:pkh:eip155:1:0x${"1".repeat(40)}:default/secrets/scoped/food/api_key`;
    const otherNetwork = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:other/secrets/scoped/food/api_key`;
    const otherChain = `urn:tinycloud:encryption:did:pkh:eip155:10:${ADDRESS}:default/secrets/scoped/food/api_key`;
    for (const path of [otherOwner, otherNetwork, otherChain]) {
      const refused = refusedWith(path);
      const { secrets, asks } = refusingHarness(refused);
      expect(await secrets.get("API_KEY", { scope: "food", requestPermission: true })).toEqual(refused);
      expect(asks).toEqual([]);
    }

    const lowercase = refusingHarness(refusedWith(KEY.replace(ADDRESS, ADDRESS.toLowerCase())));
    await lowercase.secrets.get("API_KEY", { scope: "food", requestPermission: true });
    expect(lowercase.asks).toEqual(EXACT_ASK);
  });

  it("with no network for this space, an opted-in read asks nothing", async () => {
    const asks: unknown[] = [];
    const secrets = new WebSecretsService({
      getService: () => ({ get: mock(async () => DENIED) }) as unknown as ISecretsService,
      getManifest: () => undefined,
      requestPermissions: async (entries) => {
        asks.push(entries);
        return { approved: true };
      },
    });
    expect(await secrets.get("API_KEY", { scope: "food", requestPermission: true })).toEqual(DENIED);
    expect(asks).toEqual([]);
  });
});
