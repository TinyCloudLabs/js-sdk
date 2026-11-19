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

    const result = await secrets.getEntry("GITHUB_TOTP", { scope: "food" });

    expect(result).toEqual({ ok: true, data: ENTRY });
    expect(getEntry).toHaveBeenCalledWith("GITHUB_TOTP", { scope: "food" });
    expect(grantPermissions).toHaveBeenCalledTimes(1);
  });
});
