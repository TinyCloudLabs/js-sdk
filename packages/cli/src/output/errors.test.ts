import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { ProfileLockTimeoutError } from "@tinycloud/operations/state";
import { CLIError, cliErrorFromService, handleError, setActiveProfileName, storageFullError, wrapError } from "./errors.js";
import { buildSecretRequestUrl, secretSetupFor } from "@tinycloud/operations/secret-request";

afterEach(() => {
  delete process.env.TC_PROFILE;
});

describe("wrapError", () => {
  test("classifies missing private JWK material as auth state, not network", () => {
    setActiveProfileName("feed-migration-owner");

    const error = wrapError(
      new Error("Missing private key parameter in JWK"),
    );

    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.exitCode).toBe(3);
    expect(error.metadata?.hint).toBe(
      "Sign in again with: tc --profile feed-migration-owner auth login --method openkey",
    );
    expect(error.message).not.toContain("NETWORK");
  });

  test("converts an untyped signer-wrapped service result into the active profile's login hint", () => {
    setActiveProfileName("feed-migration-owner");
    const error = cliErrorFromService({
      code: "NETWORK_ERROR",
      message: "Failed to sign request: Missing private key parameter in JWK",
    });
    expect(error).toMatchObject({
      code: "AUTH_REQUIRED",
      exitCode: 3,
      message: 'Profile "feed-migration-owner" cannot restore its session because its private key material is missing.',
      metadata: { hint: "Sign in again with: tc --profile feed-migration-owner auth login --method openkey" },
    });
  });

  test("service HTTP statuses and deliberate CLI decisions defeat misleading JWK text", () => {
    const message = "Missing private key parameter in JWK";
    for (const [status, code, exitCode] of [
      [401, "AUTH_REQUIRED", 3],
      [403, "PERMISSION_DENIED", 5],
      [500, "NETWORK_ERROR", 1],
    ] as const) {
      expect(cliErrorFromService({ code: "NETWORK_ERROR", message, meta: { status } }))
        .toMatchObject({ code, exitCode, message, status });
    }
    const deliberate = new CLIError("NODE_ERROR", message, 7);
    expect(cliErrorFromService(deliberate)).toBe(deliberate);
  });

  test("a node 401 that names a revoked grant is GRANT_REVOKED (exit 3) and drops the node text; other 401s are unchanged", () => {
    for (const reason of ["delegation-revoked", "delegation-ancestor-revoked"]) {
      const error = cliErrorFromService({
        code: "KV_ERROR", message: `Failed to list keys: 401 - ${reason}: bafkr4icid`, meta: { status: 401 },
      });
      expect(error).toMatchObject({ code: "GRANT_REVOKED", exitCode: 3, status: 401 });
      expect(error.message).toMatch(/^This grant was revoked\. Ask the owner for a new grant \(`\w+ auth request \.\.\.`\)\.$/);
      expect(error.message).not.toContain("bafkr4icid");
    }
    expect(cliErrorFromService({ code: "KV_ERROR", message: "Failed to list keys: 401 - expired", meta: { status: 401 } }))
      .toMatchObject({ code: "AUTH_REQUIRED", exitCode: 3 });
    expect(cliErrorFromService({ code: "KV_ERROR", message: "403 - delegation-revoked", meta: { status: 403 } }))
      .toMatchObject({ code: "PERMISSION_DENIED", exitCode: 5 });
  });

  test("an operation's typed auth decision without an HTTP status keeps its exit code; a status still decides", () => {
    expect(cliErrorFromService({ code: "AUTH_REQUIRED", message: "The stored session has expired." }))
      .toMatchObject({ code: "AUTH_REQUIRED", exitCode: 3 });
    expect(cliErrorFromService({ code: "PERMISSION_DENIED", message: "Permission is denied to read." }))
      .toMatchObject({ code: "PERMISSION_DENIED", exitCode: 5 });
    expect(cliErrorFromService({ code: "AUTH_REQUIRED", message: "refused", meta: { status: 403 } }))
      .toMatchObject({ code: "PERMISSION_DENIED", exitCode: 5 });
    expect(cliErrorFromService({ code: "NODE_ERROR", message: "The node failed." }))
      .toMatchObject({ code: "NODE_ERROR", exitCode: 1 });
  });

  test("preserves the shipped not-found, permission, and network exit mappings", () => {
    expect(wrapError(new Error("NOT_FOUND: secret missing"))).toMatchObject({
      code: "NOT_FOUND",
      exitCode: 4,
    });
    expect(wrapError(new Error("PERMISSION_DENIED: missing capability"))).toMatchObject({
      code: "PERMISSION_DENIED",
      exitCode: 5,
    });
    expect(wrapError(new Error("fetch failed while contacting node"))).toMatchObject({
      code: "NETWORK_ERROR",
      exitCode: 6,
    });
  });

  test("typed 403 defeats an expired-session body when hosting fails", () => {
    const error = wrapError(Object.assign(new Error("Failed to host: 403 session expired"), { status: 403 }));
    expect(error).toMatchObject({ code: "PERMISSION_DENIED", exitCode: 5 });
    expect(wrapError(Object.assign(new Error("Failed to host: 500 session expired"), { status: 500 })))
      .toMatchObject({ code: "ERROR", exitCode: 1 });
  });

  test("classifies a profile lock timeout from any writer as PROFILE_LOCK_TIMEOUT with a retry hint", () => {
    const error = wrapError(new ProfileLockTimeoutError("publisher", 10_000));
    expect(error).toMatchObject({ code: "PROFILE_LOCK_TIMEOUT", exitCode: 1 });
    expect(error.message).toContain("\"publisher\"");
    expect(error.metadata?.hint).toContain("retry");
  });

  test("preserves deliberate CLI errors and their metadata despite conflicting text or verdict", () => {
    const canary = "tc-191-secret-value-canary";
    const original = new CLIError("AUTH_UNAUTHORIZED", `Missing private key parameter in JWK: ${canary}`, 1, {
      status: 401,
      resource: "tinycloud:pkh:eip155:1:0xabc:default/sql/default",
      requiredAction: "tinycloud.sql/read",
    });
    const error = wrapError(original);
    expect(error).toBe(original);
    expect(error.code).toBe("AUTH_UNAUTHORIZED");
    expect(error.exitCode).toBe(1);
    expect(error.metadata).toEqual(original.metadata);
    expect(error.status).toBe(401);
  });

  test("does not interpret a typed 500 containing JWK wording as missing local key material", () => {
    const error = wrapError(Object.assign(new Error("Missing private key parameter in JWK"), { status: 500 }));
    expect(error).toMatchObject({ code: "ERROR", exitCode: 1 });
  });

  test("emits exact public error output and exit code without private metadata", () => {
    const canary = "tc-191-secret-value-canary";
    const stderr = process.stderr as unknown as { write: (chunk: unknown) => boolean };
    const originalWrite = stderr.write;
    const originalExit = process.exit;
    let rendered = "";
    let exitCode: number | undefined;

    stderr.write = (chunk: unknown) => {
      rendered += String(chunk);
      return true;
    };
    process.exit = ((code?: number): never => {
      exitCode = code;
      throw new Error("expected process exit");
    }) as typeof process.exit;

    try {
      expect(() => handleError(new CLIError(
        "NODE_ERROR",
        "node rejected request",
        7,
        { secretValue: canary },
      ))).toThrow("expected process exit");
    } finally {
      stderr.write = originalWrite;
      process.exit = originalExit;
    }

    expect(exitCode).toBe(7);
    expect(rendered).toBe([
      "{",
      '  "error": {',
      '    "code": "NODE_ERROR",',
      '    "message": "node rejected request"',
      "  }",
      "}",
      "",
    ].join("\n"));
    expect(rendered).not.toContain(canary);
  });

  test("renders only capability metadata in JSON and a useful hint", () => {
    const canary = "private-response-should-not-appear";
    const stderr = process.stderr as unknown as { write: (chunk: unknown) => boolean };
    const originalWrite = stderr.write;
    const originalExit = process.exit;
    let rendered = "";
    stderr.write = (chunk: unknown) => {
      rendered += String(chunk);
      return true;
    };
    process.exit = (() : never => { throw new Error("expected process exit"); }) as typeof process.exit;
    try {
      expect(() => handleError(new CLIError("PERMISSION_DENIED", "403 - Forbidden", 5, {
        status: 403,
        resource: "tinycloud:pkh:eip155:1:0xabc:default/kv/vault/record",
        requiredAction: "tinycloud.kv/get",
        secretValue: canary,
      }))).toThrow("expected process exit");
    } finally {
      stderr.write = originalWrite;
      process.exit = originalExit;
    }
    const output = JSON.parse(rendered) as { error: { code: string; hint: string; meta: Record<string, unknown> } };
    expect(output.error.code).toBe("PERMISSION_DENIED");
    expect(output.error.hint).toContain("tinycloud.kv:default:vault/record:get");
    expect(output.error.meta).toEqual({
      status: 403,
      resource: "tinycloud:pkh:eip155:1:0xabc:default/kv/vault/record",
      requiredAction: "tinycloud.kv/get",
    });
    expect(rendered).not.toContain(canary);
  });
});

function captureHandleError(error: unknown): { code: number | undefined; rendered: string } {
  const stderr = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  const originalWrite = stderr.write;
  const originalExit = process.exit;
  let rendered = "";
  let code: number | undefined;
  stderr.write = (chunk: unknown) => { rendered += String(chunk); return true; };
  process.exit = ((exitCode?: number): never => {
    code = exitCode;
    throw new Error("expected process exit");
  }) as typeof process.exit;
  try {
    expect(() => handleError(error)).toThrow("expected process exit");
  } finally {
    stderr.write = originalWrite;
    process.exit = originalExit;
  }
  return { code, rendered };
}

describe("handleError authorization output", () => {
  test("SQL 401 with a nested space requests the correct grant", () => {
    const resource = "tinycloud:pkh:eip155:1:0xabc:default/notes/sql/default";
    const result = captureHandleError(new CLIError("PERMISSION_DENIED", "Unauthorized Action", 5, {
      status: 401,
      resource,
      requiredAction: "tinycloud.sql/read",
    }));
    const output = JSON.parse(result.rendered);
    expect(result.code).toBe(5);
    expect(output.error.hint).toContain("tc auth request --cap 'tinycloud.sql:default/notes:default:read'");
    expect(output.error.meta).toEqual({
      status: 401,
      resource,
      requiredAction: "tinycloud.sql/read",
    });
  });

  test("KV list at the root and at a trailing prefix retains the empty or trailing path", () => {
    for (const [resource, path] of [
      ["tinycloud:pkh:eip155:1:0xabc:default/kv/", ""],
      ["tinycloud:pkh:eip155:1:0xabc:default/kv/vault/", "vault/"],
    ]) {
      const result = captureHandleError(new CLIError("PERMISSION_DENIED", "Unauthorized Action", 5, {
        status: 403, resource, requiredAction: "tinycloud.kv/list",
      }));
      const output = JSON.parse(result.rendered);
      expect(result.code).toBe(5);
      expect(output.error.hint).toContain(`tc auth request --cap 'tinycloud.kv:default:${path}:list'`);
      expect(output.error.meta).toEqual({ status: 403, resource, requiredAction: "tinycloud.kv/list" });
    }
  });

  test("the emitted grant command preserves every valid key byte through POSIX sh", () => {
    const path = "vault/a!b$HOME`true`\"quote\"'single\\tail-日本語";
    const spec = `tinycloud.kv:default:${path}:get`;
    const resource = `tinycloud:pkh:eip155:1:0xabc:default/kv/${path}`;
    const result = captureHandleError(new CLIError("PERMISSION_DENIED", "Unauthorized Action", 5, {
      status: 401, resource, requiredAction: "tinycloud.kv/get",
    }));
    const output = JSON.parse(result.rendered);
    expect(output.error.meta).toEqual({ status: 401, resource, requiredAction: "tinycloud.kv/get" });
    const command = output.error.hint.split("\n").find((line: string) => line.startsWith("Request it with: "));
    expect(command).toBeDefined();
    const captured = spawnSync("sh", [
      "-c",
      `tc() { printf '%s\\0' "$@"; }; ${command!.slice("Request it with: ".length)}`,
    ], { encoding: "utf8" });
    expect(captured.status).toBe(0);
    expect(captured.stderr).toBe("");
    expect(captured.stdout.split("\0").slice(0, -1)).toEqual(["auth", "request", "--cap", spec]);
  });

  test("rejects server-controlled URL fragments and unsafe action values inside allowed meta fields", () => {
    for (const [resource, requiredAction] of [
      ["https://example.invalid/private#canary/kv/item", "tinycloud.kv/get"],
      ["tinycloud:pkh:eip155:1:0xabc:default/kv/item", "tinycloud.kv/get\"$(secret)"],
    ]) {
      const result = captureHandleError(new CLIError("PERMISSION_DENIED", "Forbidden", 5, {
        status: 403, resource, requiredAction,
      }));
      const output = JSON.parse(result.rendered);
      expect(result.code).toBe(5);
      expect(output.error.meta).toEqual({ status: 403 });
      expect(output.error.hint).toBeUndefined();
      expect(result.rendered).not.toContain(resource);
      expect(result.rendered).not.toContain(requiredAction);
    }
  });
});

describe("storage full", () => {
  const manage = "Free up space or upgrade: https://account.tinycloud.xyz/billing";
  // Node 402 as the SDK reports it: per-space numbers (limit 0) plus the account's.
  const fullSpace = {
    code: "STORAGE_QUOTA_EXCEEDED",
    message: "TinyCloud storage is full, so this change was not saved. Reading still works. Free up space or upgrade your plan to save again.",
    service: "kv",
    meta: { status: 402, usedBytes: 155_744, limitBytes: 0, account: { usedBytes: 389_777_359, limitBytes: 104_857_600, plan: "free" } },
  };

  function render(error: unknown): { exitCode: number | undefined; output: string } {
    const stderr = process.stderr as unknown as { write: (chunk: unknown) => boolean };
    const originalWrite = stderr.write;
    const originalExit = process.exit;
    let output = "";
    let exitCode: number | undefined;
    stderr.write = (chunk: unknown) => {
      output += String(chunk);
      return true;
    };
    process.exit = ((code?: number): never => {
      exitCode = code;
      throw new Error("expected process exit");
    }) as typeof process.exit;
    try {
      expect(() => handleError(error)).toThrow("expected process exit");
    } finally {
      stderr.write = originalWrite;
      process.exit = originalExit;
    }
    return { exitCode, output };
  }

  test("prints one account-level message with the manage link and exits 10", () => {
    const { exitCode, output } = render(fullSpace);

    expect(exitCode).toBe(10);
    expect(JSON.parse(output)).toEqual({
      error: {
        code: "STORAGE_QUOTA_EXCEEDED",
        message: "TinyCloud storage is full; nothing was written.",
        hint: `371.7 MiB used of 100 MiB (free plan). Reading still works.\n${manage}`,
      },
    });
    expect(output).not.toContain("152.1 KiB");
    expect(output).not.toContain("profile switch");
  });

  test("a write larger than what is left gets its own sentence and the same exit code", () => {
    const { exitCode, output } = render({ code: "STORAGE_LIMIT_REACHED", message: "raw", meta: { status: 413 } });

    expect(exitCode).toBe(10);
    expect(JSON.parse(output).error).toEqual({
      code: "STORAGE_LIMIT_REACHED",
      message: "This write is larger than the TinyCloud storage you have left; nothing was written.",
      hint: `Reading still works.\n${manage}`,
    });
  });

  test("maps every command's shape: CLIError with SDK meta, service result, and wrapped cause", () => {
    // tc sql forwards the SDK meta as CLIError metadata.
    expect(wrapError(new CLIError("STORAGE_QUOTA_EXCEEDED", "SQL write failed", 1, fullSpace.meta))).toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
      exitCode: 10,
      metadata: { hint: `371.7 MiB used of 100 MiB (free plan). Reading still works.\n${manage}` },
    });
    // Commands that convert a service result (kv, duckdb, vars, vault, secrets, account).
    expect(cliErrorFromService(fullSpace)).toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
      exitCode: 10,
      metadata: { hint: `371.7 MiB used of 100 MiB (free plan). Reading still works.\n${manage}` },
    });
    expect(wrapError(new CLIError("STORAGE_LIMIT_REACHED", "raw", 1))).toMatchObject({ code: "STORAGE_LIMIT_REACHED", exitCode: 10 });
    expect(wrapError(new Error("vault write failed", { cause: fullSpace }))).toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", exitCode: 10 });
  });

  test("reads storage text only from an uncoded TinyCloud 402/413 response", () => {
    const nodeText = "SQL batch failed: 402 - Storage quota exceeded. Used: 155744 bytes, Limit: 0 bytes";
    expect(wrapError(Object.assign(new Error(nodeText), { status: 402 }))).toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", exitCode: 10 });
    expect(wrapError(new Error("upload failed", { cause: { message: nodeText, meta: { status: 402 } } })))
      .toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", exitCode: 10 });

    // A local file whose name contains the phrase keeps its own mapping.
    const missingFile = Object.assign(new Error("ENOENT: no such file or directory, open 'Storage quota exceeded.md'"), { code: "ENOENT" });
    expect(wrapError(missingFile)).toMatchObject({ code: "ERROR", exitCode: 1 });
    expect(wrapError(new CLIError("NOT_FOUND", 'Key "TinyCloud storage is full" not found', 4))).toMatchObject({ code: "NOT_FOUND", exitCode: 4 });
    expect(wrapError(new CLIError("NETWORK_ERROR", nodeText, 6))).toMatchObject({ code: "NETWORK_ERROR", exitCode: 6 });
    // Without a storage status the text is not a TinyCloud storage rejection.
    expect(wrapError(new Error("Storage quota exceeded in /tmp"))).toMatchObject({ code: "ERROR", exitCode: 1 });
  });

  test("keeps a partial command's progress instead of claiming nothing was written", () => {
    expect(storageFullError(fullSpace, 'Insert into "notes" failed after 3 row(s): ')).toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
      exitCode: 10,
      message: 'Insert into "notes" failed after 3 row(s): TinyCloud storage is full.',
      metadata: { hint: `371.7 MiB used of 100 MiB (free plan). Reading still works.\n${manage}` },
    });
  });

  test("never prints a zero or malformed account budget", () => {
    for (const account of [{ usedBytes: 155_744, limitBytes: 0 }, { usedBytes: -1, limitBytes: 100 }, { usedBytes: 1, limitBytes: "100 MB" }]) {
      expect(wrapError({ code: "STORAGE_QUOTA_EXCEEDED", meta: { account } }).metadata?.hint).toBe(`Reading still works.\n${manage}`);
    }
    expect(wrapError({ code: "STORAGE_QUOTA_EXCEEDED", meta: { account: { usedBytes: 2_048, limitBytes: 1_073_741_824, plan: "\u001b[31mpaid" } } }).metadata?.hint)
      .toBe(`2 KiB used of 1 GiB. Reading still works.\n${manage}`);
  });
});

// Spawned through the real handleError (S3-T2, S3-T3, S3-T3b): exact stderr
// envelope and exit status.
const HARNESS = new URL("../test-support/secrets-json-error.ts", import.meta.url).pathname;
const OWNER = "did:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412";
const ERROR_KEYS = ["code", "message", "hint", "recovery", "setup", "progress", "meta", "warnings"];
// Each case spawns the harness (≈0.5 s on CI); several run per test.
const SPAWN_TEST_TIMEOUT_MS = 30_000;

function spawnHandleError(spec: { code: string; message: string; exitCode: number; metadata?: Record<string, unknown> }) {
  const result = spawnSync(process.execPath, [HARNESS, JSON.stringify(spec)], { encoding: "utf8" });
  const error = (JSON.parse(result.stderr) as { error: Record<string, unknown> }).error;
  for (const key of Object.keys(error)) expect(ERROR_KEYS).toContain(key);
  return { status: result.status, error };
}

describe("error.setup, error.recovery and error.progress", () => {
  const setup = secretSetupFor(buildSecretRequestUrl({ owner: OWNER, names: ["A"] }));
  const scopedSetup = secretSetupFor(buildSecretRequestUrl({ owner: OWNER, names: ["A"], scope: "food-drinks" }));

  test("NOT_FOUND emits the exact setup; malformed setups are dropped", () => {
    expect(spawnHandleError({ code: "NOT_FOUND", message: "missing", exitCode: 4, metadata: { setup } })).toEqual({
      status: 4,
      error: { code: "NOT_FOUND", message: "missing", setup },
    });
    expect(spawnHandleError({ code: "NOT_FOUND", message: "missing", exitCode: 4, metadata: { setup: scopedSetup } }).error.setup)
      .toEqual(scopedSetup);
    for (const bad of [
      { ...setup, kind: "secret_manager" },
      { ...setup, url: `${setup.url}&requester=x` },
      { ...setup, url: "https://evil.example/request?owner=x" },
      { ...setup, names: ["a"] },
      { ...setup, action: "open" },
      { ...setup, owner: OWNER.toLowerCase() },
      { url: setup.url, names: setup.names, owner: setup.owner },
      "https://secrets.tinycloud.xyz",
    ]) {
      const { status, error } = spawnHandleError({ code: "NOT_FOUND", message: "missing", exitCode: 4, metadata: { setup: bad } });
      expect(status).toBe(4);
      expect(error).toEqual({ code: "NOT_FOUND", message: "missing" });
    }
    // Only NOT_FOUND and PERMISSION_DENIED carry a setup.
    expect(spawnHandleError({ code: "ERROR", message: "x", exitCode: 1, metadata: { setup } }).error).not.toHaveProperty("setup");
  }, SPAWN_TEST_TIMEOUT_MS);

  test("progress appears only on NETWORK_ERROR / CANCELLED with exact disjoint name lists", () => {
    const progress = { present: ["A"], pending: ["B"] };
    expect(spawnHandleError({ code: "NETWORK_ERROR", message: "down", exitCode: 6, metadata: { progress } }).error.progress)
      .toEqual(progress);
    const cancelled = spawnHandleError({ code: "CANCELLED", message: "Interrupted.", exitCode: 130, metadata: { progress } });
    expect(cancelled).toEqual({ status: 130, error: { code: "CANCELLED", message: "Interrupted.", progress } });
    // No successful attempt → no progress.
    expect(spawnHandleError({ code: "CANCELLED", message: "Interrupted.", exitCode: 130 })).toEqual({
      status: 130,
      error: { code: "CANCELLED", message: "Interrupted." },
    });
    expect(spawnHandleError({ code: "PERMISSION_DENIED", message: "no", exitCode: 5, metadata: { progress } }).error)
      .not.toHaveProperty("progress");
    for (const bad of [
      { present: ["A"], pending: ["A"] },
      { present: ["a"], pending: [] },
      { present: [], pending: ["B"], extra: 1 },
      { present: [] },
      { present: "A", pending: [] },
    ]) {
      expect(spawnHandleError({ code: "NETWORK_ERROR", message: "down", exitCode: 6, metadata: { progress: bad } }).error)
        .not.toHaveProperty("progress");
    }
  }, SPAWN_TEST_TIMEOUT_MS);

  test("sign_in and complete_migration recoveries serialize unchanged; forged ones are dropped", () => {
    const signIn = { action: "sign_in", command: "tc --profile agent auth login --method openkey --paste --manifest <manifest.json>" };
    const migration = { action: "complete_migration", command: "tc --profile agent auth caps", operationId: "tinycloud.auth.capabilities" };
    expect(spawnHandleError({ code: "AUTH_REQUIRED", message: "sign in", exitCode: 3, metadata: { recovery: signIn } })).toMatchObject({
      status: 3,
      error: { code: "AUTH_REQUIRED", recovery: signIn },
    });
    expect(spawnHandleError({ code: "PROFILE_MIGRATION_REQUIRED", message: "upgrade", exitCode: 1, metadata: { recovery: migration } }))
      .toEqual({ status: 1, error: { code: "PROFILE_MIGRATION_REQUIRED", message: "upgrade", recovery: migration } });
    expect(spawnHandleError({ code: "AUTH_REQUIRED", message: "x", exitCode: 3, metadata: { recovery: { action: "sign_in" } } }).error.recovery)
      .toEqual({ action: "sign_in" });
    for (const bad of [
      { ...signIn, extra: "x" },
      { action: "sign_in", command: "tc --profile x; rm -rf ~ auth caps" },
      { ...migration, operationId: "tinycloud.other" },
      { ...migration, tool: "tinycloud_auth_capabilities" },
      { action: "reboot" },
    ]) {
      expect(spawnHandleError({ code: "AUTH_REQUIRED", message: "x", exitCode: 3, metadata: { recovery: bad } }).error)
        .not.toHaveProperty("recovery");
    }
  }, SPAWN_TEST_TIMEOUT_MS);

  test("request_access keeps only denied names, a canonical owner and a valid scope (S3-T3b stripping)", () => {
    const recovery = { action: "request_access", names: ["B"], owner: OWNER };
    const base = { code: "PERMISSION_DENIED", message: "denied", exitCode: 5 };
    const exact = spawnHandleError({ ...base, metadata: { recovery, deniedNames: ["B"], setup } });
    expect(exact).toEqual({ status: 5, error: { code: "PERMISSION_DENIED", message: "denied", recovery, setup } });
    expect(spawnHandleError({ ...base, metadata: { recovery: { ...recovery, scope: "food-drinks" }, deniedNames: ["B"] } }).error.recovery)
      .toEqual({ ...recovery, scope: "food-drinks" });

    const flipped = OWNER.replace("0xd559", "0xD559");
    for (const metadata of [
      { recovery: { ...recovery, extra: "x" }, deniedNames: ["B"] },
      { recovery: { ...recovery, names: ["C"] }, deniedNames: ["B"] },
      { recovery: { ...recovery, names: ["b"] }, deniedNames: ["b"] },
      { recovery: { ...recovery, owner: flipped }, deniedNames: ["B"] },
      { recovery: { ...recovery, scope: "scoped" }, deniedNames: ["B"] },
      { recovery },
    ]) {
      expect(spawnHandleError({ ...base, metadata })).toEqual({
        status: 5,
        error: { code: "PERMISSION_DENIED", message: "denied" },
      });
    }
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("node retry signals (TC-1413)", () => {
  function render(error: unknown): { exitCode: number | undefined; error: Record<string, unknown> } {
    const stderr = process.stderr as unknown as { write: (chunk: unknown) => boolean };
    const originalWrite = stderr.write;
    const originalExit = process.exit;
    let output = "";
    let exitCode: number | undefined;
    stderr.write = (chunk: unknown) => {
      output += String(chunk);
      return true;
    };
    process.exit = ((code?: number): never => {
      exitCode = code;
      throw new Error("expected process exit");
    }) as typeof process.exit;
    try {
      expect(() => handleError(error)).toThrow("expected process exit");
    } finally {
      stderr.write = originalWrite;
      process.exit = originalExit;
    }
    return { exitCode, error: JSON.parse(output).error };
  }

  const busy = {
    code: "NODE_BUSY",
    message: "SQL query failed: 503 - sql_busy: lock_wait: the database is busy; retry the request",
    service: "sql",
    meta: { status: 503, stage: "lock_wait", retryable: true, retryAfterMs: 5000 },
  };

  test("a busy node says when to try again and exits 7", () => {
    const { exitCode, error } = render(busy);
    expect(exitCode).toBe(7);
    expect(error).toEqual({ code: "NODE_BUSY", message: "The node is busy, try again in 5 s." });
  });

  test("a request timeout says nothing was applied", () => {
    const { exitCode, error } = render({
      code: "REQUEST_TIMEOUT",
      message: "raw",
      meta: { status: 503, retryable: true, retryAfterMs: 1000 },
    });
    expect(exitCode).toBe(7);
    expect(error).toEqual({
      code: "REQUEST_TIMEOUT",
      message: "The node timed out before applying anything, try again in 1 s.",
    });
  });

  test("an unknown outcome says to check before retrying", () => {
    const { exitCode, error } = render({ code: "OUTCOME_UNKNOWN", message: "raw", meta: { status: 500, retryable: false } });
    expect(exitCode).toBe(7);
    expect(error.code).toBe("OUTCOME_UNKNOWN");
    expect(error.message).toBe("Outcome unknown: the node may have applied the write. Check before retrying.");
    expect(String(error.hint)).toContain("Read the data back");
  });

  test("without a Retry-After the message does not invent a delay, and a fraction rounds up", () => {
    expect(cliErrorFromService({ code: "NODE_BUSY", message: "raw", meta: { status: 503 } }).message).toBe(
      "The node is busy, try again shortly.",
    );
    expect(cliErrorFromService({ code: "NODE_BUSY", message: "raw", meta: { retryAfterMs: 1200 } }).message).toBe(
      "The node is busy, try again in 2 s.",
    );
  });

  test("maps every command's shape: service result, CLIError carrying SDK meta, wrapped cause", () => {
    expect(cliErrorFromService(busy)).toMatchObject({ code: "NODE_BUSY", exitCode: 7 });
    expect(wrapError(new CLIError("NODE_BUSY", "SQL failed", 1, busy.meta))).toMatchObject({
      code: "NODE_BUSY",
      exitCode: 7,
      message: "The node is busy, try again in 5 s.",
    });
    expect(wrapError(busy)).toMatchObject({ code: "NODE_BUSY", exitCode: 7 });
  });

  test("a real transport failure keeps NETWORK_ERROR", () => {
    expect(wrapError(new CLIError("NETWORK_ERROR", "fetch failed", 6))).toMatchObject({ code: "NETWORK_ERROR", exitCode: 6 });
  });
});
