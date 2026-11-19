import { canonicalize, computeCid, fromBase64Url, isCanonicalHttpsOrigin, open, toBase64Url } from "@tinycloud/share-envelope";
import { buildFullLink, checkLinkRecord, linkSignatureV1Schema, openLinkRecord, parseLink, validateLinkHeader, type LinkHeaderV1, type LinkSignatureV1, type ParsedLink } from "@tinycloud/share-envelope/links";
import type { SenderShareRecord } from "../history.js";
import type { PublishedShareDeliveryMaterial } from "../publish.js";

/**
 * The stored form of a share record in the space (TC-1432 slice 2, cap
 * ruling): each blob is stored once.
 *
 * A Policy/v3 record's `deliveryMaterial.envelope` is exactly what
 * `sealedEnvelope` decrypts to under `envelopeKey` (`publishAddressedShare`
 * seals `canonicalize(envelope)`). It is omitted before an agent record is
 * sealed and rebuilt when needed by {@link openDeliveryEnvelope}, for the
 * verifier and a delivery retry. `sealedEnvelope` stays (the node reopens that
 * exact value and its nonce is random) and so does the session CACAO (it
 * proves the chain). Short links stay verbatim; full links keep their original
 * renderer origin, signed header and signature beside the single sealed body.
 * Details: TC-1739
 *
 * Security-sensitive: the sealed bytes are checked against `shareCid` before
 * they are opened, and the plaintext must be the canonical JSON of the
 * envelope, so a record cannot carry one envelope for display and another for
 * the node.
 */
export interface StoredFullShareLink {
  readonly origin: string;
  readonly header: LinkHeaderV1;
  readonly signature: LinkSignatureV1;
}
export type StoredDeliveryMaterial = Omit<PublishedShareDeliveryMaterial, "envelope"> & { readonly fullLink?: StoredFullShareLink };

/** A share record as stored at an agent (or migrated) key: {@link SenderShareRecord} without derivable blobs. */
export type StoredShareRecord = Omit<SenderShareRecord, "deliveryMaterial"> & { readonly deliveryMaterial?: StoredDeliveryMaterial };

/** Required string fields; `fullLink` is optional original signed metadata. Details: TC-1739 */
export const STORED_DELIVERY_MATERIAL_KEYS: readonly string[] = ["shareCid", "sealedEnvelope", "envelopeKey"];

export class DeliveryMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryMaterialError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strict metadata container with the public header/signature validators. Details: TC-1739 */
export function checkStoredFullShareLink(value: unknown): StoredFullShareLink {
  if (!isObject(value) || Object.keys(value).length !== 3 || !["origin", "header", "signature"].every(key => Object.hasOwn(value, key))
    || typeof value.origin !== "string" || !isCanonicalHttpsOrigin(value.origin)) throw new DeliveryMaterialError("full link metadata is invalid");
  const header = validateLinkHeader(value.header, { mode: "signed" });
  const signature = linkSignatureV1Schema.parse(value.signature);
  if (header.type !== "share") throw new DeliveryMaterialError("full link is not a share");
  return { origin: value.origin, header, signature };
}

function sealedParts(material: StoredDeliveryMaterial): { readonly sealed: Uint8Array; readonly key: Uint8Array } {
  let sealed: Uint8Array;
  let key: Uint8Array;
  try {
    sealed = fromBase64Url(material.sealedEnvelope);
    key = fromBase64Url(material.envelopeKey);
  } catch {
    throw new DeliveryMaterialError("delivery material is not canonical base64url");
  }
  if (key.byteLength !== 32) throw new DeliveryMaterialError("envelope key must be 32 bytes");
  return { sealed, key };
}

/** The signed envelope inside `sealedEnvelope`; throws {@link DeliveryMaterialError} unless it is exactly that. */
export async function openDeliveryEnvelope(material: StoredDeliveryMaterial): Promise<Record<string, unknown>> {
  const { sealed, key } = sealedParts(material);
  if (await computeCid(sealed) !== material.shareCid) throw new DeliveryMaterialError("sealed envelope does not match shareCid");
  let text: string;
  let value: unknown;
  try {
    if (material.fullLink === undefined) {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await open(sealed, key));
      value = JSON.parse(text);
    } else {
      const metadata = checkStoredFullShareLink(material.fullLink);
      if (metadata.header.bodyCid !== material.shareCid) throw new DeliveryMaterialError("full link names another sealed body");
      // History verifies the original signed wrapper at issuance; the chain reports actual expiry. Details: TC-1739
      const opened = await openLinkRecord({ header: metadata.header, signature: metadata.signature, body: material.sealedEnvelope }, key, { now: Date.parse(metadata.header.issuedAt) });
      text = new TextDecoder("utf-8", { fatal: true }).decode(opened.plaintext);
      value = opened.value;
      if (typeof opened.value.expiry !== "string" || Date.parse(opened.value.expiry) !== Date.parse(metadata.header.expiresAt)) throw new DeliveryMaterialError("full link expiry differs from the sealed envelope");
    }
  } catch (error) {
    if (error instanceof DeliveryMaterialError) throw error;
    throw new DeliveryMaterialError(material.fullLink === undefined ? "sealed envelope does not open under its key" : "original full link is invalid");
  }
  if (!isObject(value) || canonicalize(value) !== text) throw new DeliveryMaterialError("sealed envelope is not canonical JSON");
  return value;
}

/**
 * A `v=4` link names its content key and body: a short link by the key `k` and
 * the body CID `c`, a full link by `k` and the record whose body it carries.
 * Either must be exactly this delivery material's key and sealed envelope.
 * Returns the link's form.
 */
export function assertLinkBoundToMaterial(link: string, material: StoredDeliveryMaterial): "short" | "full" {
  const { sealed, key } = sealedParts(material);
  let parsed: ParsedLink;
  try {
    parsed = parseLink(link, { trustedOrigins: [new URL(link).origin] });
  } catch {
    throw new DeliveryMaterialError("link is not a v=4 share link");
  }
  const sameBody = parsed.form === "short"
    ? parsed.c === material.shareCid
    : typeof parsed.record === "object" && parsed.record !== null && "body" in parsed.record && parsed.record.body === toBase64Url(sealed);
  if (!sameBody || !equalBytes(parsed.key, key)) throw new DeliveryMaterialError("link is not the link of this delivery material");
  return parsed.form;
}

/** Stores the sealed body once and retains the original signed full-link wrapper. Details: TC-1739 */
export async function compactShareRecord(record: SenderShareRecord | StoredShareRecord): Promise<StoredShareRecord> {
  const material = record.deliveryMaterial;
  if (material === undefined) return record;
  if (typeof material.shareCid !== "string" || typeof material.sealedEnvelope !== "string" || typeof material.envelopeKey !== "string") throw new DeliveryMaterialError("delivery material is incomplete");
  let fullLink = "fullLink" in material ? checkStoredFullShareLink(material.fullLink) : undefined;
  const { link, deliveryMaterial: _material, ...rest } = record;
  let keptLink: string | undefined;
  if (link !== undefined) {
    if (assertLinkBoundToMaterial(link, material) === "short") keptLink = link;
    else {
      const parsed = parseLink(link, { trustedOrigins: [new URL(link).origin] });
      if (parsed.form !== "full" || !isObject(parsed.record)) throw new DeliveryMaterialError("full link record is invalid");
      const header = validateLinkHeader(parsed.record.header, { mode: "signed" });
      const checked = await checkLinkRecord(parsed.record, Date.parse(header.issuedAt));
      if (checked.signature === undefined) throw new DeliveryMaterialError("full link signature is missing");
      const original = checkStoredFullShareLink({ origin: parsed.origin, header: checked.header, signature: checked.signature });
      if (fullLink !== undefined && canonicalize(fullLink) !== canonicalize(original)) throw new DeliveryMaterialError("full link metadata differs from the original link");
      fullLink = original;
    }
  }
  const stored: StoredDeliveryMaterial = { shareCid: material.shareCid, sealedEnvelope: material.sealedEnvelope, envelopeKey: material.envelopeKey, ...(fullLink === undefined ? {} : { fullLink }) };
  const opened = await openDeliveryEnvelope(stored);
  if ("envelope" in material && material.envelope !== undefined && canonicalize(opened) !== canonicalize(material.envelope)) throw new DeliveryMaterialError("envelope is not the sealed envelope");
  if (fullLink !== undefined && Date.parse(fullLink.header.expiresAt) !== Date.parse(record.expiresAt)) throw new DeliveryMaterialError("full link expiry differs from the record");
  return { ...rest, ...(keptLink === undefined ? {} : { link: keptLink }), deliveryMaterial: stored };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function recordLink(record: StoredShareRecord, shareOrigins: readonly string[]): string | undefined {
  const material = record.deliveryMaterial;
  if (material?.fullLink === undefined) return record.link;
  const metadata = checkStoredFullShareLink(material.fullLink);
  if (!shareOrigins.includes(metadata.origin)) throw new DeliveryMaterialError("full link origin is not trusted");
  if (Date.parse(metadata.header.expiresAt) !== Date.parse(record.expiresAt)) throw new DeliveryMaterialError("full link expiry differs from the record");
  const full = buildFullLink({ origin: metadata.origin, key: sealedParts(material).key, record: { header: metadata.header, signature: metadata.signature, body: material.sealedEnvelope } });
  if (record.link !== undefined) {
    parseLink(record.link, { trustedOrigins: shareOrigins });
    assertLinkBoundToMaterial(record.link, material);
  }
  return record.link ?? full;
}

/** Verifies and restores original full-link metadata before owner admission. Details: TC-1739 */
export async function restoreShareRecordLink(record: StoredShareRecord, shareOrigins: readonly string[]): Promise<string | undefined> {
  if (record.deliveryMaterial?.fullLink !== undefined) await openDeliveryEnvelope(record.deliveryMaterial);
  return recordLink(record, shareOrigins);
}

/** Expands stored material; owner admission additionally supplies trusted origins and verifies the chain. Details: TC-1739 */
export async function expandShareRecord(record: StoredShareRecord, options: { readonly shareOrigins?: readonly string[] } = {}): Promise<SenderShareRecord> {
  const material = record.deliveryMaterial;
  if (material === undefined) {
    const { deliveryMaterial: _material, ...withoutMaterial } = record;
    return withoutMaterial;
  }
  const envelope = await openDeliveryEnvelope(material);
  const origins = options.shareOrigins ?? (material.fullLink === undefined ? [] : [checkStoredFullShareLink(material.fullLink).origin]);
  const link = recordLink(record, origins);
  return { ...record, ...(link === undefined ? {} : { link }), deliveryMaterial: { ...material, envelope } };
}
