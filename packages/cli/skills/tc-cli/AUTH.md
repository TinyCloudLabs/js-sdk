# Authentication and existing accounts

The profile is local session state. The OpenKey signing identity owns the data. Reuse the identity the owner already uses; do not create a different account or reconnect integrations to obtain agent access. Every login below requests an explicit manifest, so the owner sees and approves exactly what this profile may do.

Use a new profile name if it already exists. Keep the user's existing profiles: a profile may hold another app's session (for example a TinyChat agent's `applications` session), and logging it in again for a different purpose would drop that authority. Give each purpose its own profile, such as `publisher` for Share publishing.

## Device login (agents, servers, phones)

Use device login when the owner cannot open a browser on the machine running `tc`. The owner approves on their phone.

```bash
TC="$(npm prefix --global)/bin/tc"
"$TC" profile list                         # pick a name that is not taken
"$TC" init --name publisher --key-only
"$TC" --profile publisher auth login --device --manifest builtin:share-publishing --expiry 7d
"$TC" --profile publisher context --json
```

- `--manifest FILE` (required with `--device`) is an app manifest (`app_id`, `space`, `permissions`) given as a file path or `base64:<json>`. `builtin:share-publishing` is the built-in manifest for `tc share publish`; [REFERENCE.md](REFERENCE.md#context-and-login) lists exactly what it requests, and the owner's consent page shows every capability. One space per login.
- Device login is for KV-scoped manifests. Every scoped login (device, browser, paste) adds `tinycloud.capabilities/read` on the space root (`""`) when the manifest lacks it: OpenKey requires it to sign any delegation and shows it as required. The CLI refuses `tinycloud.encryption` and the `secrets` space before a device request (`DEVICE_AUTH_UNSUPPORTED_SCOPE`); OpenKey also refuses `tinycloud.sql` and other excluded abilities with `SCOPE_REJECTED`. Request those through [browser or paste login with a manifest](#browser-login-with-a-manifest). Device login cannot grant secret reads.
- `--expiry` sets the session lifetime as a duration counted from approval (`1h`, `7d`, or milliseconds; at least `1m`; device login at most `30d`, default `30d`). OpenKey signs approval time plus the lifetime, so ISO dates are refused up front (`INVALID_EXPIRY`): an absolute deadline cannot survive an approval that takes longer than the 30 s clock-skew allowance. A signed session that would outlive the requested lifetime is refused.
- `--owner did:pkh:eip155:CHAIN:ADDRESS` refuses an approval by any other identity. Every login on a profile that already recorded an owner DID is held to that owner automatically, whatever wrote it (`tc init`, an earlier login, or `profile.json` with any posture), and `--owner` must agree with it. Only a local-owner-key profile is not pinned. Owner addresses compare case-insensitively; chain id and space name compare exactly. The owner, permissions and expiry recorded for a session only ever come from a verified signed proof; callback-supplied values are dropped.
- An OpenKey account can hold several keys. Each key is a separate owner with its own spaces and data, and one of them is the account's **primary key**. OpenKey preselects the primary key unless the request names an owner. OpenKey reports whether the approving key is primary. The profile records that as `ownerKeyPrimary`, and `tc auth status` shows it (`null` when OpenKey did not say). A login approved by another key succeeds, but prints a warning on stderr. To use a key that is not primary on purpose, pass `--owner` with its did:pkh, also on a plain `auth login` without `--manifest`: OpenKey then preselects that key. The flag is unsigned metadata, never authority.
- Scoped and device logins refuse a profile that holds a local owner key (`LOCAL_OWNER_PROFILE`): a local-owner-key posture, `authMethod: "local"`, or a stored private key, whatever the recorded posture. Use a separate profile.
- A live, unexpired session is replaced only by a scope that keeps everything it holds for the same owner and lasts at least as long: renewing the same manifest, or widening a session the owner narrowed earlier. Anything else, including an approval the owner narrowed, one that signs a caveat (a restriction such as a tenant) onto an action the live session holds unrestricted, or a renewal that would end earlier, refuses with `SESSION_IN_USE` and saves nothing. Use a new profile; pass `--replace-session` only when replacing that session is intended. The check runs on the request before consent and again on the approved scope before saving.
- Approval can take minutes. Before saving, the CLI re-reads the profile, key and session under the profile lock; if another login, key rotation or logout changed them meanwhile, it refuses with `PROFILE_CHANGED_DURING_LOGIN` and saves nothing. The CLI's profile, key and session writers take the same lock, and a failed commit write restores all three before the lock is released. If that restore fails too, the login fails with `PROFILE_STATE_INCONSISTENT` naming each failure; a crash between writes surfaces the same code on the next scoped login; check `tc --profile PROFILE context`, then use `--replace-session` or a new profile. The commit waits up to 45 s for the lock (a crashed holder's lock is reclaimed after 30 s), else `PROFILE_LOCK_TIMEOUT`; other commands that time out on the lock report the same code. Wait for the other tc or MCP process and retry.
- The other profile writers follow the same discipline. Local `tc auth rotate` signs in first and replaces the session in that compare-and-commit, so a change meanwhile refuses with `PROFILE_CHANGED_DURING_LOGIN` and the previous session stays. `tc profile delete` waits for the profile lock and removes the profile's files while holding it; a key, session, delegation or permission-request write that was waiting for the lock meanwhile then fails with `PROFILE_NOT_FOUND` instead of recreating the profile (see REFERENCE.md, Profile lock). A name that is not one path segment fails with `INVALID_PROFILE_NAME`. When `tc auth import` bootstraps a delegate profile's first session, the bootstrap reads and writes under the lock and never replaces a session that appeared after the import checked for one (`PROFILE_CHANGED_DURING_IMPORT`); if the bootstrap itself fails, it is rolled back. If a request-bound import (an artifact with a `requestId`) then fails, its bootstrap is rolled back only if the session and the profile's session DID and space still hold exactly what the bootstrap wrote (other profile changes made meanwhile, such as a new default space, are kept); if another login, logout or profile update replaced them, that newer state is kept and the error says so. Other import forms keep a successful bootstrap when a later step fails.

While waiting, the command writes one approval line to stderr and keeps polling for the whole approval window (about 10 minutes), riding out dropped connections:

```
Approve on your phone: https://openkey.so/device?user_code=ABCD-EFGH (code ABCD-EFGH)
  Or open https://openkey.so/device and enter code ABCD-EFGH.
  Waiting for approval until 2026-10-02T12:10:00Z. Keep this command running.
```

### Relaying the code as an agent

The command blocks until the owner approves, so a tool call that waits for exit never shows the code in time. Start it in the background with stderr captured, relay the approval line, then wait:

```bash
"$TC" --profile publisher auth login --device --manifest builtin:share-publishing > login.json 2> login.err &
LOGIN_PID=$!
sleep 3; grep 'Approve on your phone' login.err   # send this line to the owner
wait "$LOGIN_PID"; cat login.json
```

Send the owner the link and code through the channel they are already using with you, and say what it grants (for example "publish Share links from this agent for 7 days"). Only ask them to approve a request you just started. The code alone grants nothing; the owner must sign in to OpenKey and approve. Never send private keys, session files or `session.json` contents.

### What the CLI verifies

Before saving anything the CLI checks that the approval is bound to this transaction, session key, node and Share origin; that its expiry is within the requested lifetime; that the signed SIWE proof names this session key and the expected owner; and that OpenKey's approved set, the relayed delegation and the signed recap agree and stay inside the manifest. Any mismatch saves nothing.

The owner may uncheck capabilities. The JSON result lists `permissions` (approved) and `declined` (unchecked); the CLI also prints declined capabilities to stderr. A declined capability makes the commands that need it fail with a permission error.

Errors: `SCOPE_REJECTED` means OpenKey refuses that capability over device login (the message names it); remove it from the manifest. `DEVICE_AUTH_DENIED` means the owner declined. `DEVICE_AUTH_EXPIRED` means nobody approved in time; run the command again. `DEVICE_AUTH_RATE_LIMITED` means OpenKey received 5 device sign-in requests from this network within 10 minutes; wait before retrying. If OpenKey sends `Retry-After`, the CLI includes that wait in the error hint.

## Browser login with a manifest

On a machine with a browser, request the same manifest through the OpenKey browser flow:

```bash
tc --profile PROFILE auth login --method openkey --manifest /absolute/path/to/manifest.json --expiry 7d
```

`--paste` prints the approval URL on stderr and reads the owner's return code from stdin: a terminal paste, or piped text. End the code with a newline; a final line without one is also accepted. If stdin ends with no code, the command fails with `PASTE_CODE_MISSING` (exit 3), names the approval URL, and saves nothing. `--no-popup` prints the callback URL without opening a browser. The same signed-proof, owner, live-session, local-owner and commit-time checks apply, and the JSON result lists `permissions` (approved) and `declined` (unchecked). Older OpenKey responses without a signed proof are rejected for scoped login; do not drop the manifest to bypass that failure. `--expiry` reaches OpenKey as `<seconds>s`; dates and lifetimes under a minute are refused before the browser opens.

Browser approval uses stderr for the URL and accepts a code on terminal stdin even when stdout is redirected to a file or pipe. If neither stdin nor stderr is a terminal, use `--paste` instead of waiting for a browser. `--device --manifest` is available for eligible KV scopes, but cannot approve a secrets or encryption manifest.

## Secret reads for an agent

An agent reads named secrets through its own profile. The owner approves a scoped paste login whose manifest names the secrets. Device login cannot grant secrets.

```bash
cat > agent-secrets.json <<'EOF'
{ "app_id": "my.agent", "name": "My agent", "space": "secrets", "secrets": { "OPENAI_API_KEY": true } }
EOF
tc init --name agent-secrets --key-only
LOGIN=(tc --profile agent-secrets auth login --method openkey --paste --manifest agent-secrets.json
  --owner did:pkh:eip155:1:0xOWNER_ADDRESS --expiry 7d)
"${LOGIN[@]}" < /dev/null   # exits 3 with PASTE_CODE_MISSING; its stderr names the approval URL
# Send the owner that URL. After they approve and send back the code:
printf '%s\n' "$CODE" | "${LOGIN[@]}"
tc --profile agent-secrets secrets get OPENAI_API_KEY --raw
```

- The approval URL depends only on the profile's session key and the request, so the same command run again accepts the owner's code from stdin. Write the code followed by a newline; a final line without one is also accepted. Nothing is saved until a code verifies.
- `secrets: { NAME: true }` requests `tinycloud.kv/get` on `vault/secrets/NAME` in the `secrets` space, `tinycloud.capabilities/read` on that space, and decrypt on the owner's default secrets network. The decrypt entry is a raw network resource, `{ "service": "tinycloud.encryption", "space": "encryption", "path": "urn:tinycloud:encryption:<ownerDid>:default", "actions": ["tinycloud.encryption/decrypt"] }`; it does not count as a second space.
- The network belongs to the owner, so a profile with no recorded owner needs `--owner`, the did:pkh of the account that will approve (OpenKey refuses a network owned by anyone else). Without it the login fails with `OWNER_DID_UNKNOWN`; it never falls back to the profile's session `did:key`. A recorded or explicit owner address is EIP-55 checksummed in the network URN.
- If the owner unchecks decrypt, the login still succeeds and lists the decrypt entry in `declined`; reads of that secret then fail. Older OpenKey deployments sign decrypt inside the owner's secrets space rather than as a top-level network grant. That does not grant raw decrypt: it is listed in `declined` with an old-deployment warning and omitted from saved approved permissions. A later `auth request --grant` or secret-read escalation refuses that old nested proof before activating or storing a delegation, with `OPENKEY_GRANT_BROADENED`; obtain a new approval from a deployment that signs the raw network grant.
- A secrets command (`get`, `list`, `put`, `delete`) on an OpenKey profile without a grant for the name fails fast only when neither stdin nor stderr is a terminal: `PERMISSION_DENIED` (exit 5) with a hint naming this scoped login. Redirecting stdout (`|`, `>`, or command substitution) does not prevent a person at a terminal from seeing the browser approval prompt. If the session is missing or expired, a headless secrets command, including the canonical `secrets get` operation, instead fails with `AUTH_REQUIRED` (exit 3) and the scoped paste-login hint before invoking the node or starting an unscoped browser refresh.
- At a terminal, the owner approves the missing grant in OpenKey. The request carries the missing entries, `tinycloud.capabilities/read` on the space root (OpenKey signs nothing without it) and raw decrypt in the `encryption` pseudo-space; a decrypt-only request is placed in the `secrets` space (or `--space`), since OpenKey needs exactly one space. The signed `capabilities/read` counts as requested; anything else beyond the request is refused (`OPENKEY_GRANT_BROADENED`).
- A stored session that has expired, or no longer verifies for the profile's key, fails every command that needs it with `AUTH_REQUIRED` (exit 3) before any node request, whatever the profile kind; secrets commands on an owner OpenKey profile at a terminal refresh it in the browser instead. A delegate profile's hint names a new scoped paste login, a local owner key's names `auth login --method local`. It is never reported as a retryable node error. Operations and MCP report it as `SESSION_EXPIRED` (`retryable: false`).
- `secrets get -o FILE` validates the destination and its existing directory before fetching or decrypting secret bytes. It refuses symlinks, directories and devices, syncs a new owner-only (0600) file, then atomically replaces the destination. Directory sync is attempted after replacement where supported; its failure does not report a failed write when the destination was already replaced. A destination that cannot be replaced fails with a sanitized filesystem error naming the destination; there is no unsafe fallback.

## More spaces after login

Login covers one space. Request further spaces on the logged-in profile:

```bash
tc --profile PROFILE auth request --manifest FILE --grant --device
```

`auth request --device` defaults to a 7-day lifetime (`--expiry` to change it, at most `30d`). Without `--device`, `--grant` opens the OpenKey browser flow. Each space's request adds `tinycloud.capabilities/read` on that space's root, which OpenKey requires; a request of only raw decrypt is placed in the profile's primary space. Browser grants require a signed proof for the profile's session key and owner. Only the permissions and expiry in that proof can be activated and stored; an older space-nested decrypt proof, missing or foreign-owner proof, broader grant, wrong space, or too-long expiry is refused without storing a delegation.

## Imported delegations and their request bindings

Delegations stored in a profile's `additional-delegations.json` are installed again on every later command. A compact-UCAN delegation is installed only through validated activation, and only when its record carries an `authorityRequest` binding whose `requested` capabilities contain everything the delegation's signed bytes grant. A delegation broader than its binding is refused before it is activated. The CLI, `tc secrets get`, and MCP tools all apply this rule. A stored record whose `delegationHeader` is anything but a single string `Authorization` installs nothing.

- **Request-bound import.** `tc auth import` of an artifact with a `requestId` (from `tc auth grant`, or MCP `tinycloud_auth_import`) binds the delegation to the stored request it was checked against. Importing a stored delegation again this way replaces its record and binding.
- **Import without a request.** `tc auth import` of a bare portable delegation, a stored record, or an envelope with no `requestId`, addressed to this profile's session key, is validated the same way and bound to exactly its own signed capabilities: request ID `unbound-import:<cid>`, with an `authorityRequestAudit` note. No request limits it: the profile gets the delegation's full signed authority, whatever the artifact's `permissions` say. To limit what a delegation may grant, import it against a request instead (`tc auth request --emit`, then `tc auth grant` by the owner, then `tc auth import` of the result). This route never replaces or weakens a binding already stored for the same CID. A delegation whose `delegationHeader` is anything but a single string `Authorization` is refused with `INVALID_AUTH_IMPORT`.
- **One-time migration.** Records stored by earlier releases have no binding. The first command that restores the profile's own session binds each one to exactly its own signed capabilities (`migrated:<cid>`, audit note `source: "migration"`) and writes `delegation-binding-migration.json` in the profile directory, listing the CIDs it bound and the ones it left unbound. A migrated record never grants more than it did before. A record that cannot be bound (expired, for another session key, malformed, or signing capabilities no request can hold) stays unbound and installs nothing afterwards; the others are still migrated. Migration is best-effort and restartable: it runs under the profile lock, only while the stored session is still the one the command restored, writes the bound records first and the marker last, and a command that is interrupted or finds the lock busy leaves the rest to the next command. Bindings already written are kept.
- **After migration**, a compact-UCAN record without a valid binding installs nothing. For example, a delegation an older release imported, or a record pasted into the file. To recover it, run `tc auth import` on the artifact again with this release, or import a request-bound artifact for it.
- Older releases ignore the new fields. They do not enforce bindings, and an older `tc auth import` of a CID that is already stored replaces its record with an unbound one, which this release then refuses until it is imported again.
- Signed-login grants stored by `tc auth request --grant` and secret-read approvals are installed by the CLI as before, and a new grant never replaces a stored record for the same CID that carries a binding. A signed-login record that carries an `authorityRequest` but no `siweProof` cannot be held to its binding and installs nothing. The operations runtime behind MCP tools and `tc secrets get` never installed them and still does not. A cross-user delegation (addressed to the profile's identity rather than its session key) is not installed at all; `secrets get --delegation` reads it directly.

The binding is local profile data. It stops records written by other paths from granting authority. It does not stop someone who can write the profile directory, who already holds the session key and the signed bytes.

## Unscoped login and sign-out

`tc init` and `tc auth login` without a manifest request broad default-space consent, including writes, and replace the profile's session as before. Prefer `init --key-only` followed by a scoped login. They still verify OpenKey's signed proof whenever it carries one, the profile records an owner, or `--expiry` is given, and they keep the recorded owner. Non-interactive `auth login` never switches to device mode on its own, and never waits on a browser that cannot open: without `--device --manifest`, `--paste` or `--no-popup` it fails fast with `INTERACTIVE_LOGIN_REQUIRED`.

Only an explicit `--host` becomes the profile's stored host; `TC_HOST` and a discovered local node apply to that command only.

`tc auth logout` clears the local session and keeps the key. It is not node revocation, app disconnection, or removal of an agent's conversation history.

## Verify access

`context` and `auth caps` report local state. A real read of the intended resource is the only proof of access. A 403 can mean a missing capability; a missing or unhosted space means checking the intended location, not switching owner. An expired session needs renewed consent only when a read is needed.

Profile files (`key.json`, `session.json`, `profile.json`, grant history) are written owner-only (0600) in owner-only directories (0700); directories created 0775 by older releases are tightened on the next write.
