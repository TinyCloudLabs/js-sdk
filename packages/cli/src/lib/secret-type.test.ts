import { describe, expect, test } from "bun:test";

import { CLIError } from "../output/errors.js";
import { assertSecretValueMatchesType, parseSecretTypeOption } from "./secret-type.js";

const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("secrets put --type", () => {
  test("no option leaves the type unset", () => {
    expect(parseSecretTypeOption(undefined)).toBeUndefined();
  });

  test("accepts each known type and refuses others, including other", () => {
    for (const type of ["secret", "totp", "username", "password"]) {
      expect(String(parseSecretTypeOption(type))).toBe(type);
    }
    for (const bad of ["other", "TOTP", ""]) {
      expect(() => parseSecretTypeOption(bad)).toThrow(CLIError);
    }
  });

  test("a totp secret needs a usable seed and the error never shows the value", () => {
    assertSecretValueMatchesType("totp", SEED);
    assertSecretValueMatchesType("totp", `otpauth://totp/x?secret=${SEED}\n`);
    let message = "";
    try {
      assertSecretValueMatchesType("totp", "not a seed!!");
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("not a usable TOTP seed");
    expect(message).not.toContain("not a seed!!");
  });

  test("other types and untyped values are not inspected", () => {
    assertSecretValueMatchesType(undefined, "anything");
    assertSecretValueMatchesType("password", "anything");
    assertSecretValueMatchesType("secret", "anything");
  });
});
