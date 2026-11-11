/**
 * Why the SDK did not ask OpenKey to sign.
 *
 * - `OPENKEY_KEY_MISSING`: there is no OpenKey key to sign with. The client is not connected and cannot connect, or its
 *   `connect()` answered without a `keyId`.
 * - `OPENKEY_KEY_AMBIGUOUS`: the connected OpenKey key cannot be tied to the session's account: its address is another
 *   account's, or it reports none.
 * - `OPENKEY_CONNECTED_RETRY`: popup mode only. The client was not connected, so the SDK connected it. The user needed longer in
 *   that popup than the click's user activation lasts, so a sign popup opened right after would be blocked by the browser.
 *   Nothing was signed. The client is now connected: ask the user to click Allow again, which signs with the connected key
 *   in one popup. Iframe and redirect mode connect and sign in one go and never throw this.
 *
 * None of these opens a sign dialog: the SDK never sends `signMessage` without the keyId of the connected account.
 * Connect the configured client as the session's account (`await openkey.connect()`), or sign runtime grants with
 * `TinyCloudWeb.setRuntimePermissionSigner`.
 */
export type OpenKeySigningKeyErrorCode = "OPENKEY_KEY_MISSING" | "OPENKEY_KEY_AMBIGUOUS" | "OPENKEY_CONNECTED_RETRY";

/**
 * Thrown by `TinyCloudWeb.requestPermissions` (and the panel's "allow" buttons, which call it) when the runtime grant
 * must be signed through the configured OpenKey client but no single connected key can be named, or when the SDK just
 * connected the client in popup mode and the user must click again.
 * `code` is an {@link OpenKeySigningKeyErrorCode}; `name` is `"OpenKeySigningKeyError"`.
 */
export class OpenKeySigningKeyError extends Error {
  readonly name = "OpenKeySigningKeyError";
  constructor(readonly code: OpenKeySigningKeyErrorCode, message: string) {
    super(message);
  }
}

/** What `@openkey/sdk`'s `connect()` answers (and keeps in `lastAuth`) that this SDK reads. */
export interface OpenKeyAuthLike {
  readonly keyId?: unknown;
  readonly address?: unknown;
}

/** The parts of an `@openkey/sdk` client the key lookup reads. `lastAuth` is set by `connect()` and cleared by `signOut()`; nothing public says whether the client is connected. */
export interface OpenKeyConnection {
  readonly lastAuth?: OpenKeyAuthLike | null;
  connect?(opts: { mode: "iframe" | "popup" | "redirect" }): Promise<OpenKeyAuthLike | null | undefined>;
}

function namesKey(auth: OpenKeyAuthLike | null | undefined): auth is OpenKeyAuthLike & { keyId: string } {
  return typeof auth?.keyId === "string" && auth.keyId !== "";
}

/**
 * The keyId OpenKey must sign with for `account`: the connected key (`lastAuth`; a getter that throws reads as not
 * connected), else the key `client.connect()` returns, after connecting it first. The key's address must be `account`,
 * case-insensitively. `assertCurrent` runs right after `connect()` and throws when the session ended or changed while the
 * dialog was open.
 *
 * @throws {OpenKeySigningKeyError} no key, a key that is not `account`'s, or (popup mode) a client that was just connected.
 *   Whatever `connect()` rejects with (the user closing the dialog) propagates unchanged.
 */
export async function resolveOpenKeySigningKey(
  client: OpenKeyConnection,
  account: string,
  mode: "iframe" | "popup" | "redirect",
  assertCurrent: () => void,
): Promise<string> {
  let auth: OpenKeyAuthLike | null | undefined;
  try {
    auth = client.lastAuth;
  } catch {
    auth = undefined;
  }
  const connected = namesKey(auth);
  if (!connected) {
    auth = typeof client.connect === "function" ? await client.connect({ mode }) : undefined;
    assertCurrent();
    if (!namesKey(auth)) throw new OpenKeySigningKeyError("OPENKEY_KEY_MISSING", "OpenKey has no connected key");
  }
  if (!namesKey(auth) || typeof auth.address !== "string" || auth.address.toLowerCase() !== account.toLowerCase()) {
    throw new OpenKeySigningKeyError("OPENKEY_KEY_AMBIGUOUS", "OpenKey key is not the signed-in account's");
  }
  if (!connected && mode === "popup") throw new OpenKeySigningKeyError("OPENKEY_CONNECTED_RETRY", "OpenKey is now connected; click Allow again to sign");
  return auth.keyId;
}
