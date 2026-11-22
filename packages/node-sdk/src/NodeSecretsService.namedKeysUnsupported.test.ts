import { describe, expect, mock, test } from "bun:test";
import { NAMED_KEYS_UNSUPPORTED, NAMED_KEYS_UNSUPPORTED_MESSAGE, type ISecretsService } from "@tinycloud/sdk-core";

import { NodeSecretsService } from "./NodeSecretsService";

// TC-3801: a secret is sealed to its own key, so a node without encryption-named-keys-v1 cannot take a put.
// The refusal comes before any permission request and before any write; reads, lists and deletes are not affected.

const MONICA_TEXT =
  "This TinyCloud node can't save secrets, because it doesn't support per-secret keys (encryption-named-keys-v1). " +
  "Nothing was saved. Secrets already on it can be read, listed and deleted. " +
  "To save secrets here, whoever runs the node needs to upgrade it.";

function setup(namedKeysSupported: boolean | undefined, held = false) {
  const base = {
    get: mock(async () => ({ ok: true as const, data: "stored" })),
    getEntry: mock(async () => ({ ok: true as const, data: { value: "stored" } })),
    list: mock(async () => ({ ok: true as const, data: ["API_KEY"] })),
    put: mock(async () => ({ ok: true as const, data: undefined })),
    delete: mock(async () => ({ ok: true as const, data: undefined })),
  };
  const grantPermissions = mock(async () => {});
  const secrets = new NodeSecretsService({
    getService: () => base as unknown as ISecretsService,
    getManifest: () => undefined,
    // By default nothing is held: a put on a node that supports named keys has to escalate.
    hasPermissions: () => held,
    uncoveredEntries: (entries) => (held ? [] : entries),
    grantPermissions,
    canEscalate: () => true,
    namedKeysSupported: () => namedKeysSupported,
  });
  return { secrets, base, grantPermissions };
}

describe("NodeSecretsService.put on a node without per-secret keys", () => {
  test("is refused with NAMED_KEYS_UNSUPPORTED and Monica's words, asking and writing nothing", async () => {
    const h = setup(false);
    const result = await h.secrets.put("API_KEY", "v");
    expect(result.ok ? undefined : result.error).toMatchObject({
      code: "NAMED_KEYS_UNSUPPORTED", service: "secrets", message: MONICA_TEXT,
    });
    expect(NAMED_KEYS_UNSUPPORTED).toBe("NAMED_KEYS_UNSUPPORTED");
    expect(NAMED_KEYS_UNSUPPORTED_MESSAGE).toBe(MONICA_TEXT);
    expect(h.grantPermissions).not.toHaveBeenCalled();
    expect(h.base.put).not.toHaveBeenCalled();
  });

  test("a scoped put is refused the same way", async () => {
    const h = setup(false);
    const result = await h.secrets.put("API_KEY", "v", { scope: "my-app" });
    expect(result.ok ? undefined : result.error.code).toBe("NAMED_KEYS_UNSUPPORTED");
    expect(h.grantPermissions).not.toHaveBeenCalled();
    expect(h.base.put).not.toHaveBeenCalled();
  });

  test("get, getEntry, list and delete are unchanged", async () => {
    const h = setup(false, true);
    expect(await h.secrets.get("API_KEY")).toEqual({ ok: true, data: "stored" });
    expect((await h.secrets.getEntry("API_KEY")).ok).toBe(true);
    expect(await h.secrets.list()).toEqual({ ok: true, data: ["API_KEY"] });
    expect((await h.secrets.delete("API_KEY")).ok).toBe(true);
    expect(h.base.delete).toHaveBeenCalledTimes(1);
  });

  test("a node that lists named keys still asks and then writes", async () => {
    const h = setup(true);
    const result = await h.secrets.put("API_KEY", "v");
    expect(result.ok).toBe(true);
    expect(h.grantPermissions).toHaveBeenCalledTimes(1);
    expect(h.base.put).toHaveBeenCalledTimes(1);
  });

  test("a node that cannot be asked fails closed: NAMED_KEYS_CHECK_FAILED, retryable, nothing asked, signed or written", async () => {
    const h = setup(undefined);
    const result = await h.secrets.put("API_KEY", "v");
    expect(result.ok ? undefined : result.error).toMatchObject({
      code: "NAMED_KEYS_CHECK_FAILED",
      service: "secrets",
      message: "Couldn't reach this TinyCloud node to check that it can save secrets. Nothing was saved. Try again in a moment.",
      meta: { retryable: true },
    });
    expect(h.grantPermissions).not.toHaveBeenCalled();
    expect(h.base.put).not.toHaveBeenCalled();
  });
});

describe("NodeSecretsService.put with a name over 64 characters (TC-3801)", () => {
  test("is refused with the name's length in the words, before the node is asked, anything is requested or written", async () => {
    for (const supported of [true, false, undefined]) {
      const asked = mock(() => supported);
      const h = setup(supported);
      const secrets = new NodeSecretsService({
        getService: () => h.base as unknown as ISecretsService,
        getManifest: () => undefined,
        hasPermissions: () => false,
        uncoveredEntries: (entries) => entries,
        grantPermissions: h.grantPermissions,
        canEscalate: () => true,
        namedKeysSupported: asked,
      });
      const name = `A${"B".repeat(64)}`;
      const result = await secrets.put(name, "v");
      expect(result.ok ? undefined : result.error).toMatchObject({
        code: "INVALID_INPUT",
        service: "secrets",
        message: "This secret wasn't saved: its name is 65 characters, and names can be at most 64. Choose a shorter name.",
      });
      expect(asked).not.toHaveBeenCalled();
      expect(h.grantPermissions).not.toHaveBeenCalled();
      expect(h.base.put).not.toHaveBeenCalled();
    }
  });
});
