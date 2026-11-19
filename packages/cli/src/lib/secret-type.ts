import { SECRET_TYPES, isSecretType, type SecretType } from "@tinycloud/sdk-core";
import { parseTotpSeed } from "@tinycloud/sdk-services/secrets/totp";
import { CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";

/** The `--type` option of `tc secrets put`, or undefined when it was not given. */
export function parseSecretTypeOption(input: string | undefined): SecretType | undefined {
  if (input === undefined) return undefined;
  if (!isSecretType(input)) {
    throw new CLIError(
      "USAGE_ERROR",
      `Unknown secret type ${JSON.stringify(input)}. Use one of: ${SECRET_TYPES.join(", ")}.`,
      ExitCode.USAGE_ERROR,
    );
  }
  return input;
}

/**
 * Refuse a TOTP secret whose value is not a usable seed. The message never
 * includes the value.
 */
export function assertSecretValueMatchesType(type: SecretType | undefined, value: string): void {
  if (type !== "totp") return;
  const parsed = parseTotpSeed(value);
  if (!parsed.ok) {
    throw new CLIError(
      "USAGE_ERROR",
      `The value is not a usable TOTP seed: ${parsed.message}`,
      ExitCode.USAGE_ERROR,
      { hint: "Pass a base32 seed or an otpauth://totp/... link, or store it without --type totp." },
    );
  }
}
