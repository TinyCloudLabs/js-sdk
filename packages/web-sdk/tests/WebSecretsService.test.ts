import { describe, expect, it, mock } from "bun:test";
import {
  ErrorCodes,
  type ISecretsService,
  type Manifest,
  type PermissionEntry,
} from "@tinycloud/sdk-core";

import { WebSecretsService } from "../src/modules/WebSecretsService";

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

describe("WebSecretsService", () => {
  it("does not escalate reads", async () => {
    const base = makeBaseSecrets();
    const requested: PermissionEntry[][] = [];
    const secrets = new WebSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      requestPermissions: async (additional) => {
        requested.push(additional);
        return { approved: true };
      },
    });

    const result = await secrets.get("ANTHROPIC_API_KEY");

    expect(result).toEqual({ ok: true, data: "stored" });
    expect(requested).toEqual([]);
  });

  it("requests write permission before putting a read-only manifest secret", async () => {
    const base = makeBaseSecrets();
    const requested: PermissionEntry[][] = [];
    const secrets = new WebSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      requestPermissions: async (additional) => {
        requested.push(additional);
        return { approved: true };
      },
    });

    const result = await secrets.put("ANTHROPIC_API_KEY", "secret");

    expect(result.ok).toBe(true);
    expect(requested).toEqual([
      [
        {
          service: "tinycloud.vault",
          space: "secrets",
          path: "secrets/ANTHROPIC_API_KEY",
          actions: ["write"],
          skipPrefix: true,
        },
      ],
    ]);
    expect(base.put).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "secret");
  });

  it("skips escalation when the manifest already includes the mutation action", async () => {
    const base = makeBaseSecrets();
    const requestPermissions = mock(async () => ({ approved: true }));
    const secrets = new WebSecretsService({
      getService: () => base,
      getManifest: () => ({
        ...readOnlyManifest(),
        secrets: {
          ANTHROPIC_API_KEY: ["read", "write"],
        },
      }),
      requestPermissions,
    });

    const result = await secrets.put("ANTHROPIC_API_KEY", "secret");

    expect(result.ok).toBe(true);
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(base.put).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "secret");
  });

  it("re-unlocks after approved escalation when already unlocked", async () => {
    const base = makeBaseSecrets();
    const signer = { signMessage: async () => "0xsig" };
    const secrets = new WebSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      requestPermissions: async () => ({ approved: true }),
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
    const secrets = new WebSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      requestPermissions: async () => ({ approved: true }),
      getUnlockSigner: () => signer,
    });

    const result = await secrets.unlock();

    expect(result.ok).toBe(true);
    expect(base.unlock).toHaveBeenCalledWith(signer);
  });

  it("returns a permission error when delete escalation is declined", async () => {
    const base = makeBaseSecrets();
    const secrets = new WebSecretsService({
      getService: () => base,
      getManifest: readOnlyManifest,
      requestPermissions: async () => ({ approved: false }),
    });

    const result = await secrets.delete("ANTHROPIC_API_KEY");

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.PERMISSION_DENIED,
        service: "secrets",
        message:
          "Permission request for tinycloud.vault/delete on ANTHROPIC_API_KEY was declined.",
      },
    });
    expect(base.delete).not.toHaveBeenCalled();
  });
});
