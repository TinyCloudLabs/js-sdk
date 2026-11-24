import { describe, expect, it, mock } from "bun:test";
import type { ISecretsService, Manifest, SecretEntry } from "@tinycloud/sdk-core";

import { NodeSecretsService } from "./NodeSecretsService";

const ENTRY: SecretEntry = {
  value: "seed",
  type: "totp",
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:00.000Z",
};

function baseWithEntry() {
  const getEntry = mock(async () => ({ ok: true as const, data: ENTRY }));
  const base = {
    vault: {},
    isUnlocked: true,
    unlock: mock(async () => ({ ok: true, data: undefined })),
    lock: mock(() => {}),
    getEntry,
  } as unknown as ISecretsService;
  return { base, getEntry };
}

const manifest: Manifest = {
  app_id: "com.food.app",
  name: "Food",
  defaults: false,
  secrets: { GITHUB_TOTP: true },
};

describe("NodeSecretsService.getEntry", () => {
  it("asks for the same read permission as get, then returns the typed entry", async () => {
    const { base, getEntry } = baseWithEntry();
    const grantPermissions = mock(async () => {});
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: () => manifest,
      grantPermissions,
      canEscalate: () => true,
      getEncryptionNetworkId: () =>
        "urn:tinycloud:encryption:did:key:z6MkPrincipal:default",
    });

    const background = await secrets.getEntry("GITHUB_TOTP", { scope: "food" });
    expect(background.ok ? undefined : background.error.code).toBe("DECRYPT_DENIED");
    expect(grantPermissions).not.toHaveBeenCalled();
    expect(getEntry).not.toHaveBeenCalled();

    const result = await secrets.getEntry("GITHUB_TOTP", { scope: "food", requestPermission: true });

    expect(result).toEqual({ ok: true, data: ENTRY });
    expect(getEntry).toHaveBeenCalledWith("GITHUB_TOTP", { scope: "food", requestPermission: true });
    expect(grantPermissions).toHaveBeenCalledTimes(1);
    expect(grantPermissions.mock.calls[0]).toEqual([[
      { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/scoped/food/GITHUB_TOTP", actions: ["get"], skipPrefix: true },
      { service: "tinycloud.encryption", path: "urn:tinycloud:encryption:did:key:z6MkPrincipal:default/secrets/scoped/food/github_totp", actions: ["decrypt"], skipPrefix: true },
    ]]);
  });
});
