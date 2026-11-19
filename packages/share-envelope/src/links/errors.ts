/**
 * Every refusal the links module can raise, as one stable code. The names are
 * the contract's labels (header, record, resolve and link vectors) plus the
 * transport and argument codes below. Messages never carry a key, a link, a
 * fragment or any request value.
 */
export type LinkErrorCode =
  // header
  | "header_shape"
  | "header_fields"
  | "header_version"
  | "unknown_type"
  | "issuer_format"
  | "issuer_method_not_allowed"
  | "issuer_key_type"
  | "issuer_key_noncanonical"
  | "issuer_key_invalid"
  | "issuer_weak_key"
  | "issuer_service_format"
  | "audience_format"
  | "audience_mismatch"
  | "timestamp_format"
  | "nonce_format"
  | "size_format"
  | "body_cid_format"
  | "issued_at_window"
  | "expires_before_issued"
  | "life_too_short"
  | "life_too_long"
  | "already_expired"
  // body and record
  | "body_encoding"
  | "size_mismatch"
  | "body_over_cap"
  | "body_too_small"
  | "body_hash_mismatch"
  | "bad_signature"
  | "record_shape"
  | "record_fields"
  | "unsigned_not_allowed"
  | "expired"
  | "body_open_failed"
  | "plaintext_schema"
  | "issuer_binding_mismatch"
  // link grammar and resolve
  | "not_a_url"
  | "not_https"
  | "userinfo"
  | "origin_not_trusted"
  | "not_canonical"
  | "query_present"
  | "removed_version"
  | "path_grammar"
  | "fragment_grammar"
  | "key_noncanonical"
  | "cid_grammar"
  | "record_encoding"
  | "record_json"
  | "record_not_canonical"
  | "type_path_mismatch"
  | "link_cid_mismatch"
  | "full_non_share"
  | "gone"
  // delete request
  | "request_shape"
  | "request_fields"
  | "request_version"
  | "id_mismatch"
  | "id_grammar"
  // client and transport
  | "invalid_argument"
  | "signer_failed"
  | "body_validation_failed"
  | "service_refused"
  | "service_unavailable"
  | "invalid_response"
  | "response_too_large";

export class LinkError extends Error {
  readonly code: LinkErrorCode;
  /** HTTP status of a refusal by the links service (`service_refused`), when there was one. */
  readonly status: number | undefined;
  /** The `error` code the service answered with (`service_refused`), when there was one. */
  readonly serviceError: string | undefined;

  constructor(code: LinkErrorCode, message?: string, details: { readonly status?: number; readonly serviceError?: string; readonly cause?: unknown } = {}) {
    super(message ?? code, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "LinkError";
    this.code = code;
    this.status = details.status;
    this.serviceError = details.serviceError;
  }
}

export function isLinkError(value: unknown): value is LinkError {
  return value instanceof LinkError;
}
