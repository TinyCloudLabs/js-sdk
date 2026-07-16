import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { PermissionEntry } from "@tinycloud/sdk-core";

import { invokeOperation } from "../invoke.js";
import { listPermissionRequests } from "../artifacts.js";
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
    expect(crossOwner.request.requested).toEqual(crossOwner.missing);

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

test("registered runtime hints persist only the exact planned phase", async () => {
  const fixture = await createAuthRuntimeFixture();
  const full = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [full]);
  const kv = fixture.hermetic.permissions.find((permission) => permission.service === "tinycloud.kv");
  const decrypt = fixture.hermetic.permissions.find((permission) => permission.service === "tinycloud.encryption");
  if (kv === undefined || decrypt === undefined) throw new Error("expected hermetic plan");
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    readSecret.mockResolvedValue({ status: "permission_required", hint: kv } as never);
    const kvHint = await invokeSecret(fixture.profile);
    expect(kvHint.status).toBe("authority_required");
    if (kvHint.status !== "authority_required") throw new Error("expected KV authority");
    const kvRequested = kvHint.request.requested as readonly Readonly<Record<string, unknown>>[];
    expect(kvHint.missing).toEqual(kvRequested);
    expect(kvHint.missing).toHaveLength(1);
    expect(kvHint.missing[0]).toMatchObject({
      service: "tinycloud.kv",
      path: kv.path,
      actions: kv.actions,
    });
    const kvSpace = kvHint.missing[0]?.space;
    expect(typeof kvSpace === "string" ? kvSpace.toLowerCase() : kvSpace)
      .toBe(typeof kv.space === "string" ? kv.space.toLowerCase() : kv.space);

    readSecret.mockResolvedValue({ status: "permission_required", hint: decrypt } as never);
    const decryptHint = await invokeSecret(fixture.profile, { name: "HERMETIC_DELEGATION_CANARY" });
    expect(decryptHint.status).toBe("authority_required");
    if (decryptHint.status !== "authority_required") throw new Error("expected decrypt authority");
    const decryptRequested = decryptHint.request.requested as readonly Readonly<Record<string, unknown>>[];
    expect(decryptHint.missing).toEqual(decryptRequested);
    expect(decryptHint.missing).toHaveLength(1);
    expect(decryptHint.missing[0]).toMatchObject({
      service: decrypt.service,
      actions: decrypt.actions,
    });
    const decryptPath = decryptHint.missing[0]?.path;
    expect(typeof decryptPath === "string" ? decryptPath.toLowerCase() : decryptPath)
      .toBe(typeof decrypt.path === "string" ? decrypt.path.toLowerCase() : decrypt.path);

    const requests = await listPermissionRequests(fixture.profile);
    expect(requests.map((request) => request.requested)).toEqual([
      Array.from(kvRequested),
      Array.from(decryptRequested),
    ] as never);
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

test("registered runtime rejects wrong-owner, broad, and unknown hints without persisting", async () => {
  const fixture = await createAuthRuntimeFixture();
  const full = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [full]);
  const kv = fixture.hermetic.permissions.find((permission) => permission.service === "tinycloud.kv");
  if (kv === undefined) throw new Error("expected hermetic KV plan");
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  try {
    const invalidHints = [
      { ...kv, space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000009:secrets" },
      { ...kv, path: "vault/secrets/*" },
      { ...kv, actions: ["tinycloud.kv/*"] },
      { ...kv, service: "tinycloud.unknown" },
      { ...kv, caveats: [{ tenant: "wrong" }] },
      [],
    ];
    for (const hint of invalidHints) {
      readSecret.mockResolvedValue({ status: "permission_required", hint } as never);
      const result = await invokeSecret(fixture.profile);
      expect(result).toMatchObject({ status: "error", error: { code: "PERMISSION_HINT_INVALID" } });
    }
    expect(await listPermissionRequests(fixture.profile)).toEqual([]);
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

test("registered runtime owner retry reads once and retries exactly once after a classified hint", async () => {
  const fixture = await createAuthRuntimeFixture();
  const full = await fixture.hermetic.mintDelegation();
  await persistRuntimeDelegations(fixture, [full]);
  const kv = fixture.hermetic.permissions.find((permission) => permission.service === "tinycloud.kv");
  if (kv === undefined) throw new Error("expected hermetic KV plan");
  const readSecret = spyOn(TinyCloudNode.prototype, "readSecret");
  let attempts = 0;
  readSecret.mockImplementation(async () => {
    attempts += 1;
    return attempts === 1
      ? { status: "permission_required", hint: kv } as never
      : { status: "ok", value: "owner-retry-proof" };
  });
  try {
    const first = await invokeSecret(fixture.profile);
    expect(first.status).toBe("authority_required");
    if (first.status !== "authority_required") throw new Error("expected first authority result");
    expect(first.request.requested).toEqual(first.missing);
    expect(readSecret).toHaveBeenCalledTimes(1);

    const second = await invokeSecret(fixture.profile);
    expect(second).toMatchObject({ status: "ok", output: { value: "owner-retry-proof" } });
    expect(readSecret).toHaveBeenCalledTimes(2);
    expect((await listPermissionRequests(fixture.profile)).map((request) => request.requested))
      .toEqual([first.request.requested] as never);
  } finally {
    readSecret.mockRestore();
    fixture.hermetic.stop();
  }
});

async function invokeSecret(
  profile: string,
  input: Readonly<{ space?: string; name?: string }> = {},
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
