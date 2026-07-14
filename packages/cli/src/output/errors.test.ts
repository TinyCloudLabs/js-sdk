import { afterEach, describe, expect, test } from "bun:test";
import { CLIError, setActiveProfileName, wrapError } from "./errors.js";

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

  test("does not replace an existing CLI error or expose a secret in its message", () => {
    const error = wrapError(new CLIError("NODE_ERROR", "node rejected request", 7));
    expect(error.code).toBe("NODE_ERROR");
    expect(error.exitCode).toBe(7);
    expect(error.message).not.toContain("secret-value-canary");
  });
});
