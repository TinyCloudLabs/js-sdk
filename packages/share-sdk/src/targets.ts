import type { ShareAuthorizationRequired, ShareAuthorizationMethod } from "./authorization.js";
import { authorizationMethodForTarget } from "./authorization.js";
import { publishShare, type PublishedShare, type SharePublishOptions, type SharePublishTarget } from "./publish.js";

export type ShareTarget = SharePublishTarget;

export interface TargetPublishInput {
  readonly source: Uint8Array;
  readonly filename: string;
  readonly target: Exclude<ShareTarget, { readonly kind: "bearer" }>;
  readonly expiresAt: Date;
  readonly origin: string;
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

export function normalizeShareTarget(target: ShareTarget): ShareTarget {
  if (target.kind === "bearer") return target;
  if (target.kind === "recipientDid") {
    if (!/^did:[a-z0-9]+:.+$/.test(target.did)) throw new TypeError("recipient DID is invalid");
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

/** Publish bearer shares locally, and route addressed shares to an authority adapter. */
export async function publishTargetShare(input: SharePublishOptions & {
  readonly target: ShareTarget;
  readonly notify?: boolean;
  readonly targetAdapter?: TargetPublishAdapter;
}): Promise<TargetPublishOutcome> {
  const target = normalizeShareTarget(input.target);
  if (target.kind === "bearer") return publishShare(input);
  if (input.targetAdapter === undefined) {
    return {
      state: "authorization-required",
      method: targetAuthorizationMethod(target)!,
    };
  }
  const source = input.source instanceof Uint8Array ? input.source.slice() : await (async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of input.source as AsyncIterable<Uint8Array>) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError("addressed publication source yielded invalid bytes");
      size += chunk.byteLength;
      if (size > (input.maxBytes ?? 100 * 1024 * 1024)) throw new TypeError("addressed publication exceeds maxBytes");
      chunks.push(chunk.slice());
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  })();
  return input.targetAdapter.publish({ source, filename: input.filename, target, expiresAt: input.expiresAt ?? new Date((input.now?.() ?? Date.now()) + 7 * 24 * 60 * 60 * 1000), origin: input.origin, ...(input.notify === undefined ? {} : { notify: input.notify }) });
}
