import { describe, expect, it, mock } from "bun:test";

import type { Result } from "../types";
import type { IDataVaultService } from "../vault/IDataVaultService";
import type {
  VaultEntry,
  VaultError,
  VaultGetOptions,
  VaultGrantOptions,
  VaultListOptions,
  VaultPutOptions,
} from "../vault/types";
import { SecretsService } from "./index";

class MockVault implements IDataVaultService {
  readonly config = {};
  isUnlocked = false;
  publicKey = new Uint8Array([1, 2, 3]);
  unlock = mock(async () => {
    this.isUnlocked = true;
    return { ok: true, data: undefined } as Result<void, VaultError>;
  });
  clearCache = mock(async () => {});
  lock = mock(() => {
    this.isUnlocked = false;
  });
  put = mock(
    async (
      _key: string,
      _value: unknown,
      _options?: VaultPutOptions,
    ): Promise<Result<void, VaultError>> => ({ ok: true, data: undefined }),
  );
  get = mock(
    async <T = unknown>(
      _key: string,
      _options?: VaultGetOptions<T>,
    ): Promise<Result<VaultEntry<T>, VaultError>> => ({
      ok: true,
      data: {
        value: {
          value: "stored-value",
          createdAt: "2026-05-04T00:00:00.000Z",
          updatedAt: "2026-05-04T00:00:00.000Z",
        } as T,
        metadata: {},
        keyId: "key",
      },
    }),
  );
  delete = mock(
    async (_key: string): Promise<Result<void, VaultError>> => ({
      ok: true,
      data: undefined,
    }),
  );
  list = mock(
    async (_options?: VaultListOptions): Promise<Result<string[], VaultError>> => ({
      ok: true,
      data: ["ANTHROPIC_API_KEY", "invalid-name"],
    }),
  );
  head = mock(async (): Promise<Result<Record<string, string>, VaultError>> => ({
    ok: true,
    data: {},
  }));
  putMany = mock(async () => []);
  getMany = mock(async () => []);
  grant = mock(
    async (
      _key: string,
      _recipientDID: string,
      _options?: VaultGrantOptions,
    ): Promise<Result<void, VaultError>> => ({ ok: true, data: undefined }),
  );
  reencrypt = this.grant;
  revoke = this.grant;
  listGrants = mock(async (): Promise<Result<string[], VaultError>> => ({
    ok: true,
    data: [],
  }));
  getShared = this.get;
  resolvePublicKey = mock(
    async (): Promise<Result<Uint8Array, VaultError>> => ({
      ok: true,
      data: new Uint8Array([1]),
    }),
  );
  initialize = mock(() => {});
  onSessionChange = mock(() => {});
  onSignOut = mock(() => {});
}

describe("SecretsService", () => {
  it("maps put/get/delete to secrets vault keys", async () => {
    const vault = new MockVault();
    const secrets = new SecretsService(vault);

    const putResult = await secrets.put("ANTHROPIC_API_KEY", "secret");
    expect(putResult.ok).toBe(true);
    expect(vault.put).toHaveBeenCalledWith(
      "secrets/ANTHROPIC_API_KEY",
      expect.objectContaining({
        value: "secret",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      }),
    );

    const getResult = await secrets.get("ANTHROPIC_API_KEY");
    expect(getResult).toEqual({ ok: true, data: "stored-value" });
    expect(vault.get).toHaveBeenCalledWith("secrets/ANTHROPIC_API_KEY");

    const deleteResult = await secrets.delete("ANTHROPIC_API_KEY");
    expect(deleteResult.ok).toBe(true);
    expect(vault.delete).toHaveBeenCalledWith("secrets/ANTHROPIC_API_KEY");
  });

  it("maps scoped operations to canonical scoped vault keys", async () => {
    const vault = new MockVault();
    const secrets = new SecretsService(vault);

    const options = { scope: "Food Tracker" };
    const putResult = await secrets.put("ANTHROPIC_API_KEY", "secret", options);
    expect(putResult.ok).toBe(true);
    expect(vault.put).toHaveBeenCalledWith(
      "secrets/scoped/food-tracker/ANTHROPIC_API_KEY",
      expect.objectContaining({ value: "secret" }),
    );

    const getResult = await secrets.get("ANTHROPIC_API_KEY", options);
    expect(getResult).toEqual({ ok: true, data: "stored-value" });
    expect(vault.get).toHaveBeenCalledWith(
      "secrets/scoped/food-tracker/ANTHROPIC_API_KEY",
    );

    const deleteResult = await secrets.delete("ANTHROPIC_API_KEY", options);
    expect(deleteResult.ok).toBe(true);
    expect(vault.delete).toHaveBeenCalledWith(
      "secrets/scoped/food-tracker/ANTHROPIC_API_KEY",
    );
  });

  it("validates env-style names before calling the vault", async () => {
    const vault = new MockVault();
    const secrets = new SecretsService(vault);

    const result = await secrets.put("anthropic_api_key", "secret");

    expect(result.ok).toBe(false);
    expect(vault.put).not.toHaveBeenCalled();
  });

  it("lists only valid secret names under the secrets prefix", async () => {
    const vault = new MockVault();
    const secrets = new SecretsService(vault);

    const result = await secrets.list();

    expect(result).toEqual({ ok: true, data: ["ANTHROPIC_API_KEY"] });
    expect(vault.list).toHaveBeenCalledWith({
      prefix: "secrets/",
      removePrefix: true,
    });
  });

  it("lists only valid secret names under a scoped prefix", async () => {
    const vault = new MockVault();
    const secrets = new SecretsService(vault);

    const result = await secrets.list({ scope: "Food Tracker" });

    expect(result).toEqual({ ok: true, data: ["ANTHROPIC_API_KEY"] });
    expect(vault.list).toHaveBeenCalledWith({
      prefix: "secrets/scoped/food-tracker/",
      removePrefix: true,
    });
  });

  it("rejects reserved explicit scopes", async () => {
    const vault = new MockVault();
    const secrets = new SecretsService(vault);

    const result = await secrets.get("ANTHROPIC_API_KEY", { scope: "default" });

    expect(result.ok).toBe(false);
    expect(vault.get).not.toHaveBeenCalled();
  });

  it("forwards lock state to the backing vault", async () => {
    const vault = new MockVault();
    const secrets = new SecretsService(vault);

    await secrets.unlock();
    expect(secrets.isUnlocked).toBe(true);
    secrets.lock();
    expect(secrets.isUnlocked).toBe(false);
  });
});
