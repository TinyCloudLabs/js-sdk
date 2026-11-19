import { z } from "zod";

import { generateKey, seal } from "../aead.js";
import { toBase64Url } from "../bytes.js";
import { canonicalize } from "../jcs.js";
import { computeCid } from "../cid.js";
import { LINK_ID_PATTERN, MAX_LINK_BODY_BYTES, LINK_MAX_RECORD_HEADER_BYTES, LINK_TYPE_SPECS, type LinkType } from "./constants.js";
import { LinkError } from "./errors.js";
import { buildShortLink, normalizeLinkId, parseLink } from "./grammar.js";
import {
  checkLinkBody,
  checkLinkHeaderLife,
  decodeStrictBase64Url,
  isPlainObject,
  randomLinkNonce,
  signDelete,
  signHeader,
  validateLinkHeader,
  type LinkDeleteRequestV1,
  type LinkRecord,
} from "./header.js";
import { openRecordChecked, runBodyValidator, toEpochMs, type LinkBodyValidator, type OpenedLink } from "./record.js";
import type { LinkSigner } from "./signer.js";
import { parseApprovalRequest, type OpenKeyApprovalRequestV1 } from "./approval-request.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_JSON_RESPONSE_BYTES = 4096;
const AUDIENCE_ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/;
const createdSchema = z.object({ id: z.string(), expiresAt: z.string() }).strict();
const errorBodySchema = z.object({ error: z.string() }).passthrough();

/** A body the caller already sealed with the key that will go in the link. */
export interface SealedLinkBody {
  readonly blob: Uint8Array;
  readonly key: Uint8Array;
}

export interface LinkTransportOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

type SealedOrPlain =
  | { readonly plaintext: Uint8Array; readonly sealed?: never }
  | { readonly sealed: SealedLinkBody; readonly plaintext?: never };

type LinkRecordInput = {
  readonly type: LinkType;
  readonly issuerKey: LinkSigner;
  /** Origin of the links API; written into the header as `audience`. */
  readonly apiOrigin: string;
  readonly expiresAt: Date;
  readonly now?: Date | number;
} & SealedOrPlain;

export type PrepareLinkRecordInput = LinkRecordInput & {
  /**
   * Apply the service's create-time life rules (default `true`). A record that
   * only travels in a full link is not stored, so its life is not bound by them.
   * The body limit applies either way.
   */
  readonly enforceServiceLife?: boolean;
};

export interface PreparedLinkRecord {
  readonly record: LinkRecord;
  /** The content key. It belongs in the link fragment and nowhere else. */
  readonly key: Uint8Array;
  readonly bodyCid: string;
}

export type CreateLinkInput = LinkTransportOptions &
  LinkRecordInput & {
    /** Origin the link points at: the viewer for the type (see the contract's origin table). */
    readonly linkOrigin: string;
  };

export interface CreatedLink {
  /** The short link, with the key and the body CID in its fragment. */
  readonly link: string;
  readonly id: string;
  readonly expiresAt: string;
  readonly bodyCid: string;
}

function checkApiOrigin(origin: string): string {
  if (!AUDIENCE_ORIGIN.test(origin)) throw new LinkError("invalid_argument", "the API origin is not a canonical https origin");
  return origin;
}

function requestSignal(options: LinkTransportOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
}

async function send(url: string, init: { readonly method: "GET" | "POST"; readonly body?: string }, options: LinkTransportOptions, accept: string): Promise<Response> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  try {
    return await fetchFn(url, {
      method: init.method,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      headers: init.body === undefined ? { accept } : { accept, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: requestSignal(options),
    });
  } catch (cause) {
    throw new LinkError("service_unavailable", "the links service could not be reached", { cause });
  }
}

/** Read a response body, refusing as soon as it exceeds `cap` bytes. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > cap) throw new LinkError("response_too_large");
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        throw new LinkError("response_too_large");
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof LinkError) throw cause;
    throw new LinkError("service_unavailable", "the links service response was interrupted", { cause });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function readJson(response: Response): Promise<unknown> {
  const bytes = await readCapped(response, MAX_JSON_RESPONSE_BYTES);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

async function refusal(response: Response): Promise<LinkError> {
  const body = errorBodySchema.safeParse(await readJson(response).catch(() => undefined));
  const serviceError = body.success && /^[a-z_]{1,32}$/.test(body.data.error) ? body.data.error : undefined;
  return new LinkError("service_refused", `the links service refused the request (HTTP ${response.status})`, {
    status: response.status,
    ...(serviceError === undefined ? {} : { serviceError }),
  });
}

/**
 * Seal (or take the sealed body), build the header, check it and sign it. The
 * result is the record a create request carries and a full link embeds.
 */
export async function prepareLinkRecord(input: PrepareLinkRecordInput): Promise<PreparedLinkRecord> {
  const apiOrigin = checkApiOrigin(input.apiOrigin);
  const nowMs = toEpochMs(input.now);
  // The header carries whole seconds, truncated toward the past: it never runs later than the caller's expiresAt.
  const expiresMs = Math.floor(input.expiresAt.getTime() / 1000) * 1000;
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs)) throw new LinkError("invalid_argument", "now and expiresAt must be valid dates");
  let blob: Uint8Array;
  let key: Uint8Array;
  if (input.sealed !== undefined) {
    ({ blob, key } = input.sealed);
    if (key.length !== 32) throw new LinkError("invalid_argument", "a link key is 32 bytes");
  } else {
    key = generateKey();
    blob = (await seal(input.plaintext, key)).blob;
  }
  const bodyCid = await computeCid(blob);
  const header = validateLinkHeader(
    {
      version: 1,
      type: input.type,
      issuer: input.issuerKey.did,
      audience: apiOrigin,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      size: blob.length,
      bodyCid,
      nonce: randomLinkNonce(),
    },
    { mode: "signed", audience: apiOrigin },
  );
  if (input.enforceServiceLife ?? true) checkLinkHeaderLife(header, nowMs);
  else if (expiresMs <= nowMs) throw new LinkError("already_expired");
  checkLinkBody(header, blob, bodyCid);
  const signature = await signHeader(header, input.issuerKey);
  return { record: { header, signature, body: toBase64Url(blob) }, key, bodyCid };
}

/**
 * Seal (or take the sealed body), build and sign the header, post it to the
 * links API and build the short link. The content key appears only in the
 * returned link: the request carries the header, the signature and the sealed
 * body. The header's life, window and size are checked here before anything is
 * sent; the service checks them again.
 */
export async function createLink(input: CreateLinkInput): Promise<CreatedLink> {
  const { record, key, bodyCid } = await prepareLinkRecord({ ...input, enforceServiceLife: true });
  const response = await send(`${checkApiOrigin(input.apiOrigin)}/v1/links`, { method: "POST", body: JSON.stringify(record) }, input, "application/json");
  if (response.status !== 201) throw await refusal(response);
  const created = createdSchema.safeParse(await readJson(response));
  if (!created.success || !LINK_ID_PATTERN.test(created.data.id) || created.data.expiresAt !== record.header.expiresAt) throw new LinkError("invalid_response");
  const { id } = created.data;
  return { link: buildShortLink({ origin: input.linkOrigin, type: input.type, id, key, bodyCid }), id, expiresAt: record.header.expiresAt, bodyCid };
}

/** Store one immutable request. The Worker sees only its signed header and sealed bytes. */
export async function createApprovalRequest(input: LinkTransportOptions & {
  readonly request: OpenKeyApprovalRequestV1;
  readonly issuerKey: LinkSigner;
  readonly apiOrigin: string;
  readonly openkeyOrigin: string;
  readonly expiresAt?: Date;
  readonly now?: Date | number;
}): Promise<CreatedLink & { readonly record: LinkRecord }> {
  const request = parseApprovalRequest(input.request, { issuer: input.issuerKey.did });
  const now = toEpochMs(input.now);
  const prepared = await prepareLinkRecord({
    type: "openkey-approval-request", issuerKey: input.issuerKey, apiOrigin: input.apiOrigin,
    now, expiresAt: input.expiresAt ?? new Date(now + LINK_TYPE_SPECS["openkey-approval-request"].defaultLifeSeconds * 1000),
    plaintext: new TextEncoder().encode(canonicalize(request)),
  });
  const response = await send(`${checkApiOrigin(input.apiOrigin)}/v1/links`,
    { method: "POST", body: JSON.stringify(prepared.record) }, input, "application/json");
  if (response.status !== 201) throw await refusal(response);
  const created = createdSchema.safeParse(await readJson(response));
  if (!created.success || !LINK_ID_PATTERN.test(created.data.id) || created.data.expiresAt !== prepared.record.header.expiresAt) throw new LinkError("invalid_response");
  return {
    id: created.data.id, expiresAt: prepared.record.header.expiresAt, bodyCid: prepared.bodyCid, record: prepared.record,
    link: buildShortLink({ origin: input.openkeyOrigin, type: "openkey-approval-request", id: created.data.id, key: prepared.key, bodyCid: prepared.bodyCid }),
  };
}

/**
 * Delete a link with an issuer-signed request. `deleted` when the service
 * removed it; `absent` when it answered `404` (unknown, expired, already
 * deleted, or issued by someone else: the service does not say which).
 */
export async function deleteLink(
  input: LinkTransportOptions & { readonly id: string; readonly issuerKey: LinkSigner; readonly apiOrigin: string; readonly now?: Date | number },
): Promise<"deleted" | "absent"> {
  const apiOrigin = checkApiOrigin(input.apiOrigin);
  const id = normalizeLinkId(input.id);
  if (id === null) throw new LinkError("id_grammar");
  const request: LinkDeleteRequestV1 = {
    version: 1,
    op: "delete",
    id,
    issuer: input.issuerKey.did,
    audience: apiOrigin,
    issuedAt: new Date(toEpochMs(input.now)).toISOString(),
    nonce: randomLinkNonce(),
  };
  const signature = await signDelete(request, input.issuerKey);
  const response = await send(`${apiOrigin}/v1/links/${id}/delete`, { method: "POST", body: JSON.stringify({ request, signature }) }, input, "application/json");
  if (response.status === 204) return "deleted";
  if (response.status === 404) return "absent";
  throw await refusal(response);
}

export type ResolveLinkInput = LinkTransportOptions & {
  /** Viewer origins this reader trusts. The link's origin must be one of them. */
  readonly trustedOrigins: readonly string[];
  /** The API origin, from configuration. A link never names it. */
  readonly apiOrigin: string;
  readonly now?: Date | number;
  /** Runs on the opened plaintext after every contract check; throw to refuse. */
  readonly validateBody?: LinkBodyValidator;
};

export interface ResolvedLink extends OpenedLink {
  readonly form: "short" | "full";
  /** The id of a short link. */
  readonly id: string | undefined;
}

/** The stored header record of a short link: the raw objects, so a key outside the field set is still there for the checks. */
interface RecordHeader {
  readonly header: unknown;
  readonly signature?: unknown;
}

function parseRecordHeader(text: string | null): RecordHeader {
  if (text === null || text.length === 0 || text.length > LINK_MAX_RECORD_HEADER_BYTES) throw new LinkError("invalid_response");
  const bytes = decodeStrictBase64Url(text);
  let decoded: string;
  let value: unknown;
  try {
    if (bytes === null) throw new Error("encoding");
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(decoded);
  } catch {
    throw new LinkError("invalid_response");
  }
  if (!isPlainObject(value) || Object.keys(value).some((name) => name !== "header" && name !== "signature")) throw new LinkError("invalid_response");
  if (!isPlainObject(value.header) || ("signature" in value && !isPlainObject(value.signature))) throw new LinkError("invalid_response");
  // The text that is verified is the JCS text: a repeated key, white space or another key order is refused.
  let canonical: string;
  try {
    canonical = canonicalize(value);
  } catch {
    throw new LinkError("record_not_canonical");
  }
  if (canonical !== decoded) throw new LinkError("record_not_canonical");
  return { header: value.header, ..."signature" in value ? { signature: value.signature } : {} };
}

async function fetchShortRecord(
  parsed: { readonly id: string; readonly pathType: LinkType },
  input: ResolveLinkInput,
): Promise<{ readonly header: unknown; readonly signature?: unknown; readonly body: string }> {
  const apiOrigin = checkApiOrigin(input.apiOrigin);
  const spec = LINK_TYPE_SPECS[parsed.pathType];
  // A read-once type is consumed by an explicit `take`; `GET` never serves it.
  const url = spec.readOnce ? `${apiOrigin}/v1/links/${parsed.id}/take` : `${apiOrigin}/v1/links/${parsed.id}`;
  const response = await send(url, { method: spec.readOnce ? "POST" : "GET" }, input, "application/octet-stream");
  if (response.status === 404) throw new LinkError("gone", "the link is unknown, expired, deleted or already used", { status: 404, serviceError: "not_found" });
  if (response.status !== 200) throw await refusal(response);
  if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/octet-stream")) throw new LinkError("invalid_response");
  const record = parseRecordHeader(response.headers.get("x-link-record"));
  const body = await readCapped(response, MAX_LINK_BODY_BYTES);
  return { ...record, body: toBase64Url(body) };
}

/**
 * The reader pipeline. Parse the link under the strict grammar; fetch the
 * record from the configured API (short form) or take it from the fragment
 * (full form); run every record check; open the body with the link's key; bind
 * the link, the path letter, the record and the sealed issuer; then run the
 * caller's validator. The opened plaintext is returned only if all of that
 * passes. The key is never sent in any request.
 */
export async function resolveLink(link: string, input: ResolveLinkInput): Promise<ResolvedLink> {
  const parsed = parseLink(link, { trustedOrigins: input.trustedOrigins });
  const record = parsed.form === "short" ? await fetchShortRecord(parsed, input) : parsed.record;
  const opened = await openRecordChecked(record, parsed.key, toEpochMs(input.now));
  if (parsed.form === "short") {
    if (parsed.pathType !== opened.type) throw new LinkError("type_path_mismatch");
    if (parsed.c !== opened.header.bodyCid) throw new LinkError("link_cid_mismatch");
  } else if (opened.type !== "share") {
    throw new LinkError("full_non_share");
  }
  if (opened.type === "openkey-approval-request") {
    if (opened.header.audience !== input.apiOrigin) throw new LinkError("audience_mismatch");
    parseApprovalRequest(opened.value, { issuer: opened.header.issuer });
  }
  await runBodyValidator(opened, input.validateBody);
  return { ...opened, form: parsed.form, id: parsed.form === "short" ? parsed.id : undefined };
}

/** Repeatable GET plus the same strict signature/CID/AEAD/issuer pipeline as every typed link. */
export async function resolveApprovalRequest(link: string, input: ResolveLinkInput): Promise<ResolvedLink & { readonly request: OpenKeyApprovalRequestV1 }> {
  const opened = await resolveLink(link, input);
  if (opened.type !== "openkey-approval-request") throw new LinkError("type_path_mismatch");
  if (opened.header.audience !== input.apiOrigin) throw new LinkError("audience_mismatch");
  const request = parseApprovalRequest(opened.value, { issuer: opened.header.issuer });
  return { ...opened, request };
}
