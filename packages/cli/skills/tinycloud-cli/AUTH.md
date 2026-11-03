# Authentication and existing accounts

The profile is local session state. The OpenKey signing identity owns the data. Reuse the identity the owner already uses; do not create a different account or reconnect integrations to obtain agent access. Every login below requests an explicit manifest, so the owner sees and approves exactly what this profile may do.

Keep the user's existing profiles: a profile may hold another app's session (for example a TinyChat agent's `applications` session), and logging it in again for a different purpose would drop that authority. Reuse the onboarding profile from `tinycloud onboard`; ask for more with `tinycloud auth request --cap SPEC --grant --paste --expiry 30d` (or `--manifest FILE --grant --paste`), send the owner the link and one line on what it allows, and pass their code to the CLI exactly as sent.

## Device login (servers)

Use device login when the owner cannot open a browser on the machine running `tinycloud`. The owner approves on their phone.

```bash
tinycloud profile list                         # pick a name that is not taken
tinycloud init --name publisher --key-only
tinycloud --profile publisher auth login --device --manifest builtin:share-publishing --expiry 7d
tinycloud --profile publisher context --json
```

- `--manifest FILE` (required with `--device`) is an app manifest (`app_id`, `space`, `permissions`) given as a file path or `base64:<json>`. `builtin:share-publishing` is the built-in manifest for `tinycloud share publish`; [REFERENCE.md](REFERENCE.md#context-and-login) lists exactly what it requests, and the owner's consent page shows every capability. One space per login.
- Device login is for KV-scoped manifests. Every scoped login (device, browser, paste) adds `tinycloud.capabilities/read` on the space root (`""`) when the manifest lacks it: OpenKey requires it to sign any delegation and shows it as required. The CLI refuses `tinycloud.encryption` and the `secrets` space before a device request (`DEVICE_AUTH_UNSUPPORTED_SCOPE`); OpenKey also refuses `tinycloud.sql` and other excluded abilities with `SCOPE_REJECTED`. Request those through [browser or paste login with a manifest](#browser-login-with-a-manifest). Device login cannot grant secret reads.
- `--expiry` sets the session lifetime as a duration counted from approval (`1h`, `7d`, or milliseconds; at least `1m`; device login at most `30d`, default `30d`). OpenKey signs approval time plus the lifetime, so ISO dates are refused up front (`INVALID_EXPIRY`): an absolute deadline cannot survive an approval that takes longer than the 30 s clock-skew allowance. A signed session that would outlive the requested lifetime is refused.
- `--owner did:pkh:eip155:CHAIN:ADDRESS` refuses an approval by any other identity. Every login on a profile that already recorded an owner DID is held to that owner automatically, whatever wrote it (`tinycloud init`, an earlier login, or `profile.json` with any posture), and `--owner` must agree with it. Only a local-owner-key profile is not pinned. Owner addresses compare case-insensitively; chain id and space name compare exactly. The owner, permissions and expiry recorded for a session only ever come from a verified signed proof; callback-supplied values are dropped.
- An OpenKey account can hold several keys. Each key is a separate owner with its own spaces and data, and one of them is the account's **primary key**. OpenKey preselects the primary key unless the request names an owner. OpenKey reports whether the approving key is primary. The profile records that as `ownerKeyPrimary`, and `tinycloud auth status` shows it (`null` when OpenKey did not say). A login approved by another key succeeds, but prints a warning on stderr. To use a key that is not primary on purpose, pass `--owner` with its did:pkh, also on a plain `auth login` without `--manifest`: OpenKey then preselects that key. The flag is unsigned metadata, never authority.
- Scoped and device logins refuse a profile that holds a local owner key (`LOCAL_OWNER_PROFILE`): a local-owner-key posture, `authMethod: "local"`, or a stored private key, whatever the recorded posture. Use a separate profile.
- A live, unexpired session is replaced only by a scope that keeps everything it holds for the same owner and lasts at least as long: renewing the same manifest, or widening a session the owner narrowed earlier. Anything else, including an approval the owner narrowed, one that signs a caveat (a restriction such as a tenant) onto an action the live session holds unrestricted, or a renewal that would end earlier, refuses with `SESSION_IN_USE` and saves nothing. Use a new profile; pass `--replace-session` only when replacing that session is intended. The check runs on the request before consent and again on the approved scope before saving.
- Approval can take minutes. Before saving, the CLI re-reads the profile, key and session under the profile lock; if another login, key rotation or logout changed them meanwhile, it refuses with `PROFILE_CHANGED_DURING_LOGIN` and saves nothing. The CLI's profile, key and session writers take the same lock, and a failed commit write restores all three before the lock is released. If that restore fails too, the login fails with `PROFILE_STATE_INCONSISTENT` naming each failure; a crash between writes surfaces the same code on the next scoped login; check `tinycloud --profile PROFILE context`, then use `--replace-session` or a new profile. The commit waits up to 45 s for the lock (a crashed holder's lock is reclaimed after 30 s), else `PROFILE_LOCK_TIMEOUT`; other commands that time out on the lock report the same code. Wait for the other tc or MCP process and retry.
- A refusal of an approval OpenKey already granted (`OPENKEY_OWNER_MISMATCH`, `OPENKEY_SCOPE_MISMATCH`, `OPENKEY_GRANT_BROADENED`, `OPENKEY_APPROVAL_NARROWER`, `OPENKEY_PROOF_INVALID`, `OPENKEY_EXPIRY_EXCEEDED`, `DEVICE_AUTH_BINDING_MISMATCH`) leaves a live delegation that this CLI never used and cannot revoke (a login's approval carries no revoke ability). The CLI drops the saved copy of a pasted short code and the pending approval request, deletes the profile's key only when this command created it (a profile it created, which is removed again, or a key held in memory; a key that already existed is kept), and prints one notice on stderr: the delegation's CID, until when OpenKey granted it, whether its key was deleted or still exists on this device, and where to revoke it, https://account.tinycloud.xyz/delegations. Refusals that only mean the approval cannot be saved yet (`AUTH_EXPIRED`, an `OPENKEY_EXPIRY_EXCEEDED` that only exceeds the ceiling because this computer's clock is behind OpenKey's, `SESSION_IN_USE`, `PROFILE_CHANGED_DURING_LOGIN`, `REPLICA_GATED`, `PROFILE_LOCK_TIMEOUT`) keep the saved approval so the same command can finish it, and print no notice.
- The other profile writers follow the same discipline. `tinycloud auth rotate` (local or OpenKey) signs in first and replaces the key and session in that compare-and-commit: an OpenKey rotation does not touch `key.json` until the approval is verified (the new key waits in memory with `--paste`, or in the pending approval request's file, mode 0600, by default), so a refused or interrupted rotation, or a change meanwhile (`PROFILE_CHANGED_DURING_LOGIN`), leaves the old key and session as they were. `tinycloud profile delete` waits for the profile lock and removes the profile's files while holding it; a key, session, delegation or permission-request write that was waiting for the lock meanwhile then fails with `PROFILE_NOT_FOUND` instead of recreating the profile (see REFERENCE.md, Profile lock). A name that is not one path segment fails with `INVALID_PROFILE_NAME`. When `tinycloud auth import` bootstraps a delegate profile's first session, the bootstrap reads and writes under the lock and never replaces a session that appeared after the import checked for one (`PROFILE_CHANGED_DURING_IMPORT`); if the bootstrap itself fails, it is rolled back. If a request-bound import (an artifact with a `requestId`) then fails, its bootstrap is rolled back only if the session and the profile's session DID and space still hold exactly what the bootstrap wrote (other profile changes made meanwhile, such as a new default space, are kept); if another login, logout or profile update replaced them, that newer state is kept and the error says so. Other import forms keep a successful bootstrap when a later step fails.

While waiting, the command writes one approval line to stderr and keeps polling for the whole approval window (about 10 minutes), riding out dropped connections:

```
Approve on your phone: https://openkey.so/device?user_code=ABCD-EFGH (code ABCD-EFGH)
  Or open https://openkey.so/device and enter code ABCD-EFGH.
  Waiting for approval until 2026-10-02T12:10:00Z. Keep this command running.
```

### Relaying the code as an agent

The command blocks until the owner approves, so a tool call that waits for exit never shows the code in time. Start it in the background with stderr captured, relay the approval line, then wait:

```bash
tinycloud --profile publisher auth login --device --manifest builtin:share-publishing > login.json 2> login.err &
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
tinycloud --profile PROFILE auth login --method openkey --manifest /absolute/path/to/manifest.json --expiry 7d
```

Normal OpenKey login prints a short approval link on stderr and waits for the owner's approval. Send that link to the owner if the CLI is remote or headless. `--no-popup` skips opening a local browser; it still retrieves the encrypted result automatically, verifies the signed proof, saves the session durably and acknowledges delivery. No pasted code or localhost callback is needed, including when stdout is redirected. Re-run the same command after an interruption to resume. The request defaults to a one-hour expiry (maximum 24 hours); that is separate from the requested grant lifetime and the result's retention window. An omitted `--expiry` keeps the seven-day OpenKey grant default; onboarding explicitly requests 30 days.

`--paste` takes the short code the owner sends back; pass it exactly as sent. It prints its approval URL on stderr and reads the owner's five-minute, single-use return code from stdin. End the code with a newline; a final line without one is also accepted. If stdin ends with no code, the command fails with `PASTE_CODE_MISSING` (exit 3), names the approval URL, and saves nothing. Automatic short-link approvals do not produce this code. The same signed-proof, owner, live-session, local-owner and commit-time checks apply. Older OpenKey responses without a signed proof are rejected for scoped login; do not drop the manifest to bypass that failure. `--expiry` reaches OpenKey as a lifetime; dates and lifetimes under a minute are refused before approval. `--device --manifest` remains available for eligible KV scopes, but cannot approve a secrets or encryption manifest.

## Secret reads for an agent

Moved: see [AUTH-2.md](AUTH-2.md#secret-reads-for-an-agent)

### Asking the owner to add a missing secret

Moved: see [AUTH-2.md](AUTH-2.md#asking-the-owner-to-add-a-missing-secret)

## More spaces after login

Login covers one space. Request further spaces on the logged-in profile:

```bash
tinycloud --profile PROFILE auth request --manifest FILE --grant --paste
```

`auth request --device` defaults to a 7-day lifetime (`--expiry` to change it, at most `30d`). Without `--device`, `--grant` opens the OpenKey browser flow. Each space's request adds `tinycloud.capabilities/read` on that space's root, which OpenKey requires; a request of only raw decrypt is placed in the profile's primary space. Browser grants require a signed proof for the profile's session key and owner. Only the permissions and expiry in that proof can be activated and stored; an older space-nested decrypt proof, missing or foreign-owner proof, broader grant, wrong space, or too-long expiry is refused without storing a delegation.

`auth request --preset apps-agent [--app APP_ID]...` is a named request for an agent that picks up the user's tiny apps. By default it is read-only: `tinycloud.kv` get, list and `tinycloud.sql` read on the `applications` space, up to 7 days. `--app` (repeatable, at most 5) narrows every entry to `APP_ID/`. `--write` (needs `--app`, never for the whole space) adds `tinycloud.kv` put on each app's `knowledge/` and `prefs/` folders only, and `tinycloud.sql` write for those apps, which adds, changes and deletes rows. Creating, changing and dropping tables also needs `tinycloud.sql/schema`, which the preset adds only for an app's catalog database: `xyz.tinycloud.sample.healthlog` gets `healthlog`, at the exact path `APP_ID/healthlog` (no trailing slash). Other apps get no schema grant, and the scope notice says so. Every other file under `APP_ID/` stays read-only, including the code and the stored `APP_ID/app/manifest.json` and `APP_ID/app/install.json` (the root-level `APP_ID/manifest.json` and `APP_ID/install.json` are refused too). CREATE, ALTER and DROP need `tinycloud.sql/schema`, which SQL write alone does not carry; nodes before 1.21.6 do not enforce that split, so there SQL write can run them too. Neither variant carries KV delete, SQL admin, schema on any database other than the catalog one, any other service or space, or secrets. The scope is printed in plain words to stderr before any approval link or artifact. `auth grant` prints a scope for every request it signs, built from the request file as it will be signed: the preset wording only when the permissions, the owner's own `applications` space and the 7-day lifetime all match; otherwise one line per entry (service, space, path, actions in words; an unknown service or action is printed raw and marked "unrecognised"; delegation abilities in plain words such as "can give other people or agents access on your behalf") and the requested lifetime. The request file is resolved once, the way the signer reads it (an entry with no `space` is in your `applications` space and is described as that; an empty space is refused; entries with the same service, space and path are merged), and that one list is printed, gated and signed. Each entry is printed once. A request that carries the `tinycloud.vault` shorthand (the signer turns it into KV access on `vault/` for the vault actions you listed, which the printed list would not show), a service the signer cannot sign, or more than one space is refused with exit 2 before anything is printed or signed. The request's `sessionDid` and `requestedExpiry` are checked first. Text from the request is escaped, in error messages too (on a terminal every error message and hint is escaped, and JSON output writes control, bidi, zero-width and separator characters as `\uXXXX` escapes, which parse to the same text, so a redirected stdout with a terminal stderr is safe too), and refusal messages show at most 5 items of 80 characters each. When the request touches an `applications` space and holds any entry the preset could never grant, those entries are marked `!` and listed first under "MORE than the apps-agent preset" and signing needs `--yes` or an interactive confirmation. The question is written to stderr and answered on stdin, so it is still asked when stdout is redirected to a file; when stdin or stderr is not a terminal it exits 2 (`CONFIRMATION_REQUIRED`) and signs nothing, and an answer piped into stdin is not accepted. The preset replaces `--cap`, `--permission`, `--manifest` and `--expiry` (combining them is a usage error), and `--device` is refused because device approval cannot grant SQL. An empty path in `--cap` (`tinycloud.kv:applications::get,list`) covers the whole service in that space; a path ending in `/` covers the prefix. The agent's key can pass on access inside its own grant, so a grant is as private as the agent's profile. The owner revokes a grant made through the request, grant, import flow with `tinycloud delegation revoke CID`. A profile whose first grant was revoked or expired has a dead session; import the new grant into a new profile. See the `tinycloud-cli` skill, "Pick up a user's apps".

The owner approves in OpenKey.

## Imported delegations and their request bindings

Moved: see [AUTH-2.md](AUTH-2.md#imported-delegations-and-their-request-bindings)

## Stored grants

Moved: see [AUTH-2.md](AUTH-2.md#stored-grants)

## Unscoped login and sign-out

`tinycloud init` and `tinycloud auth login` without a manifest request broad default-space consent, including writes, and replace the profile's session as before. Prefer `init --key-only` followed by a scoped login. They still verify OpenKey's signed proof whenever it carries one, the profile records an owner, or `--expiry` is given, and they keep the recorded owner. Non-interactive `auth login` never switches to device mode on its own, and never waits on a browser that cannot open: without `--device --manifest`, `--paste` or `--no-popup` it fails fast with `INTERACTIVE_LOGIN_REQUIRED`.

`tinycloud auth login --method openkey` on a profile that does not exist creates a key-only profile first (a local key and no session, as `init --key-only` does), then continues into the login. Nothing is granted until the owner approves; abandoning the login leaves the key-only profile with no session. A `--manifest` or `--device` login still needs the profile to exist (use `tinycloud init --key-only --name X` first).

Only an explicit `--host` becomes the profile's stored host; `TC_HOST` and a discovered local node apply to that command only. A command that uses the stored session verifies it locally before probing a configured local node (`localNodeUrl`, `localLinkName`); an expired or invalid one is refused without contacting it. Login, logout, rotate, status, whoami, context, node, profile, `space host-request|switch`, `enable` and `auth request` without `--grant` probe as before, as does any command given `--private-key` or `TC_PRIVATE_KEY`, or a profile with no stored session.

`tinycloud auth logout` clears the local session. For OpenKey profiles it also replaces the share-history key (see below); a local-owner key is kept. It is not node revocation, app disconnection, or removal of an agent's conversation history.

`tinycloud auth logout` and `tinycloud auth rotate` replace the profile's share-history key. Before either runs, the CLI checks the sender history: if it holds unexpired shares, or cannot be read, the command refuses with `SHARE_HISTORY_UNEXPIRED` or `SHARE_HISTORY_UNAVAILABLE` (exit 5) and changes nothing. Pass `--force` to proceed anyway; `auth logout --revoke` also skips the check. After a key change, `share revoke <id>` can no longer revoke a bearer link issued under the old key (`SHARE_ISSUER_KEY_UNAVAILABLE`), so revoke those links first. An unreadable history file is moved aside, never deleted, only by `tinycloud share history recover`, which moves it to `share-history-v2.json.unreadable-<timestamp>`. A replica-enabled `tinycloud auth login` that replaces the key runs the same check; pass `--force` to skip it. A plain re-login that keeps the key is not checked. Local-owner profiles are not checked.

## Verify access

`context` and `auth caps` report local state. A real read of the intended resource is the only proof of access. A 403 can mean a missing capability; a missing or unhosted space means checking the intended location, not switching owner. An expired session needs renewed consent only when a read is needed.

Profile files (`key.json`, `session.json`, `profile.json`, grant history) are written owner-only (0600) in owner-only directories (0700); directories created 0775 by older releases are tightened on the next write.
