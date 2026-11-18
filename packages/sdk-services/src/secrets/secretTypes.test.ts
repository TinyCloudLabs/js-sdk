import { describe, expect, it, mock } from "bun:test";

import type { Result } from "../types";
import type { IDataVaultService } from "../vault/IDataVaultService";
import type { VaultEntry, VaultError } from "../vault/types";
import type { SecretPayload } from "./ISecretsService";
import { SecretsService, SECRET_TYPES, secretTypeOf } from "./index";

function vaultWith(payload: unknown) {
  const put = mock(
    async (
      _key: string,
      _payload: unknown,
      _options?: unknown,
    ): Promise<Result<void, VaultError>> => ({ ok: true, data: undefined }),
  );
  const get = mock(
    async (): Promise<Result<VaultEntry<unknown>, VaultError>> => ({
      ok: true,
      data: { value: payload, metadata: {}, keyId: "key" },
    }),
  );
  const vault = { get, put } as unknown as IDataVaultService;
  return { service: new SecretsService(vault), put, get };
}

const LEGACY: SecretPayload = {
  value: "stored-value",
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:00.000Z",
};

describe("secret types", () => {
  it("lists secret first as the default, then totp, username, password", () => {
    expect([...SECRET_TYPES]).toEqual(["secret", "totp", "username", "password"]);
  });

  it("renders an untyped or unknown-typed payload as secret", () => {
    expect(secretTypeOf(LEGACY)).toBe("secret");
    expect(secretTypeOf({ ...LEGACY, type: "other" })).toBe("secret");
    expect(secretTypeOf({ ...LEGACY, type: 7 } as unknown as SecretPayload)).toBe("secret");
    expect(secretTypeOf({ ...LEGACY, type: "totp" })).toBe("totp");
  });
});

describe("SecretsService typed secrets", () => {
  it("get returns only the value for a typed payload (old readers unchanged)", async () => {
    const { service } = vaultWith({ ...LEGACY, type: "totp" });
    expect(await service.get("GITHUB_TOTP")).toEqual({ ok: true, data: "stored-value" });
  });

  it("getEntry reports secret for a legacy payload", async () => {
    const { service } = vaultWith(LEGACY);
    expect(await service.getEntry("API_KEY")).toEqual({
      ok: true,
      data: { ...LEGACY, type: "secret" },
    });
  });

  it("getEntry reports the stored type", async () => {
    const { service } = vaultWith({ ...LEGACY, type: "password" });
    const result = await service.getEntry("API_KEY");
    expect(result.ok && result.data.type).toBe("password");
  });

  it("getEntry treats an unknown stored type as secret", async () => {
    const { service } = vaultWith({ ...LEGACY, type: "future-kind" });
    const result = await service.getEntry("API_KEY");
    expect(result.ok && result.data.type).toBe("secret");
  });

  it("put with a type stores it inside the payload", async () => {
    const { service, put } = vaultWith(LEGACY);
    expect((await service.put("GITHUB_TOTP", "seed", { type: "totp" })).ok).toBe(true);
    const payload = put.mock.calls[0]?.[1] as SecretPayload;
    expect(payload.type).toBe("totp");
    expect(payload.value).toBe("seed");
  });

  it("put without a type, or with the default secret type, writes today's payload", async () => {
    const { service, put } = vaultWith(LEGACY);
    await service.put("API_KEY", "v1");
    await service.put("API_KEY", "v2", { type: "secret" });
    for (const call of put.mock.calls) {
      const payload = call[1] as SecretPayload;
      expect(Object.keys(payload).sort()).toEqual(["createdAt", "updatedAt", "value"]);
    }
  });

  it("put refuses an unknown type before touching the vault", async () => {
    const { service, put } = vaultWith(LEGACY);
    const result = await service.put("API_KEY", "v", {
      type: "other" as unknown as "totp",
    });
    expect(result.ok).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});
