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
    const signIn = mock(async () => {});
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      setManifest: mock(() => {}),
      signIn,
      canEscalate: () => true,
    });

    const result = await secrets.get("ANTHROPIC_API_KEY");

    expect(result).toEqual({ ok: true, data: "stored" });
    expect(signIn).not.toHaveBeenCalled();
  });

  it("autosigns write permission before putting a read-only manifest secret", async () => {
    const base = makeBaseSecrets();
    let manifest = readOnlyManifest();
    const setManifest = mock((next: Manifest | Manifest[]) => {
      manifest = Array.isArray(next) ? next[0] : next;
    });
    const signIn = mock(async () => {});
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: () => manifest,
      setManifest,
      signIn,
      canEscalate: () => true,
    });

    const result = await secrets.put("ANTHROPIC_API_KEY", "secret");

    expect(result.ok).toBe(true);
    expect(setManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: [
          {
            service: "tinycloud.kv",
            space: "secrets",
            path: "keys/secrets/ANTHROPIC_API_KEY",
            actions: ["put"],
            skipPrefix: true,
          },
          {
            service: "tinycloud.kv",
            space: "secrets",
            path: "vault/secrets/ANTHROPIC_API_KEY",
            actions: ["put"],
            skipPrefix: true,
          },
        ] satisfies PermissionEntry[],
      }),
    );
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(base.put).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "secret");
  });

  it("skips autosign when the manifest already includes the mutation action", async () => {
    const base = makeBaseSecrets();
    const signIn = mock(async () => {});
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: () => ({
        ...readOnlyManifest(),
        secrets: {
          ANTHROPIC_API_KEY: ["read", "delete"],
        },
      }),
      setManifest: mock(() => {}),
      signIn,
      canEscalate: () => true,
    });

    const result = await secrets.delete("ANTHROPIC_API_KEY");

    expect(result.ok).toBe(true);
    expect(signIn).not.toHaveBeenCalled();
    expect(base.delete).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
  });

  it("re-unlocks after autosign when already unlocked", async () => {
    const base = makeBaseSecrets();
    const signer = { signMessage: async () => "0xsig" };
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      setManifest: mock(() => {}),
      signIn: mock(async () => {}),
      canEscalate: () => true,
    });

    await secrets.unlock(signer);
    const result = await secrets.put("ANTHROPIC_API_KEY", "secret");

    expect(result.ok).toBe(true);
    expect(base.unlock).toHaveBeenCalledTimes(2);
    expect(base.unlock).toHaveBeenLastCalledWith(signer);
    expect(base.put).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "secret");
  });

  it("returns a permission error when autosign is unavailable", async () => {
    const base = makeBaseSecrets();
    const secrets = new NodeSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      setManifest: mock(() => {}),
      signIn: mock(async () => {}),
      canEscalate: () => false,
    });

    const result = await secrets.put("ANTHROPIC_API_KEY", "secret");

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.PERMISSION_DENIED,
        service: "secrets",
        message:
          "Cannot autosign tinycloud.kv/put for ANTHROPIC_API_KEY; TinyCloudNode needs wallet mode with a signer or privateKey.",
      },
    });
    expect(base.put).not.toHaveBeenCalled();
  });
});
