import { canonicalize, computeCid, encodeSealedInlineShareUrl, fromBase64Url, open, parseSealedInlineShareUrl } from "@tinycloud/share-envelope";
import type { SenderShareRecord } from "../history.js";
import type { PublishedShareDeliveryMaterial } from "../publish.js";

/**
 * The stored form of a share record in the space (TC-1432 slice 2, cap
 * ruling): each blob is stored once.
 *
 * A Policy/v3 record's `deliveryMaterial.envelope` is exactly what
 * `sealedEnvelope` decrypts to under `envelopeKey` (`publishAddressedShare`
 * seals `canonicalize(envelope)`), and its `/s/inline` link is
 * `sealedEnvelope`, its CID and `envelopeKey` encoded again. Both are
 * dropped before an agent record is sealed and rebuilt when needed:
 * {@link openDeliveryEnvelope} for the verifier and a delivery retry,
 * {@link shareLinkForRecord} at Open/Copy. `sealedEnvelope` stays (the node
 * reopens that exact value and its nonce is random) and so does the session
 * CACAO (it proves the chain). A bearer record keeps its `link`, which is
 * not derivable.
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
 * The link to show at Open/Copy: a bearer record's stored `link`, or a
 * Policy/v3 record's `/s/inline` link rebuilt on `shareOrigin` (the
 * viewer's configured share origin) from `sealedEnvelope` and `envelopeKey`.
 */
export async function shareLinkForRecord(record: Pick<StoredShareRecord, "link" | "deliveryMaterial">, shareOrigin: string): Promise<string | undefined> {
  if (record.link !== undefined) return record.link;
  const material = record.deliveryMaterial;
  if (material === undefined) return undefined;
  const { sealed, key } = sealedParts(material);
  if (await computeCid(sealed) !== material.shareCid) throw new DeliveryMaterialError("sealed envelope does not match shareCid");
  return encodeSealedInlineShareUrl({ origin: shareOrigin, ciphertext: sealed, key32: key });
}

/**
 * The stored form of `record`. For a Policy/v3 record (one with
 * `deliveryMaterial`), drops `deliveryMaterial.envelope` and `link` after
 * checking they are exactly what the sealed material rebuilds, so nothing is
 * lost. Throws {@link DeliveryMaterialError} otherwise.
 */
export async function compactShareRecord(record: SenderShareRecord | StoredShareRecord): Promise<StoredShareRecord> {
  const material = record.deliveryMaterial as Partial<PublishedShareDeliveryMaterial> | undefined;
  if (material === undefined) return record as StoredShareRecord;
  if (typeof material.shareCid !== "string" || typeof material.sealedEnvelope !== "string" || typeof material.envelopeKey !== "string") throw new DeliveryMaterialError("delivery material is incomplete");
  const stored: StoredDeliveryMaterial = { shareCid: material.shareCid, sealedEnvelope: material.sealedEnvelope, envelopeKey: material.envelopeKey };
  const opened = await openDeliveryEnvelope(stored);
  if (material.envelope !== undefined && canonicalize(opened) !== canonicalize(material.envelope)) throw new DeliveryMaterialError("envelope is not the sealed envelope");
  const { link, deliveryMaterial: _material, ...rest } = record;
  if (link !== undefined) {
    const { sealed, key } = sealedParts(stored);
    let parsed: Awaited<ReturnType<typeof parseSealedInlineShareUrl>> | undefined;
    try { parsed = await parseSealedInlineShareUrl(link); } catch { parsed = undefined; }
    if (parsed === undefined || parsed.ciphertextCid !== stored.shareCid || !equalBytes(parsed.ciphertext, sealed) || !equalBytes(parsed.key32, key)) {
      throw new DeliveryMaterialError("link is not the sealed-inline link of this delivery material");
    }
  }
  return { ...rest, deliveryMaterial: stored };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * The full record again (for a delivery retry or a caller that wants the
 * {@link SenderShareRecord} shape): the envelope reopened from the sealed
 * material and, when `shareOrigin` is given, the `/s/inline` link rebuilt.
 */
export async function expandShareRecord(record: StoredShareRecord, shareOrigin?: string): Promise<SenderShareRecord> {
  const material = record.deliveryMaterial;
  if (material === undefined) return record as SenderShareRecord;
  const envelope = await openDeliveryEnvelope(material);
  const link = shareOrigin === undefined ? record.link : await shareLinkForRecord(record, shareOrigin);
  return { ...record, ...(link === undefined ? {} : { link }), deliveryMaterial: { ...material, envelope } };
}
