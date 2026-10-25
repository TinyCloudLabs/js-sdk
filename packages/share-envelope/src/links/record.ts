import { z } from "zod";

import { open } from "../aead.js";
import { computeCid } from "../cid.js";
import type { LinkType } from "./constants.js";
import { LinkError } from "./errors.js";
import {
  checkLinkBody,
  decodeStrictBase64Url,
  linkSignatureV1Schema,
  parseLinkTimestamp,
  isPlainObject,
  validateLinkHeader,
  verifyHeader,
  type LinkHeaderV1,
  type LinkSignatureV1,
} from "./header.js";

/** Caller-supplied check of the opened plaintext, run after every contract check. Throw to refuse. */
export type LinkBodyValidator = (type: LinkType, value: unknown) => void | Promise<void>;

export interface OpenedLink {
  readonly type: LinkType;
  readonly header: LinkHeaderV1;
  /** Absent only on an unsigned `openkey-login` record. */
  readonly signature: LinkSignatureV1 | undefined;
  /** The sealed body bytes. */
  readonly body: Uint8Array;
  /** The opened plaintext bytes. */
  readonly plaintext: Uint8Array;
  /** The plaintext parsed as a JSON object. */
  readonly value: Record<string, unknown>;
}

const jsonObject = z.record(z.unknown());

export function toEpochMs(now: Date | number | undefined): number {
  const ms = now === undefined ? Date.now() : now instanceof Date ? now.getTime() : now;
  if (Number.isNaN(new Date(ms).getTime())) throw new LinkError("timestamp_format");
  return ms;
}

export interface CheckedLinkRecord {
  readonly header: LinkHeaderV1;
  /** Absent only on an unsigned `openkey-login` record. */
  readonly signature: LinkSignatureV1 | undefined;
  /** The sealed body bytes. */
  readonly body: Uint8Array;
}

/**
 * The record checks that need no key: record shape, header, unsigned only for
 * `openkey-login`, body encoding, size, the body limit and CID, signature, and
 * expiry. A holder of the record without the content key (a node, a service
 * check) stops here. Readers do not check `audience` or the create-time life
 * rules.
 */
export async function checkLinkRecord(record: unknown, nowMs: number): Promise<CheckedLinkRecord> {
  if (!isPlainObject(record)) throw new LinkError("record_shape");
  const fields = record;
  const names = Object.keys(fields).sort().join(",");
  if (names !== "body,header,signature" && names !== "body,header") throw new LinkError("record_fields");
  const signed = "signature" in fields;
  const header = validateLinkHeader(fields.header, { mode: signed ? "signed" : "service" });
  if (!signed && header.type !== "openkey-login") throw new LinkError("unsigned_not_allowed");
  const body = decodeStrictBase64Url(fields.body);
  if (body === null) throw new LinkError("body_encoding");
  checkLinkBody(header, body, await computeCid(body));
  if (signed && !verifyHeader(header, fields.signature)) throw new LinkError("bad_signature");
  const signature = signed ? linkSignatureV1Schema.parse(fields.signature) : undefined;
  if ((parseLinkTimestamp(header.expiresAt) ?? 0) <= nowMs) throw new LinkError("expired");
  return { header, signature, body };
}

/**
 * The record checks of the reader pipeline, up to and including the issuer
 * binding: {@link checkLinkRecord}, authenticated decryption, a JSON-object
 * plaintext, and the sealed issuer equal to `header.issuer`.
 */
export async function openRecordChecked(record: unknown, key: Uint8Array, nowMs: number): Promise<OpenedLink> {
  const { header, signature, body } = await checkLinkRecord(record, nowMs);
  if (key.length !== 32) throw new LinkError("invalid_argument", "a link key is 32 bytes");
  let plaintext: Uint8Array;
  try {
    plaintext = await open(body, key);
  } catch {
    throw new LinkError("body_open_failed");
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw new LinkError("plaintext_schema");
  }
  const parsedValue = jsonObject.safeParse(json);
  if (!parsedValue.success) throw new LinkError("plaintext_schema");
  const value = parsedValue.data;
  // Issuer binding: a share names its envelope signer, every other type a top-level `issuer`.
  const envelopeSignature = jsonObject.safeParse(value.signature);
  const claimed = header.type === "share" ? (envelopeSignature.success ? envelopeSignature.data.signerDid : undefined) : value.issuer;
  if (typeof claimed !== "string" || claimed !== header.issuer) throw new LinkError("issuer_binding_mismatch");
  return { type: header.type, header, signature, body, plaintext, value };
}

export async function runBodyValidator(opened: OpenedLink, validateBody: LinkBodyValidator | undefined): Promise<void> {
  if (validateBody === undefined) return;
  try {
    await validateBody(opened.type, opened.value);
  } catch (cause) {
    if (cause instanceof LinkError) throw cause;
    throw new LinkError("body_validation_failed", "the opened body was refused by the caller's validator", { cause });
  }
}

/**
 * Open a record with its content key: every record check, the issuer binding,
 * then the optional caller validator. Nothing is returned unless all pass.
 */
export async function openLinkRecord(record: unknown, key: Uint8Array, options: { readonly now?: Date | number; readonly validateBody?: LinkBodyValidator } = {}): Promise<OpenedLink> {
  const opened = await openRecordChecked(record, key, toEpochMs(options.now));
  await runBodyValidator(opened, options.validateBody);
  return opened;
}
