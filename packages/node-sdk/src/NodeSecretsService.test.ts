import { describe, expect, it, mock } from "bun:test";
import {
  ErrorCodes,
  type ISecretsService,
  type Manifest,
  type PermissionEntry,
} from "@tinycloud/sdk-core";

import { NodeSecretsService } from "./NodeSecretsService";

function makeBaseSecrets(): ISecretsService {
  return {
    vault: {} as ISecretsService["vault"],
    isUnlocked: true,
    unlock: mock(async () => ({ ok: true, data: undefined })),
    lock: mock(() => {}),
    get: mock(async () => ({ ok: true, data: "stored" })),
    put: mock(async () => ({ ok: true, data: undefined })),
    delete: mock(async () => ({ ok: true, data: undefined })),
    list: mock(async () => ({ ok: true, data: ["ANTHROPIC_API_KEY"] })),
  };
}

function readOnlyManifest(): Manifest {
  return {
    app_id: "com.food.app",
    name: "Food",
    defaults: false,
    secrets: {
      ANTHROPIC_API_KEY: true,
    },
  };
}

describe("NodeSecretsService", () => {
  it("does not autosign reads", async () => {
    const base = makeBaseSecrets();
    const grantPermissions = mock(async () => {});
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      grantPermissions,
      canEscalate: () => true,
    });

    const result = await secrets.get("ANTHROPIC_API_KEY");

    expect(result).toEqual({ ok: true, data: "stored" });
    expect(grantPermissions).not.toHaveBeenCalled();
  });

  it("grants write permission before putting a read-only manifest secret", async () => {
    const base = makeBaseSecrets();
    const grantPermissions = mock(async () => {});
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      grantPermissions,
      canEscalate: () => true,
    });

    const result = await secrets.put("ANTHROPIC_API_KEY", "secret");

    expect(result.ok).toBe(true);
    expect(grantPermissions).toHaveBeenCalledWith([
      {
        service: "tinycloud.vault",
        space: "secrets",
        path: "secrets/ANTHROPIC_API_KEY",
        actions: ["write"],
        skipPrefix: true,
      },
    ] satisfies PermissionEntry[]);
    expect(base.put).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "secret");
  });

  it("grants scoped write permission before putting a scoped secret", async () => {
    const base = makeBaseSecrets();
    const grantPermissions = mock(async () => {});
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      grantPermissions,
      canEscalate: () => true,
    });

    const result = await secrets.put(
      "ANTHROPIC_API_KEY",
      "secret",
      { scope: "Food Tracker" },
    );

    expect(result.ok).toBe(true);
    expect(grantPermissions).toHaveBeenCalledWith([
      {
        service: "tinycloud.vault",
        space: "secrets",
        path: "secrets/scoped/food-tracker/ANTHROPIC_API_KEY",
        actions: ["write"],
        skipPrefix: true,
      },
    ] satisfies PermissionEntry[]);
    expect(base.put).toHaveBeenCalledWith(
      "ANTHROPIC_API_KEY",
      "secret",
      { scope: "Food Tracker" },
    );
  });

  it("skips autosign when the manifest already includes the mutation action", async () => {
    const base = makeBaseSecrets();
    const grantPermissions = mock(async () => {});
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: () => ({
        ...readOnlyManifest(),
        secrets: {
          ANTHROPIC_API_KEY: ["read", "delete"],
        },
      }),
      grantPermissions,
      canEscalate: () => true,
    });

    const result = await secrets.delete("ANTHROPIC_API_KEY");

    expect(result.ok).toBe(true);
    expect(grantPermissions).not.toHaveBeenCalled();
    expect(base.delete).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
  });

  it("skips autosign when the manifest includes the scoped mutation action", async () => {
    const base = makeBaseSecrets();
    const grantPermissions = mock(async () => {});
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: () => ({
        ...readOnlyManifest(),
        secrets: {
          FOOD_TRACKER_ANTHROPIC_API_KEY: {
            scope: "food-tracker",
            name: "ANTHROPIC_API_KEY",
            actions: ["read", "delete"],
          },
        },
      }),
      grantPermissions,
      canEscalate: () => true,
    });

    const result = await secrets.delete(
      "ANTHROPIC_API_KEY",
      { scope: "food-tracker" },
    );

    expect(result.ok).toBe(true);
    expect(grantPermissions).not.toHaveBeenCalled();
    expect(base.delete).toHaveBeenCalledWith(
      "ANTHROPIC_API_KEY",
      { scope: "food-tracker" },
    );
  });

  it("re-unlocks after autosign when already unlocked", async () => {
    const base = makeBaseSecrets();
    const signer = { signMessage: async () => "0xsig" };
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      grantPermissions: mock(async () => {}),
      canEscalate: () => true,
    });

    await secrets.unlock(signer);
    const result = await secrets.put("ANTHROPIC_API_KEY", "secret");

    expect(result.ok).toBe(true);
    expect(base.unlock).toHaveBeenCalledTimes(2);
    expect(base.unlock).toHaveBeenLastCalledWith(signer);
    expect(base.put).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "secret");
  });

  it("uses the configured signer when unlock is called without one", async () => {
    const base = makeBaseSecrets();
    const signer = { signMessage: async () => "0xsig" };
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      grantPermissions: mock(async () => {}),
      canEscalate: () => true,
      getUnlockSigner: () => signer,
    });

    const result = await secrets.unlock();

    expect(result.ok).toBe(true);
    expect(base.unlock).toHaveBeenCalledWith(signer);
  });

  it("returns a permission error when autosign is unavailable", async () => {
    const base = makeBaseSecrets();
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      grantPermissions: mock(async () => {}),
      canEscalate: () => false,
    });

    const result = await secrets.put("ANTHROPIC_API_KEY", "secret");

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.PERMISSION_DENIED,
        service: "secrets",
        message:
          "Cannot autosign tinycloud.vault/write for ANTHROPIC_API_KEY; TinyCloudNode needs wallet mode with a signer or privateKey.",
      },
    });
    expect(base.put).not.toHaveBeenCalled();
  });
});
