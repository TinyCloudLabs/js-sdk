import { computeCid, fromBase64Url, shareEnvelopeV2Schema, type ShareEnvelopeV2 } from "@tinycloud/share-envelope";

export interface ParsedAddressedEnvelope {
  readonly envelope: ShareEnvelopeV2;
  readonly policy: Record<string, unknown>;
  readonly policyCid: string;
}

/** Parse and bind the signed policy bytes before any holder or node effect. */
export async function parseAddressedEnvelope(value: unknown): Promise<ParsedAddressedEnvelope> {
  const envelope = shareEnvelopeV2Schema.parse(value);
  if (envelope.authorizationTarget.kind !== "policy") throw new TypeError("addressed envelope target");
  const bytes = fromBase64Url(envelope.authorizationTarget.policyBytes);
  if (await computeCid(bytes) !== envelope.authorizationTarget.policyCid) throw new TypeError("addressed policy CID");
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { throw new TypeError("addressed policy bytes"); }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new TypeError("addressed policy object");
  return { envelope, policy: decoded as Record<string, unknown>, policyCid: envelope.authorizationTarget.policyCid };
}
