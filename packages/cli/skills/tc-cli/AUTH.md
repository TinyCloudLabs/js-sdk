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
- Device login is for KV-scoped manifests, and every device manifest must also request `{ "service": "tinycloud.capabilities", "path": "", "skipPrefix": true, "actions": ["read"] }` in the same space: OpenKey requires it to sign any delegation, shows it as required, and rejects a request without it with `SCOPE_REJECTED`. `builtin:share-publishing` already includes it. OpenKey also refuses `tinycloud.sql` and any other ability its device policy excludes with `SCOPE_REJECTED`; request SQL through [browser login with a manifest](#browser-login-with-a-manifest) on a machine with a browser.
- `--expiry` sets the session lifetime: a duration (`1h`, `7d`; at most `30d`, default `30d`) counted from approval, or an ISO date that stays an absolute deadline however long approval takes. It must leave at least 1 minute. A signed session that would outlive it is refused (30 s clock-skew allowance).
- `--owner did:pkh:eip155:CHAIN:ADDRESS` refuses an approval by any other identity. Every login on a profile that already recorded an owner DID is held to that owner automatically, whatever wrote it (`tc init`, an earlier login, or `profile.json` with any posture), and `--owner` must agree with it. Only a local-owner-key profile is not pinned. Owner addresses compare case-insensitively; chain id and space name compare exactly. The owner recorded on a profile only ever comes from a verified signed proof.
- Scoped and device logins refuse a profile that holds a local owner key (`LOCAL_OWNER_PROFILE`): use a separate profile.
- A live, unexpired session is replaced only by a scope that keeps everything it holds for the same owner: renewing the same manifest, or widening a session the owner narrowed earlier. Anything else, including an approval the owner narrowed, refuses with `SESSION_IN_USE` and saves nothing. Use a new profile; pass `--replace-session` only when replacing that session is intended. The check runs on the request before consent and again on the approved scope before saving.
- Approval can take minutes. Before saving, the CLI re-reads the profile, key and session under the profile lock; if another login, key rotation or logout changed them meanwhile, it refuses with `PROFILE_CHANGED_DURING_LOGIN` and saves nothing.

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

Errors: `SCOPE_REJECTED` means OpenKey refuses that capability over device login (the message names it); remove it from the manifest. `DEVICE_AUTH_DENIED` means the owner declined. `DEVICE_AUTH_EXPIRED` means nobody approved in time; run the command again.

## Browser login with a manifest

On a machine with a browser, request the same manifest through the OpenKey browser flow:

```bash
tc --profile PROFILE auth login --method openkey --manifest /absolute/path/to/manifest.json --expiry 7d
```

`--paste` prints a URL and waits for a return code in the terminal; `--no-popup` prints the callback URL without opening a browser. The same signed-proof, owner, live-session, local-owner and commit-time checks apply. Older OpenKey responses without a signed proof are rejected for scoped login; do not drop the manifest to bypass that failure. `--expiry` reaches OpenKey as seconds (an ISO date becomes the seconds left), so a value OpenKey cannot sign fails before the browser opens.

## More spaces after login

Login covers one space. Request further spaces on the logged-in profile:

```bash
tc --profile PROFILE auth request --manifest FILE --grant --device
```

`auth request --device` defaults to a 7-day lifetime (`--expiry` to change it, at most `30d`). Without `--device`, `--grant` opens the OpenKey browser flow.

## Unscoped login and sign-out

`tc init` and `tc auth login` without a manifest request broad default-space consent, including writes, and replace the profile's session as before. Prefer `init --key-only` followed by a scoped login. They still verify OpenKey's signed proof whenever it carries one, the profile records an owner, or `--expiry` is given, and they keep the recorded owner. Non-interactive `auth login` never switches to device mode on its own, and never waits on a browser that cannot open: without `--device --manifest`, `--paste` or `--no-popup` it fails fast with `INTERACTIVE_LOGIN_REQUIRED`.

Only an explicit `--host` becomes the profile's stored host; `TC_HOST` and a discovered local node apply to that command only.

`tc auth logout` clears the local session and keeps the key. It is not node revocation, app disconnection, or removal of an agent's conversation history.

## Verify access

`context` and `auth caps` report local state. A real read of the intended resource is the only proof of access. A 403 can mean a missing capability; a missing or unhosted space means checking the intended location, not switching owner. An expired session needs renewed consent only when a read is needed.

Profile files (`key.json`, `session.json`, `profile.json`, grant history) are written owner-only (0600) in owner-only directories (0700); directories created 0775 by older releases are tightened on the next write.
