export type SignedObjectErrorCode =
  | "schema-invalid"
  | "canonicalization-mismatch"
  | "digest-mismatch"
  | "id-mismatch"
  | "signing-key-binding"
  | "signature-material-invalid"
  | "signature-suite-unsupported"
  | "signature-invalid";

export class SignedObjectProfileError extends Error {
  public readonly code: SignedObjectErrorCode;

  constructor(code: SignedObjectErrorCode, message: string) {
    super(message);
    this.name = "SignedObjectProfileError";
    this.code = code;
  }
}

export class SignedObjectSchemaError extends SignedObjectProfileError {
  constructor(message: string) {
    super("schema-invalid", message);
    this.name = "SignedObjectSchemaError";
  }
}

export class SignedObjectCanonicalizationError extends SignedObjectProfileError {
  constructor(message: string) {
    super("canonicalization-mismatch", message);
    this.name = "SignedObjectCanonicalizationError";
  }
}

export class SignedObjectDigestError extends SignedObjectProfileError {
  constructor(message: string) {
    super("digest-mismatch", message);
    this.name = "SignedObjectDigestError";
  }
}

export class SignedObjectIdError extends SignedObjectProfileError {
  constructor(message: string) {
    super("id-mismatch", message);
    this.name = "SignedObjectIdError";
  }
}

export class SigningKeyBindingError extends SignedObjectProfileError {
  constructor(message: string) {
    super("signing-key-binding", message);
    this.name = "SigningKeyBindingError";
  }
}

export class SignatureMaterialError extends SignedObjectProfileError {
  constructor(message: string) {
    super("signature-material-invalid", message);
    this.name = "SignatureMaterialError";
  }
}

export class UnsupportedSignatureSuiteError extends SignedObjectProfileError {
  constructor(message: string) {
    super("signature-suite-unsupported", message);
    this.name = "UnsupportedSignatureSuiteError";
  }
}

export class SignatureVerificationError extends SignedObjectProfileError {
  constructor(message: string) {
    super("signature-invalid", message);
    this.name = "SignatureVerificationError";
  }
}

export function toSignedObjectError(error: unknown): SignedObjectProfileError {
  if (error instanceof SignedObjectProfileError) {
    return error;
  }
  return new SignedObjectProfileError(
    "schema-invalid",
    error instanceof Error ? error.message : String(error),
  );
}
