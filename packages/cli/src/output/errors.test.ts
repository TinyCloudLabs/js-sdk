import { afterEach, describe, expect, test } from "bun:test";
import { ProfileLockTimeoutError } from "@tinycloud/operations/state";
import { CLIError, cliErrorFromService, handleError, setActiveProfileName, wrapError } from "./errors.js";

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
    expect(output.error.hint).toContain('tc auth request --cap "tinycloud.sql:default/notes:default:read"');
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
      expect(output.error.hint).toContain(`tc auth request --cap "tinycloud.kv:default:${path}:list"`);
      expect(output.error.meta).toEqual({ status: 403, resource, requiredAction: "tinycloud.kv/list" });
    }
  });

  test("renders valid punctuation in KV keys as shell-literal grant hints", () => {
    const path = 'vault/a+b@c=d%e(f)~g/日本語//key?x="$HOME!`echo`\\tail';
    const resource = `tinycloud:pkh:eip155:1:0xabc:default/kv/${path}`;
    const result = captureHandleError(new CLIError("PERMISSION_DENIED", "Unauthorized Action", 5, {
      status: 401, resource, requiredAction: "tinycloud.kv/get",
    }));
    const output = JSON.parse(result.rendered);
    expect(output.error.meta).toEqual({ status: 401, resource, requiredAction: "tinycloud.kv/get" });
    expect(output.error.hint).toContain('tc auth request --cap "tinycloud.kv:default:vault/a+b@c=d%e(f)~g/日本語//key?x=');
    expect(output.error.hint).toContain('\\"\\$HOME\\!\\`echo\\`\\\\tail');
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
