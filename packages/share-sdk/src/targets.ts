import type { ShareAuthorizationRequired, ShareAuthorizationMethod } from "./authorization.js";
import { authorizationMethodForTarget } from "./authorization.js";
import { DEFAULT_SHARE_LIFETIME_MS, SharePublishError, SHARE_CONTENT_LIMIT, type PublishedShare, type SharePublishOptions, type SharePublishTarget } from "./publish.js";
import { base58btc } from "multiformats/bases/base58";

export type ShareTarget = SharePublishTarget;

export interface TargetPublishInput {
  readonly source: Uint8Array;
  readonly filename: string;
  /** Additional files for a prefix resource; source remains the first file for compatibility. */
  readonly files?: readonly { readonly bytes: Uint8Array; readonly filename: string; readonly mediaType?: string }[];
  readonly target: ShareTarget;
  readonly expiresAt: Date;
  readonly origin: string;
  readonly mediaType?: string;
  readonly resourceKind?: "exact" | "prefix";
  readonly actions?: readonly ("read" | "list" | "edit")[];
  readonly notify?: boolean;
}

export type TargetPublishOutcome = PublishedShare | ShareAuthorizationRequired;

export interface TargetPublishAdapter {
  publish(input: TargetPublishInput): Promise<TargetPublishOutcome>;
}

function validEmail(value: string): boolean {
  return /^[^@\s]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(value);
}

function validDomain(value: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/i.test(value);
}

function validRecipientDid(value: string): boolean {
  if (value.length === 0 || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  const parts = value.split(":");
  if (parts.length < 3 || parts[0] !== "did" || !/^[a-z0-9]+$/.test(parts[1] ?? "")) return false;
  const identifier = parts.slice(2);
  if (identifier.some((part) => part.length === 0)) return false;
  if (parts[1] === "web") {
    const host = identifier[0] ?? "";
    if (host.length > 253 || host.split(".").some((label) => !label || label.length > 63 || !/^[A-Za-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-"))) return false;
    return identifier.slice(1).every((part) => /^[A-Za-z0-9._%-]+$/.test(part));
  }
  if (parts[1] === "pkh") return identifier.length >= 3 && identifier.every((part) => /^[A-Za-z0-9._%-]+$/.test(part));
  if (parts[1] === "key") {
    try {
      const bytes = base58btc.decode(identifier.join(":"));
      return bytes.length === 34 && bytes[0] === 0xed && bytes[1] === 0x01;
    } catch {
      return false;
    }
  }
  return false;
}

export function normalizeShareTarget(target: ShareTarget): ShareTarget {
  if (target.kind === "bearer") return target;
  if (target.kind === "recipientDid") {
    if (!validRecipientDid(target.did)) throw new TypeError("recipient DID is invalid");
    return { kind: target.kind, did: target.did };
  }
  if (target.kind === "email") {
    if (!validEmail(target.address)) throw new TypeError("recipient email is invalid");
    const at = target.address.lastIndexOf("@");
    return { kind: target.kind, address: `${target.address.slice(0, at)}@${target.address.slice(at + 1).toLowerCase()}` };
  }
  if (!validDomain(target.domain)) throw new TypeError("recipient email domain is invalid");
  return { kind: target.kind, domain: target.domain.toLowerCase() };
}

export function targetAuthorizationMethod(target: ShareTarget): ShareAuthorizationMethod | undefined {
  return authorizationMethodForTarget(target);
}

/** Route every share through the authenticated TinyCloud authority adapter. */
export async function publishTargetShare(input: SharePublishOptions & {
  readonly target: ShareTarget;
  readonly notify?: boolean;
  readonly targetAdapter?: TargetPublishAdapter;
  readonly files?: readonly { readonly bytes: Uint8Array; readonly filename: string; readonly mediaType?: string }[];
  readonly resourceKind?: "exact" | "prefix";
  readonly actions?: readonly ("read" | "list" | "edit")[];
}): Promise<TargetPublishOutcome> {
  const target = normalizeShareTarget(input.target);
  if (input.targetAdapter === undefined) {
    if (target.kind === "bearer") throw new SharePublishError("authority-required", "native bearer publication requires an authenticated TinyCloud node");
    return {
      state: "authorization-required",
      method: targetAuthorizationMethod(target)!,
    };
  }
  const source = input.source instanceof Uint8Array ? input.source.slice() : await (async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of input.source as AsyncIterable<Uint8Array>) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError("share publication source yielded invalid bytes");
      size += chunk.byteLength;
      if (size > (input.maxBytes ?? SHARE_CONTENT_LIMIT)) throw new SharePublishError("max-bytes-exceeded", "share publication exceeds maxBytes");
      chunks.push(chunk.slice());
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  })();
  if (source.byteLength === 0) throw new SharePublishError("invalid-argument", "share content is empty");
  if (!input.filename || input.filename === "." || input.filename === ".." || /[/\\\u0000-\u001f\u007f]/.test(input.filename)) {
    throw new SharePublishError("invalid-argument", "filename must be one safe path segment");
  }
  if (target.kind === "bearer" && input.allowBinary !== true) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(source); }
    catch { throw new SharePublishError("invalid-argument", "Markdown input must be valid UTF-8"); }
  }
  const files = input.files === undefined || input.files.length === 0
    ? [{ bytes: source }]
    : input.files;
  const limit = input.maxBytes ?? SHARE_CONTENT_LIMIT;
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limit) {
      throw new SharePublishError("max-bytes-exceeded", "share publication exceeds the combined byte limit");
    }
  }
  const nowMs = input.now?.() ?? Date.now();
  const expiresAt = input.expiresAt ?? new Date(nowMs + DEFAULT_SHARE_LIFETIME_MS);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= nowMs) throw new SharePublishError("invalid-argument", "expiresAt must be a valid future time");
  return input.targetAdapter.publish({
    source,
    filename: input.filename,
    ...(input.files === undefined ? {} : { files: input.files }),
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    ...(input.resourceKind === undefined ? {} : { resourceKind: input.resourceKind }),
    ...(input.actions === undefined ? {} : { actions: input.actions }),
    target,
    expiresAt,
    origin: input.origin,
    ...(input.notify === undefined ? {} : { notify: input.notify }),
  });
}
