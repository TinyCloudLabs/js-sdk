/** Which check refused the attestation. */
export type RefusalCode =
  | "response"
  | "mode"
  | "nonce"
  | "binding"
  | "identity"
  | "quote"
  | "tcb"
  | "report-data"
  | "debug"
  | "event-log"
  | "os"
  | "release"
  | "kms"
  | "service";

/** The attestation did not verify. `message` says why, for a person to read. */
export class TeeVerifyRefused extends Error {
  override readonly name = "TeeVerifyRefused";
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

export function refuse(code: RefusalCode, message: string): never {
  throw new TeeVerifyRefused(code, message);
}
