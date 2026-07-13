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
});
