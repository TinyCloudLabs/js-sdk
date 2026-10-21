import {
  computeCid,
  encodeSealedInlineShareUrl,
  fromBase64Url,
  parseSealedInlineShareUrl,
  parseShortShareUrl,
  rebuildInlineFromShort,
  splitInlineToShort,
  SHORT_LINK_ID_PATTERN,
  toBase64Url,
  type InlineSharePayload,
  type ParsedShortShareUrl,
} from "@tinycloud/share-envelope";
import type { IKVService } from "@tinycloud/node-sdk";
import type { PublishedShare, SenderShareRecord } from "@tinycloud/share-sdk";

/**
 * Short links for addressed (sealed-inline) shares, TC-1737.
 *
 * The short-link service on the Share origin stores only the sealed envelope
 * bytes under a random id. The key and the CID of those bytes stay in the
 * link's fragment, so the service never receives anything that decrypts the
 * share, and a reader checks the returned bytes against the link's own CID.
 *
 * Sender history keeps the inline link: delivery material is checked against
 * it and the invitation email still carries it.
 */

/** Matches the service's 128 KiB cap on the decoded bytes. */
export const MAX_SHORT_LINK_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const DELETE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type ShortLinkErrorCode = "rate-limited" | "capacity" | "rejected" | "unavailable" | "invalid-response" | "not-found" | "too-large" | "token-store-failed";

export class ShortLinkError extends Error {
  constructor(readonly code: ShortLinkErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ShortLinkError";
  }
}

export interface ShortLinkRecord {
  readonly id: string;
  readonly deleteToken: string;
}

/** Where the creator keeps each short link's delete token, in the owner's `default` space: see {@link shortLinkTokenKey}. */
export interface ShortLinkTokenStore {
  read(shareId: string): Promise<ShortLinkRecord | undefined>;
  write(shareId: string, record: ShortLinkRecord): Promise<void>;
  remove(shareId: string): Promise<void>;
}

/**
 * The delete-token record of a share. It is the same key in the Share web composer, so a share published in one
 * client can be revoked from the other. The leading dot keeps it apart from shared content: no stored filename
 * can start with one.
 */
export function shortLinkTokenKey(shareId: string): string {
  return `xyz.tinycloud.share/shares/${shareId}/.short-link.json`;
}

/** Read a response body as bytes, refusing more than `max` while it streams rather than after buffering it. */
async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ShortLinkError("too-large", "the short-link service returned too many bytes");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Strict decode of a stored token file; anything else reads as absent. */
export function parseShortLinkRecord(bytes: Uint8Array): ShortLinkRecord | undefined {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !SHORT_LINK_ID_PATTERN.test(record.id)) return undefined;
  if (typeof record.deleteToken !== "string" || !DELETE_TOKEN.test(record.deleteToken)) return undefined;
  return { id: record.id, deleteToken: record.deleteToken };
}

export function serializeShortLinkRecord(record: ShortLinkRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ id: record.id, deleteToken: record.deleteToken }));
}

function request(init: RequestInit, timeoutMs: number): RequestInit {
  // The CLI is not a browser: no cookies, no redirects to another origin, no referrer. The timeout covers the
  // response body too, so a blackholed or stalled service ends in an error, never a hang.
  return { ...init, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(timeoutMs) };
}

async function send(fetchFn: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetchFn(url, request(init, timeoutMs));
  } catch (error) {
    throw new ShortLinkError("unavailable", "the short-link service could not be reached", { cause: error });
  }
}

function statusError(response: Response): ShortLinkError {
  if (response.status === 429) return new ShortLinkError("rate-limited", "the short-link service is rate limiting this client");
  if (response.status === 503) return new ShortLinkError("capacity", "the short-link service is at capacity");
  if (response.status === 404) return new ShortLinkError("not-found", "the short link has expired, was revoked, or never existed");
  if (response.status >= 400 && response.status < 500) return new ShortLinkError("rejected", `the short-link service rejected the request (HTTP ${response.status})`);
  return new ShortLinkError("unavailable", `the short-link service failed (HTTP ${response.status})`);
}

export interface ShortLinkClient {
  create(ciphertext: Uint8Array, expiresAt: Date): Promise<ShortLinkRecord>;
  fetchCiphertext(id: string): Promise<Uint8Array>;
  delete(record: ShortLinkRecord): Promise<"deleted" | "absent">;
}

/** Client for `${origin}/api/share-links`. It never sends a key, a fragment, or a full link. */
export function createShortLinkClient(origin: string, fetchFn: typeof fetch = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS): ShortLinkClient {
  const base = `${origin}/api/share-links`;
  return {
    async create(ciphertext, expiresAt) {
      if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_SHORT_LINK_BYTES) throw new ShortLinkError("too-large", "the sealed share is too large for a short link");
      const expectedCid = await computeCid(ciphertext);
      const response = await send(fetchFn, base, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ciphertext: toBase64Url(ciphertext), expiresAt: expiresAt.toISOString() }),
      }, timeoutMs);
      if (response.status !== 201) throw statusError(response);
      let value: unknown;
      try { value = await response.json(); } catch { throw new ShortLinkError("invalid-response", "the short-link service returned an unreadable response"); }
      const body = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
      if (typeof body.id !== "string" || !SHORT_LINK_ID_PATTERN.test(body.id)) throw new ShortLinkError("invalid-response", "the short-link service returned an invalid id");
      if (typeof body.deleteToken !== "string" || !DELETE_TOKEN.test(body.deleteToken) || fromBase64Url(body.deleteToken).byteLength !== 32) {
        throw new ShortLinkError("invalid-response", "the short-link service returned an invalid delete token");
      }
      // The service hashes what it stored; a different CID means it stored other bytes.
      if (body.cid !== expectedCid) throw new ShortLinkError("invalid-response", "the short-link service stored different bytes than were sent");
      return { id: body.id, deleteToken: body.deleteToken };
    },
    async fetchCiphertext(id) {
      if (!SHORT_LINK_ID_PATTERN.test(id)) throw new ShortLinkError("not-found", "the short link has expired, was revoked, or never existed");
      const response = await send(fetchFn, `${base}/${id}`, { method: "GET", headers: { accept: "application/octet-stream" } }, timeoutMs);
      if (response.status !== 200) throw statusError(response);
      if ((response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "application/octet-stream") {
        await response.body?.cancel().catch(() => undefined);
        throw new ShortLinkError("invalid-response", "the short-link service did not return sealed bytes");
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_SHORT_LINK_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new ShortLinkError("too-large", "the short-link service returned too many bytes");
      }
      const bytes = await readCapped(response, MAX_SHORT_LINK_BYTES);
      if (bytes.byteLength === 0) throw new ShortLinkError("invalid-response", "the short-link service returned no bytes");
      return bytes;
    },
    async delete(record) {
      const response = await send(fetchFn, `${base}/${record.id}`, { method: "DELETE", headers: { authorization: `Bearer ${record.deleteToken}` } }, timeoutMs);
      if (response.status === 204) return "deleted";
      // Uniform 404: already deleted, expired, or a token that never matched. None is retryable.
      if (response.status === 404) return "absent";
      throw statusError(response);
    },
  };
}

/**
 * Create the short link for a published sealed-inline link and keep its delete
 * token. When the token cannot be kept the stored bytes are deleted again, so
 * a short link always has a recorded way to remove it.
 */
export async function shortenInlineLink(input: {
  readonly inlineUrl: string;
  readonly shareId: string;
  readonly expiresAt: Date;
  readonly client: ShortLinkClient;
  readonly tokens: ShortLinkTokenStore;
}): Promise<string> {
  const inline = await parseSealedInlineShareUrl(input.inlineUrl);
  const record = await input.client.create(inline.ciphertext, input.expiresAt);
  try {
    await input.tokens.write(input.shareId, record);
  } catch (error) {
    await input.client.delete(record).catch(() => undefined);
    throw new ShortLinkError("token-store-failed", "the short link's delete token could not be saved", { cause: error });
  }
  return splitInlineToShort(input.inlineUrl, record.id);
}

/** Resolve a short link to the equivalent sealed-inline link; any other link is returned unchanged. */
export async function resolveShortLink(link: string, options: { readonly expectedOrigin: string; readonly fetchFn?: typeof fetch }): Promise<string> {
  let short: ParsedShortShareUrl;
  try { short = parseShortShareUrl(link); } catch { return link; }
  // Read the bytes only from the trusted Share origin, never from the link's own host.
  if (short.origin !== options.expectedOrigin) throw new ShortLinkError("rejected", "the short link is not from the trusted Share origin");
  const ciphertext = await createShortLinkClient(options.expectedOrigin, options.fetchFn).fetchCiphertext(short.id);
  let payload: InlineSharePayload;
  try {
    payload = await rebuildInlineFromShort(link, toBase64Url(ciphertext));
  } catch (error) {
    throw new ShortLinkError("invalid-response", "the short-link service returned bytes that do not match the link", { cause: error });
  }
  return encodeSealedInlineShareUrl({ origin: short.origin, ciphertext: fromBase64Url(payload.c), key32: fromBase64Url(payload.k) });
}

function kvErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Delete tokens kept in the owner's own KV, next to the share they belong to. */
export function kvShortLinkTokenStore(kv: () => Promise<IKVService>): ShortLinkTokenStore {
  return {
    async read(shareId) {
      const read = await (await kv()).get<Uint8Array>(shortLinkTokenKey(shareId), { binary: true });
      if (read.ok) return parseShortLinkRecord(new Uint8Array(read.data.data));
      if (kvErrorCode(read.error) === "KV_NOT_FOUND") return undefined;
      throw new Error(`could not read the short-link token (${kvErrorCode(read.error) ?? "unknown error"})`);
    },
    async write(shareId, record) {
      const written = await (await kv()).put(shortLinkTokenKey(shareId), serializeShortLinkRecord(record), { contentType: "application/json" });
      if (!written.ok) throw new Error(`could not write the short-link token (${kvErrorCode(written.error) ?? "unknown error"})`);
    },
    async remove(shareId) {
      const removed = await (await kv()).delete(shortLinkTokenKey(shareId));
      if (!removed.ok && kvErrorCode(removed.error) !== "KV_NOT_FOUND") throw new Error(`could not remove the short-link token (${kvErrorCode(removed.error) ?? "unknown error"})`);
    },
  };
}

/** Short links as the share commands use them. Only addressed (sealed-inline) shares get one. */
export interface ShareShortLinks {
  /** The short link for a just-published addressed share. Throws {@link ShortLinkError}; the caller falls back to the inline link. */
  shorten(published: PublishedShare): Promise<string>;
  /** The short link of a recorded share, when one was created for it. */
  linkFor(record: SenderShareRecord): Promise<string | undefined>;
  /** Delete a revoked share's short link. Never throws. */
  discard(record: SenderShareRecord): Promise<"deleted" | "none" | "failed">;
  /** Resolve a short link to its sealed-inline link; other links are returned unchanged. */
  resolve(link: string, expectedOrigin: string): Promise<string>;
}

function isInlineLink(link: string | undefined): link is string {
  if (link === undefined) return false;
  try { return new URL(link).pathname === "/s/inline"; } catch { return false; }
}

export function createShareShortLinks(input: {
  readonly kvForSpace: (spaceId: string) => Promise<IKVService>;
  readonly fetchFn?: typeof fetch;
  /** Per-request limit for the short-link service, body included. */
  readonly timeoutMs?: number;
}): ShareShortLinks {
  const tokens = (spaceId: string): ShortLinkTokenStore => kvShortLinkTokenStore(() => input.kvForSpace(spaceId));
  const client = (inlineUrl: string): ShortLinkClient => createShortLinkClient(new URL(inlineUrl).origin, input.fetchFn, input.timeoutMs);
  return {
    async shorten(published) {
      if (published.link.kind !== "policy" || !isInlineLink(published.url)) throw new ShortLinkError("rejected", "only addressed shares get a short link");
      return shortenInlineLink({
        inlineUrl: published.url,
        shareId: published.metadata.shareId,
        expiresAt: new Date(published.metadata.expiresAt),
        client: client(published.url),
        tokens: tokens(published.metadata.target.spaceId),
      });
    },
    async linkFor(record) {
      if (!isInlineLink(record.link)) return undefined;
      const inlineUrl = record.link;
      // Without a readable token file the recorded long link is revealed instead.
      const stored = await tokens(record.target.spaceId).read(record.shareId).catch(() => undefined);
      return stored === undefined ? undefined : splitInlineToShort(inlineUrl, stored.id).catch(() => undefined);
    },
    async discard(record) {
      if (!isInlineLink(record.link)) return "none";
      return discardShortLink(record.shareId, client(record.link), tokens(record.target.spaceId));
    },
    resolve: (link, expectedOrigin) => resolveShortLink(link, { expectedOrigin, ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }) }),
  };
}

/** Delete a share's short link after the share itself was revoked. Never throws: revocation already happened. */
export async function discardShortLink(shareId: string, client: ShortLinkClient, tokens: ShortLinkTokenStore): Promise<"deleted" | "none" | "failed"> {
  let record: ShortLinkRecord | undefined;
  try { record = await tokens.read(shareId); } catch { return "failed"; }
  if (record === undefined) return "none";
  try {
    await client.delete(record);
  } catch {
    return "failed";
  }
  await tokens.remove(shareId).catch(() => undefined);
  return "deleted";
}
