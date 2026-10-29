# @tinycloud/node-sdk

## Signed SIWE metadata

Set `siweConfig.resources` to `urn:tinycloud:recipients:<base64url>` URI strings to include a recipients declaration in the signed SIWE. The payload uses only unpadded base64url characters (`A–Z`, `a–z`, `0–9`, `_`, `-`). Node-sdk inserts these URIs immediately before the original ReCap resource, which remains last. Ordinary sign-in, external/OpenKey preparation, and bootstrap sessions use the same insertion path; completion and session storage retain the signed message unchanged.

These resources do not add permissions. Other schemes, percent encoding, escape sequences and literal controls are not accepted in this option. The generated statement and ReCap remain unchanged; `siweConfig.statement` does not replace the generated statement. Omitting resources or passing an empty array leaves the prepared message unchanged.

## `@tinycloud/node-sdk/credential-pending-store`

File-backed pending store for the email-proof flow. It keeps one file per request under `<home>/credentials/`, named by a hash of the request id. The directory is created with mode 0700 and each file with mode 0600. Permissions and ownership are re-checked on every read. Only a `home` that is itself a symlink is refused; ancestors of `home` may be symlinks, but `realpath(home)` must be owned by the current user. Unsafe files are left in place and reported as an error.

## Revoking delegations

`tinycloud.delegation/revoke` on a space is space-wide: it can revoke any delegation in that space, including other apps' grants and the owner's own sessions. Request it only for the command that needs it, with a short expiry, and don't keep it: the CLI's own fallback asks for 5 minutes and stores nothing. Never put it in a long-lived grant or an app manifest.

