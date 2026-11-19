import { describe, expect, it, mock } from "bun:test";
import type { ISecretsService, SecretEntry } from "@tinycloud/sdk-core";

import { WebSecretsService } from "../src/modules/WebSecretsService";

const ENTRY: SecretEntry = {
  value: "seed",
  type: "totp",
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:00.000Z",
};

describe("WebSecretsService.getEntry", () => {
  it("forwards to the secrets service with its options", async () => {
    const getEntry = mock(async () => ({ ok: true as const, data: ENTRY }));
    const base = {
      vault: {},
      isUnlocked: true,
      unlock: mock(async () => ({ ok: true, data: undefined })),
      lock: mock(() => {}),
      getEntry,
    } as unknown as ISecretsService;
    const secrets = new WebSecretsService({
      getService: () => base,
      getManifest: () => undefined,
      requestPermissions: async () => ({ approved: true }),
    });

    expect(await secrets.getEntry("GITHUB_TOTP", { scope: "food" })).toEqual({
      ok: true,
      data: ENTRY,
    });
    expect(getEntry).toHaveBeenCalledWith("GITHUB_TOTP", { scope: "food" });
  });
});
