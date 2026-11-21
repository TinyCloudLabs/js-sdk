// TC-3547: publish the owner's registry location record once, at the first
// first-party sign-in where the owner's did:pkh is `unregistered`.
//
// This module is dynamic-import()'d from `tcw.ts` so none of it lands in the
// root web-sdk chunk (TC-858 ceiling). Everything the publish needs comes in
// through `EnsureOwnerRegistryRecordOptions` from tcw.ts, which already owns
// the registry URL and the caching stores; this module never reaches into
// TinyCloudNode privates.

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
  LocationRecordValidationError,
  LocationRegistryHttpError,
  lookupOwnerRegistryVerdict,
} from "@tinycloud/sdk-core";
// publishLocationRecordV2 lives on the registry-publication subpath only; sdk-core's
// root index exports `publishLocationRecord` (the V1 publisher), not V2.
import { publishLocationRecordV2 } from "@tinycloud/sdk-core/registry-publication";

import type { TinyCloudNode } from "@tinycloud/node-sdk";

import { readRegistryPublishDismissed, writeRegistryPublishDismissed } from "./registry-publish-dismissed";

/**
 * Payload preview given to the host app's consent callback. The host renders it in plain
 * words (owner DID, node DID + origin, primary space URI). The list of fields matches
 * exactly what `canonicalLocationPayloadV2` publishes, so the consent screen never says
 * "we'll publish X" and then publishes Y.
 */
export interface RegistryPublishPreview {
  readonly subject: string;
  readonly nodeDid: string;
  readonly nodeOrigin: string;
  readonly space: string;
}

/**
 * Outcome of the publish attempt. Returned from `tcw.ensureOwnerRegistryRecord` so the
 * host can react (e.g. render a retry banner when it's `"declined"` or `"unavailable"`).
 */
export type RegistryPublishOutcome =
  | "published"       // Sent to registry, verified, cached.
  | "already-current" // Verdict was `registered`; no action.
  | "declined"        // onConsent returned false, or dismissed previously.
  | "unavailable";    // Verdict unavailable, signer missing, or publish failed. Sign-in continues.

/** A signer that produces an EIP-191 signature over a canonical location-record message for a specific owner `did:pkh`. */
export interface OwnerMessageSigner {
  readonly subject: string;      // did:pkh:eip155:{chainId}:{address}
  readonly signMessage: (message: string) => Promise<string>;
}

export interface EnsureOwnerRegistryRecordOptions {
  node: TinyCloudNode;
  /** Owner's did:pkh, taken from `node.did` in tcw.ts (only computed for wallet / OpenKey owners). */
  subject: string;
  /** Registry endpoint. Defaults to `DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL` from sdk-core when undefined; `null` from host config means the registry is explicitly disabled and the publish is skipped. */
  registryUrl?: string | null;
  /** Optional: SDK-side registry stores, so publication uses the same sequences / cache as everything else. */
  registryChainId?: number;
  registrySequenceStore?: RegistrySequenceStore;
  registryCacheStore?: RegistryCacheStore;
  registryVerdictCache?: RegistryVerdictCache;
  /** Resolves the owner signer. Returning `undefined` means we have no way to sign (skip). */
  resolveSigner: () => Promise<OwnerMessageSigner | undefined>;
  /** Host-supplied plain-words consent prompt. Returning false (or throwing) aborts without publishing. */
  onConsent?: (preview: RegistryPublishPreview) => Promise<boolean>;
  /** Host-supplied error hook. Called for every failure before we map the outcome to `"unavailable"`. Never throws. */
  onError?: (error: unknown) => void;
  /** Overridable for tests. */
  now?: () => Date;
  /** Overridable for tests; defaults to the globalThis fetch used elsewhere in the SDK. */
  fetch?: typeof fetch;
}

/**
 * Called from tcw.ts after `signIn()` succeeds for a `did:pkh` owner. Guards are:
 *
 * 1. The caller (`tcw.ts`) already checked `bootstrapSignInPolicy().autoBootstrapAccount`.
 *    First-party only; third-party sign-ins never enter this path.
 * 2. We look up the registry verdict here, not above, so the dismissed-check short-circuits
 *    an owner who already said "Not now" before we ask the registry anything.
 * 3. We publish via `publishLocationRecordV2` (owner-signed under `did:pkh`). The record's
 *    node identity comes only from `node.activeNodeIdentity()` — never from caller input,
 *    which is Bobbie's req. 1 (a signed record pointing at the wrong node is the real
 *    attacker gain).
 * 4. We never overwrite. `publishLocationRecordV2` refuses an overwrite that reduces to
 *    the same payload (its own idempotence); we also return `"already-current"` when the
 *    verdict is already `registered`, so a second call does not even reach the registry.
 * 5. We swallow every error and funnel through `onError`. Sign-in never fails because of this.
 */
export async function ensureOwnerRegistryRecord(options: EnsureOwnerRegistryRecordOptions): Promise<RegistryPublishOutcome> {
  const { node, subject, onConsent, onError, resolveSigner } = options;
  const registryUrl = options.registryUrl === undefined ? DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL : options.registryUrl;
  if (registryUrl === null) return "unavailable";
  try {
    // Was the publish declined before? The dismissed flag lives in the owner's own
    // account-registry KV, so both home.tinycloud.xyz and tinycloud.one read the same bit.
    if (await readRegistryPublishDismissed(node)) return "declined";

    // Registry verdict decides whether to prompt at all. This is the same lookup NodeUserAuthorization
    // does during third-party sign-in; here we use its result to decide whether to publish.
    const verdict = await lookupOwnerRegistryVerdict(subject, {
      registryUrl,
      ...(options.registryChainId !== undefined ? { registryChainId: options.registryChainId } : {}),
      ...(options.registrySequenceStore ? { sequenceStore: options.registrySequenceStore } : {}),
      ...(options.registryCacheStore ? { cacheStore: options.registryCacheStore } : {}),
      ...(options.registryVerdictCache ? { verdictCache: options.registryVerdictCache } : {}),
      dataRead: true,
    }).catch((error) => {
      onError?.(error);
      return undefined;
    });
    if (!verdict) return "unavailable";
    if (verdict.status !== "unregistered") return "already-current";

    const activeNode = await node.activeNodeIdentity();
    const space = node.spaceId;
    if (typeof space !== "string" || !space.startsWith("tinycloud:")) return "unavailable";

    const preview: RegistryPublishPreview = {
      subject,
      nodeDid: activeNode.nodeDid,
      nodeOrigin: activeNode.origin,
      space,
    };

    // No onConsent, no publish. The host that wants the publish must render consent
    // itself — Bobbie req. 1 (defence against silent writes).
    if (!onConsent) return "declined";
    let approved: boolean;
    try {
      approved = await onConsent(preview);
    } catch (error) {
      onError?.(error);
      return "declined";
    }
    if (!approved) {
      await writeRegistryPublishDismissed(node).catch((error) => onError?.(error));
      return "declined";
    }

    const signer = await resolveSigner().catch((error) => {
      onError?.(error);
      return undefined;
    });
    if (!signer) return "unavailable";
    if (signer.subject !== subject) {
      onError?.(new Error("Owner signer subject does not match active node owner"));
      return "unavailable";
    }
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
        ...(options.registrySequenceStore ? { sequenceStore: options.registrySequenceStore } : {}),
        ...(options.registryCacheStore ? { cacheStore: options.registryCacheStore } : {}),
        // Consent was the onConsent callback above; onPrepared is the second fence after merges
        // against existing memberships. Here the merge target is empty (owner is `unregistered`),
        // so nothing can slip in between preview and sign.
        onPrepared: async () => true,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      options.registryVerdictCache?.invalidate(registryUrl, subject);
      return "published";
    } catch (error) {
      onError?.(error);
      if (error instanceof LocationRecordValidationError || error instanceof LocationRegistryHttpError) return "unavailable";
      return "unavailable";
    }
  } catch (error) {
    onError?.(error);
    return "unavailable";
  }
}

// Re-exports so tcw.ts callers can see the types without importing sdk-core directly.
export type { LocationRecordV2, LocationRecordV2Payload };
