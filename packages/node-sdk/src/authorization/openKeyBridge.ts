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

/**
 * Structural shape of the OpenKey SDK's `authorizeTinyCloud()` method.
 * Callers pass any object that conforms to this shape — typically an
 * `OpenKey` instance from `@openkey/sdk` — without either package
 * needing to import from the other.
 */
export interface OpenKeyAuthorizeTinyCloud {
  authorizeTinyCloud(request: {
    protocolVersion: 1;
    siwe: string;
    keyId?: string;
    jwk?: Record<string, unknown>;
    host?: string;
  }): Promise<{
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
  jwk: Record<string, unknown>;
  host?: string;
  /** Optional keyId hint the caller wants OpenKey to bind to. */
  keyId?: string;
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
): NodeUserAuthorizationAuthorizeFn {
  return async (input) => {
    // The bridge does not fabricate any protocol fields — every value
    // flows through unchanged. Wire drift (missing signedMessage,
    // malformed selectedActionKeys, empty permissions on a capability-
    // bearing SIWE) is surfaced by `signInWithOpenKeyResult`; the
    // bridge only translates types.
    const result = await openkey.authorizeTinyCloud({
      protocolVersion: 1,
      siwe: input.siwe,
      keyId: input.keyId,
      jwk: input.jwk,
      host: input.host,
    });
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
