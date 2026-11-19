// Adapter that turns any OpenKey-SDK-shaped object into the authorizeFn
// callback shape `NodeUserAuthorization.signInWithOpenKey` expects.
//
// The node-sdk deliberately does NOT depend on `@openkey/sdk` — the two
// packages ship independently and the OpenKey SDK is a browser-oriented
// artefact that pulls in DOM types. This bridge lets a consumer wire a
// concrete OpenKey instance (or any object that structurally exposes
// `authorizeTinyCloud`) without either side taking a build dependency
// on the other.
//
// Sol continuation contract (Sol MAJOR-6 / production rich-result):
// this is the SUPPORTED production integration path. Consumers should
// prefer `wireOpenKeyAuthorize(openkey)` over building the authorizeFn
// by hand — the wire shape it enforces exactly mirrors what OpenKey
// emits and what `signInWithOpenKeyResult` accepts.

import { publicJwk, type CapabilityPresentationEnvelopeV1 } from "@tinycloud/sdk-core";

/**
 * Structural shape of the OpenKey SDK's `authorizeTinyCloud()` method.
 * Callers pass any object that conforms to this shape — typically an
 * `OpenKey` instance from `@openkey/sdk` — without either package
 * needing to import from the other.
 */
export interface OpenKeySignInIdentity {
  readonly address: string;
  readonly chainId: number;
  readonly keyId: string;
  readonly keyType: "MANAGED" | "EXTERNAL";
  readonly requestId: string;
}

export interface OpenKeyContinuation {
  cancel(): void | Promise<void>;
  authorize(prepare: (identity: OpenKeySignInIdentity) => Promise<OpenKeyBridgeInput>): ReturnType<OpenKeyAuthorizeTinyCloud["authorizeTinyCloud"]>;
}

export interface OpenKeyAuthorizeTinyCloud {
  supportsTinyCloudSignIn?(): Promise<boolean>;
  getContinuationProvider?(): { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
  beginTinyCloudSignIn?(options: {
    chainId: number | (() => Promise<number>);
    verify: (input: {
      result: Awaited<ReturnType<OpenKeyAuthorizeTinyCloud["authorizeTinyCloud"]>>;
      identity: OpenKeySignInIdentity;
      request: Omit<OpenKeyBridgeInput, "verificationMethod">;
      origin: string;
    }) => Promise<boolean>;
  }): OpenKeyContinuation;
  authorizeTinyCloud(request: {
    protocolVersion: 1;
    siwe: string;
    keyId?: string;
    jwk?: Record<string, unknown>;
    host?: string;
    /**
     * Display-only presentation envelope. Forwarded to the OpenKey
     * widget review UI. The envelope MUST NEVER expand authority — the
     * ReCap payload remains the sole gate — and the widget/server
     * validates and size-bounds it before use.
     */
    presentation?: CapabilityPresentationEnvelopeV1;
    /**
     * Ask OpenKey to let the user change the session expiry in the approval.
     * Sent only when true. `@openkey/sdk` >= 0.13.0 (beta: 0.13.0-beta.0)
     * forwards it; 0.12.x ignores it.
     */
    expiryChangeable?: boolean;
  }, opts?: { mode?: "iframe" | "popup" | "redirect" }): Promise<{
    protocolVersion: 1;
    address: string;
    signature: string;
    signedMessage: string;
    selectedActionKeys: string[];
    permissions: Array<{
      service: string;
      space: string;
      path: string;
      actions: string[];
    }>;
  }>;
}

export interface OpenKeyBridgeInput {
  protocolVersion: 1;
  siwe: string;
  /** The public session key. The bridge sends only its public members to OpenKey. */
  jwk: Record<string, unknown>;
  /** SDK-prepared session-key DID, for local handoff consistency only; not an OpenKey request field. */
  readonly verificationMethod: string;
  host?: string;
  /** Optional keyId hint the caller wants OpenKey to bind to. */
  keyId?: string;
  /**
   * Optional presentation envelope built by `NodeUserAuthorization`
   * from its `_manifest`. Passed through to `authorizeTinyCloud` so the
   * widget can render honest provenance labels and the OpenKey server
   * can origin-bind the browser origin against the app's well-known
   * manifest. Display-only.
   */
  presentation?: CapabilityPresentationEnvelopeV1;
  /**
   * Ask OpenKey to let the user change the session expiry. Forwarded only
   * when true. The SDK accepts a changed expiry only for a request that
   * carried this flag, and then uses the SIGNED expiry.
   */
  expiryChangeable?: boolean;
}

export type NodeUserAuthorizationAuthorizeFn = (
  input: OpenKeyBridgeInput,
) => Promise<{
  protocolVersion: 1;
  address: string;
  signature: string;
  signedMessage: string;
  selectedActionKeys: string[];
  permissions: Array<{ service: string; space: string; path: string; actions: string[] }>;
}>;

/**
 * Wire a concrete OpenKey-shaped SDK object into the `authorizeFn`
 * `NodeUserAuthorization.signInWithOpenKey` expects. Rejects any
 * response that does not carry the canonical rich-result shape so
 * wire drift shows up at the bridge boundary rather than deep inside
 * `signInWithOpenKeyResult`.
 *
 * @example
 * ```ts
 * import { OpenKey } from '@openkey/sdk';
 * import { wireOpenKeyAuthorize } from '@tinycloud/node-sdk';
 * const openkey = new OpenKey({ appName: 'my-app' });
 * await openkey.connect();
 * const authorize = wireOpenKeyAuthorize(openkey);
 * const clientSession = await nodeAuth.signInWithOpenKey(authorize);
 * ```
 */
export function wireOpenKeyAuthorize(
  openkey: OpenKeyAuthorizeTinyCloud,
  opts?: { mode?: "iframe" | "popup" | "redirect" },
): NodeUserAuthorizationAuthorizeFn {
  return async (input) => {
    // The bridge does not fabricate any protocol fields — every value
    // flows through unchanged, except the session key, which is reduced to
    // its public members. Wire drift (missing signedMessage,
    // malformed selectedActionKeys, empty permissions on a capability-
    // bearing SIWE) is surfaced by `signInWithOpenKeyResult`; the
    // bridge only translates types.
    const result = await openkey.authorizeTinyCloud({
      protocolVersion: 1,
      siwe: input.siwe,
      keyId: input.keyId,
      jwk: publicJwk(input.jwk),
      host: input.host,
      // Forward the presentation envelope verbatim — the OpenKey SDK
      // validates and size-bounds it before use.
      presentation: input.presentation,
      // Sent only when true, so a request without it keeps its prior shape.
      ...(input.expiryChangeable === true ? { expiryChangeable: true } : {}),
    }, opts);
    if (result.protocolVersion !== 1) {
      throw new Error(
        `wireOpenKeyAuthorize: OpenKey returned unsupported protocolVersion ${result.protocolVersion}`,
      );
    }
    if (typeof result.signedMessage !== "string" || !result.signedMessage) {
      throw new Error(
        "wireOpenKeyAuthorize: OpenKey returned no signedMessage — cannot complete a TinyCloud session",
      );
    }
    if (!Array.isArray(result.selectedActionKeys)) {
      throw new Error(
        "wireOpenKeyAuthorize: OpenKey returned no selectedActionKeys",
      );
    }
    if (!Array.isArray(result.permissions)) {
      throw new Error(
        "wireOpenKeyAuthorize: OpenKey returned no permissions",
      );
    }
    return {
      protocolVersion: 1,
      address: result.address,
      signature: result.signature,
      signedMessage: result.signedMessage,
      selectedActionKeys: result.selectedActionKeys,
      permissions: result.permissions,
    };
  };
}
