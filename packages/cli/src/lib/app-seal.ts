import { Buffer } from "node:buffer";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

/** The longest record key a sealed value may be bound to. */
export const APP_SEAL_RECORD_KEY_MAX = 512;
const SEAL_VERSION = "tinycloud.app.seal/v1";

export function parseRecordKey(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > APP_SEAL_RECORD_KEY_MAX) {
    throw new CLIError(
      "INVALID_RECORD_KEY",
      `--record-key must be the full storage key of the record, 1 to ${APP_SEAL_RECORD_KEY_MAX} characters.`,
      ExitCode.USAGE_ERROR,
    );
  }
  return input;
}

/** The applications space of an owner, in the spelling the app runner binds sealed values to. */
export function applicationsSpaceId(ownerDid: string): string {
  const match = /^did:pkh:(eip155:[1-9]\d*:0x[0-9a-fA-F]{40})$/.exec(ownerDid);
  if (!match) throw new CLIError("INVALID_ARGUMENT", "The approval's owner is not a did:pkh:eip155 identity.", ExitCode.ERROR);
  return `tinycloud:pkh:${match[1]}:applications`;
}

/**
 * The context a sealed value is bound to: this owner, this owner's applications space and the full record key.
 * Both are taken from the saved approval and the command line, never from the envelope being opened.
 */
export function sealHeader(ownerDid: string, recordKey: string): string {
  return JSON.stringify([SEAL_VERSION, ownerDid, applicationsSpaceId(ownerDid), recordKey]);
}

/** Header, one line feed, then the value as compact JSON: what the key encrypts. */
export function sealPlaintext(header: string, json: string): Uint8Array {
  return new TextEncoder().encode(`${header}\n${JSON.stringify(JSON.parse(json))}`);
}

function contextMismatch(): CLIError {
  return new CLIError(
    "CONTEXT_MISMATCH",
    "This envelope was not encrypted for this owner, space and record key.",
    ExitCode.PERMISSION_DENIED,
  );
}

/** The envelope's outer context must be exactly the expected header, in standard padded base64. */
export function assertSealAad(aad: unknown, header: string): void {
  if (typeof aad !== "string" || aad !== Buffer.from(header, "utf8").toString("base64")) throw contextMismatch();
}

/** The decrypted payload must start with the expected header and one line feed; returns the JSON value text. */
export function openSealedPlaintext(plaintext: Uint8Array, header: string): string {
  const prefix = Buffer.from(`${header}\n`, "utf8");
  const bytes = Buffer.from(plaintext);
  if (bytes.length <= prefix.length || !bytes.subarray(0, prefix.length).equals(prefix)) throw contextMismatch();
  const value = bytes.subarray(prefix.length).toString("utf8");
  try {
    JSON.parse(value);
  } catch {
    throw contextMismatch();
  }
  return value;
}
