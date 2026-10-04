import { afterEach, describe, expect, test } from "bun:test";
import { ProfileLockTimeoutError } from "@tinycloud/operations/state";
import { CLIError, handleError, setActiveProfileName, wrapError } from "./errors.js";

afterEach(() => {
  delete process.env.TC_PROFILE;
});

describe("wrapError", () => {
  test("classifies missing private JWK material as auth state, not network", () => {
    setActiveProfileName("feed-migration-owner");

    const error = wrapError(
      new CLIError(
        "NETWORK_ERROR",
        "Missing private key parameter in JWK",
        6,
      ),
    );

    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.exitCode).toBe(3);
    expect(error.metadata?.hint).toBe(
      "Sign in again with: tc --profile feed-migration-owner auth login --method openkey",
    );
    expect(error.message).not.toContain("NETWORK");
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

  test("preserves an existing CLI error without claiming arbitrary-message redaction", () => {
    const canary = "tc-191-secret-value-canary";
    const error = wrapError(new CLIError("NODE_ERROR", `node rejected request: ${canary}`, 7));
    expect(error.code).toBe("NODE_ERROR");
    expect(error.exitCode).toBe(7);
    expect(error.message).toBe(`node rejected request: ${canary}`);
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
