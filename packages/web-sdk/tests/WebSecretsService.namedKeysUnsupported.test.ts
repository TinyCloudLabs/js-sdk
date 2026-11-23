import { describe, expect, it, mock } from "bun:test";
import type { ISecretsService } from "@tinycloud/sdk-core";

import { WebSecretsService } from "../src/modules/WebSecretsService";

// TC-3801: a put that opts in to per-secret keys requires encryption-named-keys-v1.
// The page's prompt never opens for it, nothing is written, and reads, lists and deletes still work.

const MONICA_TEXT =
  "This TinyCloud node can't save secrets, because it doesn't support per-secret keys (encryption-named-keys-v1). " +
  "Nothing was saved. Secrets already on it can be read, listed and deleted. " +
  "To save secrets here, whoever runs the node needs to upgrade it.";

function harness(namedKeysSupported: boolean | undefined) {
  const base = {
    vault: {},
    isUnlocked: true,
    unlock: mock(async () => ({ ok: true, data: undefined })),
    lock: mock(() => {}),
    get: mock(async () => ({ ok: true as const, data: "stored" })),
    list: mock(async () => ({ ok: true as const, data: ["API_KEY"] })),
    put: mock(async () => ({ ok: true as const, data: undefined })),
    delete: mock(async () => ({ ok: true as const, data: undefined })),
  };
  const requestPermissions = mock(async () => ({ approved: true }));
  const secrets = new WebSecretsService({
    getService: () => base as unknown as ISecretsService,
    getManifest: () => undefined,
    requestPermissions,
    namedKeysSupported: () => namedKeysSupported,
  });
  return { secrets, base, requestPermissions };
}

describe("WebSecretsService.put on a node without per-secret keys", () => {
  it("is refused with NAMED_KEYS_UNSUPPORTED and Monica's words, with no prompt and no write", async () => {
    const h = harness(false);
    const result = await h.secrets.put("API_KEY", "v", { namedKey: true });
    expect(result.ok ? undefined : result.error).toMatchObject({
      code: "NAMED_KEYS_UNSUPPORTED", service: "secrets", message: MONICA_TEXT,
    });
    expect(h.requestPermissions).not.toHaveBeenCalled();
    expect(h.base.put).not.toHaveBeenCalled();
  });

  it("leaves get, list and delete alone", async () => {
    const h = harness(false);
    expect(await h.secrets.get("API_KEY")).toEqual({ ok: true, data: "stored" });
    expect(await h.secrets.list()).toEqual({ ok: true, data: ["API_KEY"] });
    expect((await h.secrets.delete("API_KEY")).ok).toBe(true);
    expect(h.base.delete).toHaveBeenCalledTimes(1);
  });

  it("a node that lists named keys still asks and then writes", async () => {
    const h = harness(true);
    expect((await h.secrets.put("API_KEY", "v", { namedKey: true })).ok).toBe(true);
    expect(h.requestPermissions).toHaveBeenCalledTimes(1);
    expect(h.base.put).toHaveBeenCalledTimes(1);
  });

  it("a node that cannot be asked fails closed: NAMED_KEYS_CHECK_FAILED, retryable, no prompt, no write", async () => {
    const h = harness(undefined);
    const result = await h.secrets.put("API_KEY", "v", { namedKey: true });
    expect(result.ok ? undefined : result.error).toMatchObject({
      code: "NAMED_KEYS_CHECK_FAILED",
      service: "secrets",
      message: "Couldn't reach this TinyCloud node to check that it can save secrets. Nothing was saved. Try again in a moment.",
      meta: { retryable: true },
    });
    expect(h.requestPermissions).not.toHaveBeenCalled();
    expect(h.base.put).not.toHaveBeenCalled();
  });

  it("a name over 64 characters is refused with its length in the words, before the node is asked or any prompt opens", async () => {
    for (const supported of [true, false, undefined]) {
      const h = harness(supported);
      const result = await h.secrets.put(`A${"B".repeat(64)}`, "v");
      expect(result.ok ? undefined : result.error).toMatchObject({
        code: "INVALID_INPUT",
        service: "secrets",
        message: "This secret wasn't saved: its name is 65 characters, and names can be at most 64. Choose a shorter name.",
      });
      expect(h.requestPermissions).not.toHaveBeenCalled();
      expect(h.base.put).not.toHaveBeenCalled();
    }
  });
});
