import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { PermissionEntry } from "@tinycloud/sdk-core";

import { invokeOperation } from "../invoke.js";
import { createAuthRuntimeFixture, persistRuntimeDelegations } from "../../test-support/auth-runtime.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(`${tmpdir()}/tinycloud-secrets-i3-`);
  process.env.TC_HOME = home;
});

afterEach(async () => {
  delete process.env.TC_HOME;
  await rm(home, { recursive: true, force: true });
});

test("registered secret invocation preflights the exact KV/encryption union", async () => {
  const fixture = await createAuthRuntimeFixture();
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    const missing = await invokeSecret(fixture.profile);
    expect(missing.status).toBe("authority_required");
    if (missing.status !== "authority_required") throw new Error("expected authority");
    expect(missing.missing).toHaveLength(2);
    expect(missing.missing.map((permission) => permission.service).sort()).toEqual([
      "tinycloud.kv",
      "tinycloud.encryption",
    ].sort());
    const requested = missing.request.requested as readonly {
      readonly service?: unknown;
      readonly space?: unknown;
    }[];
    expect(requested).toEqual(missing.missing);
    expect(requested.some((permission) =>
      permission.service === "tinycloud.kv" &&
      permission.space === missing.context.space?.toLowerCase(),
    )).toBe(true);
    expect(readSecret).not.toHaveBeenCalled();
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

test("registered authority accepts only the exact KV/encryption union", async () => {
  const fixture = await createAuthRuntimeFixture();
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    const kvOnly = await fixture.hermetic.mintDelegationWithPermissions(
      fixture.hermetic.permissions.filter((permission) => permission.service === "tinycloud.kv") as PermissionEntry[],
    );
    await persistRuntimeDelegations(fixture, [kvOnly]);
    const missingDecrypt = await invokeSecret(fixture.profile);
    expect(missingDecrypt.status).toBe("authority_required");
    if (missingDecrypt.status !== "authority_required") throw new Error("expected authority");
    expect(missingDecrypt.missing.map((permission) => permission.service)).toEqual([
      "tinycloud.encryption",
    ]);

    const decryptOnly = await fixture.hermetic.mintDelegationWithPermissions(
      fixture.hermetic.permissions.filter((permission) => permission.service === "tinycloud.encryption") as PermissionEntry[],
    );
    await persistRuntimeDelegations(fixture, [decryptOnly]);
    const missingKv = await invokeSecret(fixture.profile);
    expect(missingKv.status).toBe("authority_required");
    if (missingKv.status !== "authority_required") throw new Error("expected authority");
    expect(missingKv.missing.map((permission) => permission.service)).toEqual([
      "tinycloud.kv",
    ]);

    const full = await fixture.hermetic.mintDelegation();
    await persistRuntimeDelegations(fixture, [full]);
    readSecret.mockResolvedValue({
      status: "ok",
      value: "hermetic encrypted delegation proof",
    });
    const result = await invokeSecret(fixture.profile);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected success");
    expect(result.output).toEqual({ value: "hermetic encrypted delegation proof" });
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

test("registered planning is owner-exact for full and explicit short spaces", async () => {
  const fixture = await createAuthRuntimeFixture();
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    const full = await fixture.hermetic.mintDelegation();
    await persistRuntimeDelegations(fixture, [full]);

    const ownerB = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000003:secrets";
    const crossOwner = await invokeSecret(fixture.profile, { space: ownerB });
    expect(crossOwner.status).toBe("authority_required");
    if (crossOwner.status !== "authority_required") throw new Error("expected authority");
    expect(crossOwner.missing).toContainEqual(expect.objectContaining({
      service: "tinycloud.kv",
      space: ownerB,
    }));

    readSecret.mockResolvedValue({ status: "ok", value: "short-space-proof" });
    const crossOwnerShort = await invokeSecret(fixture.profile, { space: "other" });
    expect(crossOwnerShort.status).toBe("authority_required");
    if (crossOwnerShort.status !== "authority_required") throw new Error("expected authority");
    expect(crossOwnerShort.missing).toContainEqual(expect.objectContaining({
      service: "tinycloud.kv",
      space: `${missingOwnerSpace(fixture)}:other`,
    }));

    const explicitShort = await invokeSecret(fixture.profile, { space: "secrets" });
    expect(explicitShort.status).toBe("ok");
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

test("registered secret execution preserves classified node failures and thrown reads", async () => {
  const fixture = await createAuthRuntimeFixture();
  const full = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [full]);
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    for (const [status, code] of [
      ["node_unreachable", "NODE_UNREACHABLE"],
      ["read_failed", "SECRET_READ_FAILED"],
      ["corrupt_envelope", "SECRET_READ_FAILED"],
      ["decrypt_failed", "SECRET_DECRYPT_FAILED"],
      ["invalid_payload", "SECRET_DECRYPT_FAILED"],
    ] as const) {
      readSecret.mockResolvedValue({ status } as never);
      const result = await invokeSecret(fixture.profile);
      expect(result.status).toBe("error");
      if (result.status !== "error") throw new Error("expected error");
      expect(result.error.code).toBe(code);
    }

    readSecret.mockResolvedValue({ status: "not_found" } as never);
    const absent = await invokeSecret(fixture.profile);
    expect(absent.status).toBe("setup_required");
    if (absent.status !== "setup_required") throw new Error("expected setup");
    expect(absent.setup.url).toContain("HERMETIC_DELEGATION_CANARY");

    readSecret.mockRejectedValue(new Error("private node detail"));
    const thrown = await invokeSecret(fixture.profile);
    expect(thrown).toMatchObject({ status: "error", error: { code: "NODE_ERROR" } });
    expect(JSON.stringify(thrown)).not.toContain("private node detail");
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

async function invokeSecret(
  profile: string,
  input: Readonly<{ space?: string }> = {},
) {
  return invokeOperation(
    "tinycloud.secrets.get",
    1,
    { profile },
    { name: "HERMETIC_DELEGATION_CANARY", ...input },
  );
}

function missingOwnerSpace(fixture: { hermetic: { permissions: readonly PermissionEntry[] } }): string {
  const permission = fixture.hermetic.permissions.find((entry) => entry.service === "tinycloud.kv");
  if (permission?.space === undefined) throw new Error("expected hermetic KV space");
  return permission.space.toLowerCase().replace(/:secrets$/, "");
}
