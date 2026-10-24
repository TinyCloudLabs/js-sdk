import { canonicalize, computeCid, fromBase64Url, open, toBase64Url } from "@tinycloud/share-envelope";
import { parseLink, type ParsedLink } from "@tinycloud/share-envelope/links";
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
 * proves the chain). A short `v=4` link the sender printed is kept (it is not
 * derivable: it carries an id only the links service knows) and must be the
 * link of this material; a full link is not kept (see {@link compactShareRecord}).
 *
 * Security-sensitive: the sealed bytes are checked against `shareCid` before
 * they are opened, and the plaintext must be the canonical JSON of the
 * envelope, so a record cannot carry one envelope for display and another for
 * the node.
 */
export type StoredDeliveryMaterial = Omit<PublishedShareDeliveryMaterial, "envelope">;

/** A share record as stored at an agent (or migrated) key: {@link SenderShareRecord} without derivable blobs. */
export type StoredShareRecord = Omit<SenderShareRecord, "deliveryMaterial"> & { readonly deliveryMaterial?: StoredDeliveryMaterial };

/** Keys of a stored `deliveryMaterial`, exactly. */
export const STORED_DELIVERY_MATERIAL_KEYS: readonly string[] = ["shareCid", "sealedEnvelope", "envelopeKey"];

export class DeliveryMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryMaterialError";
  }
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
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await open(sealed, key));
  } catch {
    throw new DeliveryMaterialError("sealed envelope does not open under its key");
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new DeliveryMaterialError("sealed envelope is not JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value) || canonicalize(value) !== text) throw new DeliveryMaterialError("sealed envelope is not canonical JSON");
  return value as Record<string, unknown>;
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

/**
 * The stored form of `record`. For a Policy/v3 record (one with
 * `deliveryMaterial`), omits `deliveryMaterial.envelope` after checking it is
 * exactly what the sealed material opens to, and checks that a `link` is the
 * link of that material. A short link is kept. A full link is not: it embeds
 * the sealed envelope a second time, which the record size cap does not leave
 * room for, so the sender's own history holds it. Throws
 * {@link DeliveryMaterialError} otherwise.
 */
export async function compactShareRecord(record: SenderShareRecord | StoredShareRecord): Promise<StoredShareRecord> {
  const material = record.deliveryMaterial as Partial<PublishedShareDeliveryMaterial> | undefined;
  if (material === undefined) return record as StoredShareRecord;
  if (typeof material.shareCid !== "string" || typeof material.sealedEnvelope !== "string" || typeof material.envelopeKey !== "string") throw new DeliveryMaterialError("delivery material is incomplete");
  const stored: StoredDeliveryMaterial = { shareCid: material.shareCid, sealedEnvelope: material.sealedEnvelope, envelopeKey: material.envelopeKey };
  const opened = await openDeliveryEnvelope(stored);
  if (material.envelope !== undefined && canonicalize(opened) !== canonicalize(material.envelope)) throw new DeliveryMaterialError("envelope is not the sealed envelope");
  const { link, deliveryMaterial: _material, ...rest } = record;
  const keptLink = link !== undefined && assertLinkBoundToMaterial(link, stored) === "short" ? link : undefined;
  return { ...rest, ...(keptLink === undefined ? {} : { link: keptLink }), deliveryMaterial: stored };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * The full record again (for a delivery retry or a caller that wants the
 * {@link SenderShareRecord} shape): the envelope reopened from the sealed
 * material. The stored `link` is returned as it was stored.
 */
export async function expandShareRecord(record: StoredShareRecord): Promise<SenderShareRecord> {
  const material = record.deliveryMaterial;
  if (material === undefined) return record as SenderShareRecord;
  const envelope = await openDeliveryEnvelope(material);
  return { ...record, deliveryMaterial: { ...material, envelope } };
}
