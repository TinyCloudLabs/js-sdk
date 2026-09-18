# Authentication and existing accounts

The profile is local session state. The OpenKey signing identity is the owner of the data. Reuse the identity shown by the existing application; do not create a different account or reconnect integrations to obtain agent access.

For an app with an installed permission manifest, create a separate local profile and request that manifest directly:

```bash
tc init --name PROFILE --host HOST --key-only
tc --profile PROFILE --host HOST auth login --method openkey --manifest /absolute/path/to/installed/manifest.json --expiry 7d
tc --profile PROFILE --host HOST context --space SPACE
tc --profile PROFILE --host HOST auth caps
```

Use a new profile name if it already exists. Keep the user's existing profiles. Pass `--owner did:pkh:eip155:CHAIN:ADDRESS` when the expected existing primary DID is known. Otherwise the human selects the existing signing identity in OpenKey and checks the returned owner against the app before reading. A known owner already stored in this profile is checked on scoped login too.

Scoped login accepts one non-empty TinyCloud space per manifest. Logical names such as `applications` are bound to the approved owner's signed space. Additional spaces use the existing `auth request --manifest FILE --grant` flow after login. Scoped login verifies the signed proof, the session key, expiry, intended owner (when known), and that signed permissions do not exceed the manifest before saving. The manifest can intentionally contain writes; use the app's declared read manifest for retrieval. Additional grants already in an existing profile remain present, so the whole profile is not necessarily read-only.

Ordinary `tc init` and `tc auth login` without a manifest retain general default-space consent and can request writes. Use `init --key-only` followed by the scoped command for narrowly authorized first setup. Read and approve the displayed permissions in the browser. The human handles passkey, wallet and consent; do not send return codes, grants, private keys or session files into model chat.

The default browser callback also accepts a terminal paste when interactive. `auth login --method openkey --manifest FILE --expiry 7d --paste` prints a URL and waits for a return code in the terminal; `--no-popup` prints the callback URL without opening a browser. The returned proof must be complete. Older OpenKey responses without a signed proof are rejected for scoped login; do not remove the scope flag to bypass that failure.

Login output distinguishes OpenKey-reported activation from unverified activation. Independently check a real read of the intended SQL/KV resource. Signed authority, node activation, database access and body access are separate checks. A 403 can mean a missing capability; a missing/unhosted space requires checking the intended location, not selecting another owner. An expired session requires renewed consent only when a read is needed.

`tc auth logout` clears the primary local session and retains the key. It is not node revocation, app disconnection, or removal of an agent's local conversation history. Use the documented delegation/revocation operation when revocation is the user's intended task.
