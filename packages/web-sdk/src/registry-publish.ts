// Publish the owner's registry location record from TinyCloud One or Home.
//
// Only those first-party origins may ask for the record's owner signature; every other
// host gets `"needs-one"` and sends the person to TinyCloud One to finish setup.
//
// This module is dynamic-import()'d from `tcw.ts` so none of it lands in the
// root web-sdk chunk. Everything the publish needs comes in through
// `EnsureOwnerRegistryRecordOptions` from tcw.ts, which already owns the registry
// URL and the caching stores; this module never reaches into TinyCloudNode privates.

import type {
  LocationRecordSigner,
  LocationRecordV2,
  LocationRecordV2Payload,
  RegistryCacheStore,
  RegistrySequenceStore,
  RegistryVerdictCache,
} from "@tinycloud/sdk-core";
import {
  DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL,
  lookupOwnerRegistryVerdict,
} from "@tinycloud/sdk-core";
// publishLocationRecordV2 lives on the registry-publication subpath only; sdk-core's
// root index exports `publishLocationRecord` (the V1 publisher), not V2.
import { publishLocationRecordV2 } from "@tinycloud/sdk-core/registry-publication";

import type { TinyCloudNode } from "@tinycloud/node-sdk";

/**
 * Origins that may publish the owner's record: TinyCloud One and Home. OpenKey's
 * registry-record allowlist also signs for secrets.tinycloud.xyz and share.tinycloud.xyz,
 * but the SDK publishes only from these two and returns `"needs-one"` elsewhere without
 * asking for a signature.
 */
export const REGISTRY_PUBLISH_ORIGINS: readonly string[] = [
  "https://tinycloud.one",
  "https://home.tinycloud.xyz",
];

/** Error code OpenKey's API returns when it refuses to sign a registry record for the calling origin. */
const REGISTRY_SIGN_REFUSED_CODE = "registry_record_sign_refused";
/** Message OpenKey's popup and embed return for the same refusal. */
const REGISTRY_SIGN_REFUSED_MESSAGE = "REGISTRY_RECORD_SIGN_REFUSED";

/** True when `error` (or anything in its `cause` chain) is OpenKey's registry-record sign refusal. */
export function isRegistryRecordSignRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (code === REGISTRY_SIGN_REFUSED_CODE) return true;
    if (typeof message === "string" && message.includes(REGISTRY_SIGN_REFUSED_MESSAGE)) return true;
    current = cause;
  }
  return false;
}

/**
 * Outcome of the publish attempt. Returned from `tcw.ensureOwnerRegistryRecord` so the
 * host can react.
 */
export type RegistryPublishOutcome =
  | "published"       // Sent to registry, verified, cached.
  | "already-current" // The registry already has the owner's record; nothing to do.
  | "needs-one"       // The owner has no record and this host cannot publish one; send them to TinyCloud One (`AccountSetupRequiredError.setupUrl`).
  | "unavailable";    // Registry unreachable, signer missing, or publish failed.

/** A signer that produces an EIP-191 signature over a canonical location-record message for a specific owner `did:pkh`. */
export interface OwnerMessageSigner {
  readonly subject: string;      // did:pkh:eip155:{chainId}:{address}
  readonly signMessage: (message: string) => Promise<string>;
}

export interface EnsureOwnerRegistryRecordOptions {
  node: TinyCloudNode;
  /** Owner's did:pkh, taken from `node.did` in tcw.ts (only computed for wallet / OpenKey owners). */
  subject: string;
  /** The page's origin. Only `REGISTRY_PUBLISH_ORIGINS` may publish. */
  origin: string | undefined;
  /** Registry endpoint. Defaults to `DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL` when undefined; `null` from host config means the registry is explicitly disabled and the publish is skipped. */
  registryUrl?: string | null;
  /** Optional: SDK-side registry stores, so publication uses the same sequences / cache as everything else. */
  registryChainId?: number;
  registrySequenceStore?: RegistrySequenceStore;
  registryCacheStore?: RegistryCacheStore;
  registryVerdictCache?: RegistryVerdictCache;
  /** Resolves the owner signer. Returning `undefined` means we have no way to sign (skip). */
  resolveSigner: () => Promise<OwnerMessageSigner | undefined>;
  /** Host-supplied error hook. Called for every failure before we map the outcome. Never throws. */
  onError?: (error: unknown) => void;
  /**
   * Called after every await the helper issues. Throws when the signed-in session has
   * changed under the helper (sign-out, account switch). Fail-closed: the helper catches
   * the throw, reports via `onError`, and returns `"unavailable"` without writing anything,
   * so a stale call after a sign-out never reaches the registry.
   */
  assertCurrent?: () => void;
  /** Overridable for tests. */
  now?: () => Date;
  /** Overridable for tests; defaults to the globalThis fetch used elsewhere in the SDK. */
  fetch?: typeof fetch;
}

/**
 * Called by `tcw.ensureOwnerRegistryRecord` for a `did:pkh` owner. Guards:
 *
 * 1. The registry verdict is read first. Anything but `unregistered` returns
 *    `"already-current"`, and an `offline` verdict returns `"unavailable"` because a cold
 *    registry cannot prove the owner is absent.
 * 2. An unregistered owner on an origin outside `REGISTRY_PUBLISH_ORIGINS` returns
 *    `"needs-one"` before anything is signed.
 * 3. The record's node identity comes only from `node.activeNodeIdentity()`, never from
 *    caller input: a signed record pointing at the wrong node is the real attacker gain.
 * 4. An existing record is never overwritten or merged. `publishLocationRecordV2`'s
 *    pre-sign re-read refuses the publish if a record has appeared since the verdict.
 * 5. Sign-out or account switch is caught by `assertCurrent` after every await.
 * 6. OpenKey's registry-record sign refusal maps to `"needs-one"`. Every other error is
 *    swallowed and funnelled through `onError`; this never throws.
 */
export async function ensureOwnerRegistryRecord(options: EnsureOwnerRegistryRecordOptions): Promise<RegistryPublishOutcome> {
  const { node, subject, onError, resolveSigner, assertCurrent } = options;
  const registryUrl = options.registryUrl === undefined ? DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL : options.registryUrl;
  if (registryUrl === null) return "unavailable";
  try {
    const verdict = await lookupOwnerRegistryVerdict(subject, {
      registryUrl,
      ...(options.registryChainId !== undefined ? { registryChainId: options.registryChainId } : {}),
      ...(options.registrySequenceStore ? { sequenceStore: options.registrySequenceStore } : {}),
      ...(options.registryCacheStore ? { cacheStore: options.registryCacheStore } : {}),
      ...(options.registryVerdictCache ? { verdictCache: options.registryVerdictCache } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      dataRead: true,
    }).catch((error) => {
      onError?.(error);
      return undefined;
    });
    assertCurrent?.();
    if (!verdict) return "unavailable";
    if (verdict.status !== "unregistered") return "already-current";
    if ((verdict as { offline?: boolean }).offline === true) return "unavailable";
    if (!options.origin || !REGISTRY_PUBLISH_ORIGINS.includes(options.origin)) return "needs-one";

    const activeNode = await node.activeNodeIdentity();
    assertCurrent?.();
    const space = node.spaceId;
    if (typeof space !== "string" || !space.startsWith("tinycloud:")) return "unavailable";

    const signer = await resolveSigner().catch((error) => {
      onError?.(error);
      return undefined;
    });
    assertCurrent?.();
    if (!signer) return "unavailable";
    // The signer's subject and `subject` both come from `node.did` in tcw.ts. The real
    // guards are `signLocationRecordV2`'s type/subject enforcement and the registry's
    // EIP-191 recover against the record's subject, which rejects any mismatch.
    const recordSigner: LocationRecordSigner = {
      type: "did:pkh",
      signMessage: (message) => signer.signMessage(message),
    };

    try {
      await publishLocationRecordV2({
        registryUrl,
        subject,
        signer: recordSigner,
        memberships: [{
          space,
          node: { did: activeNode.nodeDid, url: activeNode.origin },
          mode: "read-write",
        }],
        // Authoritative no-overwrite guarantee: the live pre-sign read must still be empty.
        // The session check sits here so the only remaining window is the signature prompt.
        onPrepared: async (_prepared, current) => {
          assertCurrent?.();
          return current === null;
        },
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      assertCurrent?.();
      options.registryVerdictCache?.invalidate(registryUrl, subject);
      return "published";
    } catch (error) {
      if (isRegistryRecordSignRefusal(error)) return "needs-one";
      onError?.(error);
      return "unavailable";
    }
  } catch (error) {
    onError?.(error);
    return "unavailable";
  }
}

// Re-exports so tcw.ts callers can see the types without importing sdk-core directly.
export type { LocationRecordV2, LocationRecordV2Payload };
