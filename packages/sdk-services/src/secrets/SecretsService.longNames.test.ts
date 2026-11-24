import { describe, expect, it, mock } from "bun:test";

import type { IDataVaultService } from "../vault/IDataVaultService";
import { SecretsService } from "./SecretsService";
import { MAX_SECRET_NAME_LENGTH, MAX_SECRET_SCOPE_LENGTH, parseSecretCatalogKey, parseStoredSecretCatalogKey, secretNameTooLongRefusal } from "./paths";

// TC-3801: a secret name is at most 64 characters (the node's key-segment limit). A secret stored before that
// limit, under a longer name, has no key of its own: listing shows it with `nameTooLong`, and get, put and delete refuse it.

const LONGEST = `A${"B".repeat(MAX_SECRET_NAME_LENGTH - 1)}`;
const TOO_LONG = `${LONGEST}C`;

function serviceWithKeys(keys: string[]) {
  const vault = {
    list: mock(async () => ({ ok: true as const, data: keys.filter((key) => !key.includes("/")) })),
    listPage: mock(async () => ({ ok: true as const, data: { keys, truncated: false } })),
    put: mock(async () => ({ ok: true as const, data: undefined })),
    get: mock(async () => ({ ok: false as const, error: { code: "KV_NOT_FOUND", service: "vault", message: "missing" } })),
    delete: mock(async () => ({ ok: true as const, data: undefined })),
  };
  return { secrets: new SecretsService(vault as unknown as IDataVaultService), vault };
}

describe("a stored secret name over 64 characters", () => {
  it("is listed by listAll with nameTooLong, global and scoped, beside ordinary names, never hidden", async () => {
    const { secrets } = serviceWithKeys([LONGEST, TOO_LONG, `scoped/food/${TOO_LONG}`, "scoped/food/API_KEY", "not-a-name"]);
    const listed = await secrets.listAll();
    expect(listed.ok ? listed.data : listed.error).toEqual([
      { name: LONGEST },
      { name: TOO_LONG, nameTooLong: true },
      { name: TOO_LONG, scope: "food", nameTooLong: true },
      { name: "API_KEY", scope: "food" },
    ]);
  });

  it("is in list() as a plain name too, so the listing does not shrink", async () => {
    const { secrets } = serviceWithKeys([LONGEST, TOO_LONG, "not-a-name"]);
    expect(await secrets.list()).toEqual({ ok: true, data: [LONGEST, TOO_LONG] });
  });

  it("is never given a key path: the strict parser still hides it, the stored-name parser flags it", () => {
    expect(parseSecretCatalogKey(TOO_LONG)).toBeUndefined();
    expect(parseStoredSecretCatalogKey(TOO_LONG)).toEqual({ name: TOO_LONG, nameTooLong: true });
    expect(parseStoredSecretCatalogKey(LONGEST)).toEqual({ name: LONGEST });
    expect(parseStoredSecretCatalogKey(`scoped/food/${TOO_LONG}`)).toEqual({ name: TOO_LONG, scope: "food", nameTooLong: true });
  });

  it("put is refused with the name's length in the words, before the vault is touched", async () => {
    const { secrets, vault } = serviceWithKeys([]);
    const refused = await secrets.put(TOO_LONG, "v");
    expect(refused.ok ? undefined : refused.error).toMatchObject({
      code: "INVALID_INPUT",
      service: "secrets",
      message: `This secret wasn't saved: its name is ${TOO_LONG.length} characters, and names can be at most 64. Choose a shorter name.`,
    });
    expect(vault.put).not.toHaveBeenCalled();
    expect((await secrets.put(LONGEST, "v")).ok).toBe(true);
  });

  it("a long name that also fails the name pattern is not given the length words", () => {
    expect(secretNameTooLongRefusal(`a${"b".repeat(64)}`)).toBeUndefined();
    expect(secretNameTooLongRefusal(`  ${TOO_LONG}  `)?.ok).toBe(false);
    expect(secretNameTooLongRefusal(LONGEST)).toBeUndefined();
  });

  it("get and delete refuse it with the length error, never reaching the vault", async () => {
    const { secrets, vault } = serviceWithKeys([]);
    for (const result of [await secrets.get(TOO_LONG), await secrets.delete(TOO_LONG)]) {
      expect(result.ok ? undefined : { code: result.error.code, message: result.error.message })
        .toEqual({ code: "INVALID_INPUT", message: `Secret name "${TOO_LONG}" is longer than 64 characters.` });
    }
    expect(vault.get).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();
  });
});

describe("a stored secret scope over 64 characters", () => {
  const LONG_SCOPE = "s".repeat(MAX_SECRET_SCOPE_LENGTH + 1);
  const LONGEST_SCOPE = "s".repeat(MAX_SECRET_SCOPE_LENGTH);

  it("is listed by listAll under its stored scope with scopeTooLong, beside a 64-character scope, and never hidden", async () => {
    const { secrets } = serviceWithKeys([
      `scoped/${LONG_SCOPE}/API_KEY`,
      `scoped/${LONG_SCOPE}/${TOO_LONG}`,
      `scoped/${LONGEST_SCOPE}/API_KEY`,
      "scoped/food/API_KEY",
      `scoped/${"Bad_Scope".repeat(8)}/API_KEY`,
    ]);
    const listed = await secrets.listAll();
    expect(listed.ok ? listed.data : listed.error).toEqual([
      { name: "API_KEY", scope: "food" },
      { name: "API_KEY", scope: LONGEST_SCOPE },
      { name: TOO_LONG, scope: LONG_SCOPE, nameTooLong: true, scopeTooLong: true },
      { name: "API_KEY", scope: LONG_SCOPE, scopeTooLong: true },
    ]);
  });

  it("is never given a key path: the strict parser still hides it, the stored-name parser flags it", () => {
    expect(parseSecretCatalogKey(`scoped/${LONG_SCOPE}/API_KEY`)).toBeUndefined();
    expect(parseStoredSecretCatalogKey(`scoped/${LONG_SCOPE}/API_KEY`)).toEqual({ name: "API_KEY", scope: LONG_SCOPE, scopeTooLong: true });
    expect(parseStoredSecretCatalogKey(`scoped/${LONGEST_SCOPE}/API_KEY`)).toEqual({ name: "API_KEY", scope: LONGEST_SCOPE });
  });

  it("list({ scope }) lists its names; get, put and delete under it still refuse, never reaching the vault", async () => {
    const { secrets, vault } = serviceWithKeys([]);
    vault.list.mockImplementation(async () => ({ ok: true as const, data: ["API_KEY"] }));
    expect(await secrets.list({ scope: LONG_SCOPE })).toEqual({ ok: true, data: ["API_KEY"] });
    expect(vault.list).toHaveBeenCalledWith(expect.objectContaining({ prefix: `secrets/scoped/${LONG_SCOPE}/` }));

    for (const result of [
      await secrets.get("API_KEY", { scope: LONG_SCOPE }),
      await secrets.put("API_KEY", "v", { scope: LONG_SCOPE }),
      await secrets.delete("API_KEY", { scope: LONG_SCOPE }),
    ]) {
      expect(result.ok ? undefined : { code: result.error.code, message: result.error.message })
        .toEqual({ code: "INVALID_INPUT", message: `Secret scope "${LONG_SCOPE}" is longer than 64 characters.` });
    }
    expect(vault.get).not.toHaveBeenCalled();
    expect(vault.put).not.toHaveBeenCalled();
    expect(vault.delete).not.toHaveBeenCalled();
  });
});
