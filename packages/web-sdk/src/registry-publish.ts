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
import { readRegistryPublishDismissed, writeRegistryPublishDismissed, type DismissedFlagStorage } from "./registry-publish-dismissed";

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
  /**
   * Called after every await the helper issues. Throws when the signed-in session has
   * changed under the helper (sign-out, account switch). Fail-closed: the helper catches
   * the throw, reports via `onError`, and returns `"unavailable"` without writing anything,
   * so a stale consent tap after a sign-out never reaches the registry or the new account's
   * KV. See TC-3547 F2 (Bobbie 13:52:41Z).
   */
  assertCurrent?: () => void;
  /** Overridable for tests. */
  now?: () => Date;
  /** Overridable for tests; defaults to the globalThis fetch used elsewhere in the SDK. */
  fetch?: typeof fetch;
  /**
   * Overridable for tests; defaults to `globalThis.localStorage`. SSR / private-mode /
   * cross-origin denial automatically fall through to "no storage" → fail-open ("not
   * dismissed"), per Naomi 14:20:13Z: localStorage keyed by `did:pkh`, per-device.
   */
  dismissedStorage?: DismissedFlagStorage;
  /**
   * Owner-started retry (TC-3547 Soren 13:26:53Z, Bobbie 13:27:14Z, Naomi 13:27:03Z):
   * when the host observes the `finish-setup=registry` intent on the URL and the owner
   * is signed in on a first-party page, call with this `true` to bypass the dismissed
   * flag. The intent is a fixed token the host matches and strips (`replaceState`);
   * NOTHING from the URL feeds the record. The record's node, origin, DID and contents
   * still come only from the SDK's verified active node (Bobbie req. 1). The consent
   * callback still runs; the verdict is still checked; `unregistered` is still the
   * only publish path; overwrites are still refused (Bobbie req. 2).
   */
  ignoreDismissed?: boolean;
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
 * 4. We NEVER overwrite or merge into an existing record. The verdict is checked once
 *    up front; `publishLocationRecordV2`'s own `onPrepared` fence is used to refuse the
 *    publish if the final pre-sign re-read now sees a record (TC-3547 F1, Bobbie 13:52:41Z).
 *    An `offline` verdict is refused: a cold registry cannot prove the owner is actually
 *    absent, so publishing on it risks an unintended merge after the registry comes back.
 * 5. Sign-out / account switch is caught by `assertCurrent` after every await, so a stale
 *    tap after sign-out never writes to the new account's KV nor publishes with the old
 *    account's signer (TC-3547 F2).
 * 6. We swallow every error and funnel through `onError`. Sign-in never fails because of this.
 */
export async function ensureOwnerRegistryRecord(options: EnsureOwnerRegistryRecordOptions): Promise<RegistryPublishOutcome> {
  const { node, subject, onConsent, onError, resolveSigner, assertCurrent } = options;
  const registryUrl = options.registryUrl === undefined ? DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL : options.registryUrl;
  if (registryUrl === null) return "unavailable";
  try {
    // Was the publish declined before? The dismissed flag lives in the owner's own
    // account-registry KV, so both home.tinycloud.xyz and tinycloud.one read the same bit.
    // Owner-started retries (ignoreDismissed) skip this check; all other guards hold.
    if (!options.ignoreDismissed && readRegistryPublishDismissed(subject, options.dismissedStorage)) return "declined";
    assertCurrent?.();

    // Registry verdict decides whether to prompt at all. This is the same lookup NodeUserAuthorization
    // does during third-party sign-in; here we use its result to decide whether to publish.
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
    // TC-3547 F1: an `offline` verdict is "unregistered + couldn't reach the registry".
    // It cannot prove absence, so publishing on it risks an unintended merge after the
    // registry comes back online. Fail closed; the next sign-in retries from a fresh
    // verdict.
    if ((verdict as { offline?: boolean }).offline === true) return "unavailable";

    const activeNode = await node.activeNodeIdentity();
    assertCurrent?.();
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
    // Check after the consent await — the owner may have signed out while the modal was open.
    // If they did, we must NOT write the dismissed flag (that would hit the new account's KV)
    // and we must NOT proceed to sign/publish on behalf of the old account.
    try { assertCurrent?.(); } catch (error) { onError?.(error); return "unavailable"; }
    if (!approved) {
      // Bobbie 14:20:15Z: assertCurrent runs immediately before the flag write so a stale
      // decline after sign-out never persists for the (possibly-new) current account.
      try { assertCurrent?.(); } catch (error) { onError?.(error); return "unavailable"; }
      writeRegistryPublishDismissed(subject, options.dismissedStorage);
      return "declined";
    }

    const signer = await resolveSigner().catch((error) => {
      onError?.(error);
      return undefined;
    });
    assertCurrent?.();
    if (!signer) return "unavailable";
    // Signer subject comparison skipped on purpose: `tcw.ts` derives both `subject` and
    // the signer's declared subject from the same `node.did`, so the check would be a
    // no-op (Bobbie 13:52:41Z). The real guards are `signLocationRecordV2`'s type/subject
    // enforcement and `verifyLocationRecordV2`'s EIP-191 recover against the record's
    // subject — the registry rejects any mismatch.
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
        // TC-3547 F1 + F2 tightening (Bobbie 14:00:27Z): check assertCurrent HERE, right
        // before signLocationRecordV2's own PUT. This moves the last session-change check
        // past publishLocationRecordV2's two registry reads and node-identity probe, so the
        // only remaining window is the wallet / OpenKey signature prompt itself — which is
        // owner-presence anyway.
        onPrepared: async (_prepared, current) => {
          assertCurrent?.();
          return current === null;
        },
        // (The up-front verdict check above may be minutes old by the time the modal is
        // answered. publishLocationRecordV2 re-reads the registry just before signing and
        // passes the live `current` to onPrepared; refusing anything but `current === null`
        // is the authoritative no-overwrite guarantee.)
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      assertCurrent?.();
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
