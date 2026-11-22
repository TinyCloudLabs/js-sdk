import { describe, expect, mock, test } from "bun:test";
import type { ISecretsService, PermissionEntry } from "@tinycloud/sdk-core";

import { NodeSecretsService } from "./NodeSecretsService";

// TC-3801 (F2/F3): a secret read never asks the wallet unless the caller opts
// in; without a live grant on the secret's own key it is DECRYPT_DENIED.

const NETWORK_ID = "urn:tinycloud:encryption:did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed:default";
const KEY_HINT = { service: "tinycloud.encryption", path: `${NETWORK_ID}/secrets/api_key`, actions: ["tinycloud.encryption/decrypt"] };

function setup(held: (entry: PermissionEntry) => boolean) {
  const get = mock(async () => ({ ok: true as const, data: "stored" }));
  const grantPermissions = mock(async () => {});
  const secrets = new NodeSecretsService({
    getService: () => ({ get, getEntry: get } as unknown as ISecretsService),
    getManifest: () => undefined,
    hasPermissions: (entries) => entries.every(held),
    uncoveredEntries: (entries) => entries.filter((entry) => !held(entry)),
    grantPermissions,
    canEscalate: () => true,
    getEncryptionNetworkId: () => NETWORK_ID,
  });
  return { secrets, get, grantPermissions };
}

const kvOnly = (entry: PermissionEntry) => entry.service === "tinycloud.kv";
const kvAndNetwork = (entry: PermissionEntry) => kvOnly(entry) || entry.path === NETWORK_ID;

describe("a secret read asks only when told to", () => {
  test("no grant, no opt-in: DECRYPT_DENIED naming the key, nothing asked or read", async () => {
    const h = setup(kvOnly);
    for (const read of [() => h.secrets.get("API_KEY"), () => h.secrets.getEntry("API_KEY")]) {
      const result = await read();
      expect(result.ok ? undefined : result.error).toMatchObject({
        code: "DECRYPT_DENIED", service: "vault", key: "secrets/API_KEY", permissionHint: KEY_HINT,
      });
    }
    expect(h.grantPermissions).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });

  test("a missing KV read alone stays a plain denial", async () => {
    const h = setup((entry) => entry.service === "tinycloud.encryption");
    const result = await h.secrets.get("API_KEY");
    expect(result.ok ? undefined : result.error.code).toBe("PERMISSION_DENIED");
    expect(h.grantPermissions).not.toHaveBeenCalled();
  });

  test("requestPermission asks for exactly the missing key, then reads", async () => {
    const h = setup(kvOnly);
    expect(await h.secrets.get("API_KEY", { requestPermission: true })).toEqual({ ok: true, data: "stored" });
    expect(h.grantPermissions).toHaveBeenCalledWith([
      { service: "tinycloud.encryption", path: `${NETWORK_ID}/secrets/api_key`, actions: ["decrypt"], skipPrefix: true },
    ]);
  });

  test("a network decrypt reads without asking, unless namedKeyOnly", async () => {
    const h = setup(kvAndNetwork);
    expect(await h.secrets.get("API_KEY")).toEqual({ ok: true, data: "stored" });
    const named = await h.secrets.get("API_KEY", { namedKeyOnly: true });
    expect(named.ok ? undefined : named.error).toMatchObject({ code: "DECRYPT_DENIED", permissionHint: KEY_HINT });
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.grantPermissions).not.toHaveBeenCalled();
  });
});
