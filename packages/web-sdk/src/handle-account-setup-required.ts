// TC-3657: outside-app one-tap TinyCloud setup via OpenKey. Sam's TC-3620 pick
// (2026-11-21 14:14:07Z). Approved by Bobbie 14:32:09Z (C1–C5), Naomi 14:32:33Z
// (Q1 server-side publish, Q2 no persistence + 24h SDK-side throttle).
//
// This module is dynamic-import()'d from `tcw.ts` to keep it off the TC-858
// root chunk (same reason as TC-3547's registry-publish module). It lives only
// on the code path a third-party app follows when its sign-in throws
// `AccountSetupRequiredError`; a host that never catches that error and never
// calls `tcw.handleAccountSetupRequired(...)` never loads this file.
//
// Scope boundary for the SDK slice:
// - The SDK trigger is: the outside app catches `AccountSetupRequiredError`
//   and calls `tcw.handleAccountSetupRequired(error, { requestingApp })`.
// - The SDK consults a 24h throttle keyed per-owner-per-outside-app-origin
//   in `localStorage` (`tcw.tc3657.throttle.{owner}.{appOrigin}`).
// - The SDK invokes OpenKey's `authorizeTinyCloudSetup` method; OpenKey owns
//   the consent widget, the node-DID+origin selection, and the registry PUT
//   (Bobbie C1: server mints a one-time ticket bound to owner + verified
//   requesting origin + record hash; C2: top-level popup; C3: requesting
//   origin is browser-derived, NOT from this module's arguments; C4: user
//   presence per OpenKey's existing unlock/passkey; C5: per-owner rate limit
//   on the server).
// - On a `"published"` or `"already-current"` outcome, the SDK retries the
//   sign-in; on any other outcome, it does not.
//
// Nothing in this file forwards an app-supplied origin to OpenKey. The
// `requestingApp` fields `name` and `manifest` are passed as unverified
// display hints only (per C3); OpenKey's widget shows the browser-derived
// origin.

import type { TinyCloudNode } from "@tinycloud/node-sdk";

/** Byte-identical localStorage key format used across read and write. Exported for tests only. */
export function throttleStorageKey(subject: string, outsideAppOrigin: string): string {
  return `tcw.tc3657.throttle.${subject.toLowerCase()}.${outsideAppOrigin.toLowerCase()}`;
}

/** 24 hours in milliseconds, per Naomi 14:32:33Z: "an outside app can't re-show the setup prompt for the same account more than once a day". */
export const OUTSIDE_APP_SETUP_THROTTLE_MS = 24 * 60 * 60 * 1000;

/** Minimal localStorage shape; the browser's `Storage` satisfies it, tests supply their own. */
export interface OutsideAppThrottleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Outcome returned to the outside app; stable string union so apps can branch deterministically. */
export type HandleAccountSetupRequiredOutcome =
  | "published"       // OpenKey signed + published successfully.
  | "already-current" // OpenKey reported the owner already had a record.
  | "declined"        // Owner declined the consent (OpenKey widget).
  | "throttled"       // The 24h per-owner-per-app throttle fired; no OpenKey call made.
  | "no-openkey"      // The TinyCloudWeb instance has no OpenKey client; outside app should fall back to `error.setupUrl`.
  | "unavailable";    // OpenKey reachable but the setup endpoint declined or failed.

/** Minimal OpenKey SDK surface for the setup flow; matches TC-3657 §4 proposal.
 *  Full shape ships in OpenKey only after Sam's card + Naomi's GO; the type here
 *  is the SDK contract the TinyChat / outside-app side can pin against. */
export interface OpenKeySetupClient {
  authorizeTinyCloudSetup?: (
    request: {
      requestingApp?: { name?: string; manifest?: unknown };
      // No `origin` field: OpenKey derives the requesting origin from the browser
      // (Bobbie C3). If a caller ever passes one here, OpenKey's server MUST ignore it.
      keyId?: string;
    },
    opts?: { mode?: "iframe" | "popup" | "redirect" },
  ) => Promise<TinyCloudSetupResultV1>;
}

export type TinyCloudSetupResultV1 =
  | { status: "published"; subject: string }
  | { status: "already-current"; subject: string }
  | { status: "declined" }
  | { status: "unavailable"; reason: "signature-refused" | "registry-error" | "node-unreachable" | "rate-limited" };

export interface HandleAccountSetupRequiredOptions {
  /** The `AccountSetupRequiredError` from the signed-in call. Read for `setupUrl` fallback only. */
  readonly error: { readonly setupUrl: string };
  /** Optional unverified display hints for OpenKey's consent screen. No `origin` field: Bobbie C3. */
  readonly requestingApp?: { name?: string; manifest?: unknown };
  /** OpenKey client resolved by tcw.ts from its own config. `undefined` → outcome is `"no-openkey"`. */
  readonly openkey: OpenKeySetupClient | undefined;
  /** Mode forwarded to OpenKey, matching the existing authorizeTinyCloud mode choice. */
  readonly mode?: "iframe" | "popup" | "redirect";
  /** The signed-in owner's `did:pkh`, from `node.did`. Used as the throttle key and the OpenKey session owner. */
  readonly subject: string;
  /** Node handle, read only for sign-out detection in the retry step (not passed to OpenKey). */
  readonly node: TinyCloudNode;
  /** Overridable for tests; defaults to `globalThis.localStorage`. SSR / private-mode → no throttle (fail-open). */
  readonly throttleStorage?: OutsideAppThrottleStorage;
  /** Overridable for tests; defaults to `Date.now()`. */
  readonly now?: () => number;
  /** Error hook; mirrors TC-3547's `onRegistryPublishError`. Never throws. */
  readonly onError?: (error: unknown) => void;
  /** Called by the SDK after a `"published"` or `"already-current"` outcome if the caller wants to retry sign-in. */
  readonly retrySignIn?: () => Promise<void>;
}

function defaultLocalStorage(): OutsideAppThrottleStorage | undefined {
  try {
    const candidate = (globalThis as { localStorage?: OutsideAppThrottleStorage }).localStorage;
    return candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function"
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

/** Fail-open read. Any failure mode (missing storage, SecurityError, unparseable JSON, stale timestamp) returns `false`
 *  so the setup prompt can run. Returns `true` only when a valid timestamp is strictly within the throttle window. */
export function isOutsideAppSetupThrottled(
  subject: string,
  outsideAppOrigin: string,
  storage: OutsideAppThrottleStorage | undefined = defaultLocalStorage(),
  now: number = Date.now(),
): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(throttleStorageKey(subject, outsideAppOrigin));
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return false;
    const at = (parsed as { at?: unknown }).at;
    if (typeof at !== "string") return false;
    const lastMs = Date.parse(at);
    if (!Number.isFinite(lastMs)) return false;
    return (now - lastMs) < OUTSIDE_APP_SETUP_THROTTLE_MS;
  } catch {
    return false;
  }
}

/** Fail-silent write; any error swallowed (QuotaExceededError, SecurityError, etc.). The only
 *  consequence of a silent no-op is that the throttle may not stick on this device; the OpenKey
 *  server's own per-owner rate limit (Bobbie C5) is the security backstop. */
export function rememberOutsideAppSetupAttempt(
  subject: string,
  outsideAppOrigin: string,
  storage: OutsideAppThrottleStorage | undefined = defaultLocalStorage(),
  now: number = Date.now(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      throttleStorageKey(subject, outsideAppOrigin),
      JSON.stringify({ at: new Date(now).toISOString() }),
    );
  } catch {
    // Intentional no-op; the OpenKey server rate limit is the security guarantee.
  }
}

/**
 * The outside app's `AccountSetupRequiredError` handler. Called by tcw.ts after resolving the
 * OpenKey client + the current owner's `did:pkh` + the browser's own origin (for the throttle key;
 * the requesting origin shown on the OpenKey screen is derived by OpenKey independently, Bobbie C3).
 *
 * Guards:
 * 1. No OpenKey → `"no-openkey"`. The outside app should fall back to `error.setupUrl` (TC-3547
 *    `AccountSetupRequiredError.setupUrl` already carries `?finish-setup=registry` so a visit to
 *    Home opens the consent there instead).
 * 2. Throttled → `"throttled"`. No OpenKey call is made; the outside app's own UI should back off
 *    and not re-prompt until the 24h window elapses (Naomi 14:32:33Z).
 * 3. OpenKey's `authorizeTinyCloudSetup` returns `"published"` or `"already-current"` → remember
 *    the attempt timestamp in `localStorage`, then invoke the caller-supplied `retrySignIn` if any.
 *    The retry is best-effort; its result is reported back to the outside app through the SDK
 *    call that produced the `AccountSetupRequiredError` in the first place.
 * 4. OpenKey returns `"declined"` or `"unavailable"` → ALSO remember the attempt timestamp so the
 *    24h throttle prevents a re-prompt loop (Naomi: "an outside app can't re-show the setup prompt
 *    for the same account more than once a day" — this applies regardless of outcome).
 * 5. Every error is caught and funneled through `onError`; the function never throws. The signed-in
 *    state is not mutated by this helper; `retrySignIn` is the only side effect outside the throttle
 *    write.
 */
export async function handleAccountSetupRequired(
  options: HandleAccountSetupRequiredOptions,
): Promise<HandleAccountSetupRequiredOutcome> {
  const { openkey, subject, onError, retrySignIn } = options;
  const outsideAppOrigin = defaultOutsideAppOrigin();
  if (!outsideAppOrigin) {
    // No browser-derived origin to key the throttle by; without that we can't enforce
    // the 24h window honestly. SSR / Node has nothing to call an outside app anyway.
    if (!openkey?.authorizeTinyCloudSetup) return "no-openkey";
    return "unavailable";
  }
  const now = options.now ? options.now() : Date.now();
  const throttleStorage = options.throttleStorage ?? defaultLocalStorage();
  try {
    if (!openkey || typeof openkey.authorizeTinyCloudSetup !== "function") return "no-openkey";
    if (isOutsideAppSetupThrottled(subject, outsideAppOrigin, throttleStorage, now)) return "throttled";

    // Ask OpenKey. Only `name` / `manifest` are forwarded as unverified display hints
    // (Bobbie C3: no `origin` field in the payload; OpenKey derives it from the browser).
    const request: Parameters<NonNullable<OpenKeySetupClient["authorizeTinyCloudSetup"]>>[0] = {};
    if (options.requestingApp?.name !== undefined) request.requestingApp = { name: options.requestingApp.name };
    if (options.requestingApp?.manifest !== undefined) {
      request.requestingApp = { ...(request.requestingApp ?? {}), manifest: options.requestingApp.manifest };
    }
    let result: TinyCloudSetupResultV1;
    try {
      result = options.mode
        ? await openkey.authorizeTinyCloudSetup!(request, { mode: options.mode })
        : await openkey.authorizeTinyCloudSetup!(request);
    } catch (error) {
      onError?.(error);
      rememberOutsideAppSetupAttempt(subject, outsideAppOrigin, throttleStorage, now);
      return "unavailable";
    }

    // Remember the attempt timestamp regardless of outcome: Naomi's throttle is per-app-per-day,
    // not per-success-per-day. A declined owner should not re-see the OpenKey screen for 24h.
    rememberOutsideAppSetupAttempt(subject, outsideAppOrigin, throttleStorage, now);

    if (result.status === "published" || result.status === "already-current") {
      if (retrySignIn) {
        try { await retrySignIn(); }
        catch (error) {
          // The retry failing doesn't un-publish the record. Report but still signal success to the
          // outside app — the next bare sign-in will succeed on its own.
          onError?.(error);
        }
      }
      return result.status;
    }
    if (result.status === "declined") return "declined";
    return "unavailable";
  } catch (error) {
    // Catch-all defence; TC-3547's pattern. Signing-in or outside-app-call never fails because of this.
    onError?.(error);
    return "unavailable";
  }
}

function defaultOutsideAppOrigin(): string | undefined {
  try {
    const loc = (globalThis as { location?: { origin?: unknown } }).location;
    return typeof loc?.origin === "string" ? loc.origin : undefined;
  } catch {
    return undefined;
  }
}
