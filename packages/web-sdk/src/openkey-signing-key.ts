/**
 * Why the SDK refused to ask OpenKey to sign.
 *
 * - `OPENKEY_KEY_MISSING`: there is no OpenKey key to sign with. The client is not connected and cannot connect, or its
 *   `connect()` answered without a `keyId`.
 * - `OPENKEY_KEY_AMBIGUOUS`: the connected OpenKey key cannot be tied to the session's account: its address is another
 *   account's, or it reports none.
 *
 * Neither case opens an OpenKey dialog: the SDK never sends `signMessage` without the keyId of the connected account.
 * Connect the configured client as the session's account (`await openkey.connect()`), or sign runtime grants with
 * `TinyCloudWeb.setRuntimePermissionSigner`.
 */
export type OpenKeySigningKeyErrorCode = "OPENKEY_KEY_MISSING" | "OPENKEY_KEY_AMBIGUOUS";

/**
 * Thrown by `TinyCloudWeb.requestPermissions` (and the panel's "allow" buttons, which call it) when the runtime grant
 * must be signed through the configured OpenKey client but no single connected key can be named.
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
 * The keyId OpenKey must sign with for `account`: the connected key (`lastAuth`), else the key `client.connect()`
 * returns, after connecting it first. The key's address must be `account`, case-insensitively.
 *
 * @throws {OpenKeySigningKeyError} no key, or a key that is not `account`'s. Whatever `connect()` rejects with (the user
 *   closing the dialog) propagates unchanged.
 */
export async function resolveOpenKeySigningKey(
  client: OpenKeyConnection,
  account: string,
  mode: "iframe" | "popup" | "redirect",
): Promise<string> {
  let auth = client.lastAuth;
  if (!namesKey(auth)) {
    auth = typeof client.connect === "function" ? await client.connect({ mode }) : undefined;
    if (!namesKey(auth)) throw new OpenKeySigningKeyError("OPENKEY_KEY_MISSING", "OpenKey has no connected key");
  }
  if (typeof auth.address !== "string" || auth.address.toLowerCase() !== account.toLowerCase()) {
    throw new OpenKeySigningKeyError("OPENKEY_KEY_AMBIGUOUS", "OpenKey key is not the signed-in account's");
  }
  return auth.keyId;
}
