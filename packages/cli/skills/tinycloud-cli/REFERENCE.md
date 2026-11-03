# TC CLI Command Reference

<!-- BEGIN GENERATED TINYCloud operations coverage -->
This release has **Commander coverage tracked, not complete parity**:

- 4 migrated registration(s).
- 1 partially migrated registration(s).
- 150 legacy registration(s) remain Commander-owned.

- `auth import [source]` → `tinycloud.auth.import@1` (partial; legacy inputs: v1 delegation artifact, v1 permission artifact without command, bare portable delegation, stored delegation wrapper, cross-user delegation persisted with activated=false).
- `secrets get <name>` → `tinycloud.secrets.get@1` (migrated).
- `secrets probe <name>` → `tinycloud.secrets.status@1` (migrated).
- `knowledge list` → `tinycloud.knowledge.list@1` (migrated).
- `knowledge read <app_id> [concept]` → `tinycloud.knowledge.read@1` (migrated).
<!-- END GENERATED TINYCloud operations coverage -->

## Calling the CLI

Run the installed CLI as `tinycloud`. On Linux, `tc` is iproute2 traffic control at `/usr/sbin/tc`.

```bash
tinycloud --version
```

## Global Options

| Flag | Description |
|------|-------------|
| `-p, --profile <name>` | Profile to use |
| `-H, --host <url>` | Node URL override (default `https://tee.node.tinycloud.xyz`) |
| `-v, --verbose` | Verbose output |
| `-q, --quiet` | Suppress non-essential output |
| `--no-cache` | Disable caching |
| `--json` | Force machine-readable output |
| `--replication` / `--no-replication` | Enable/disable read-through replication for this invocation; `TC_REPLICATION=1` enables it by default, with command flags taking precedence |
| `--replication-debug` | Write per-read, write and sync diagnostics to stderr |

## Context and Login

```bash
tinycloud onboard                         # once; every later task reuses this profile
tinycloud onboard --timeout 60s           # same, bounded: 0 done, 8 pending (JSON on stdout), 3 request expired
tinycloud auth request --cap SPEC --grant --paste --expiry 30d   # more access: ask once
tinycloud context --json
```

`onboard --timeout <Ns|Nm>` and `auth grant --timeout <Ns|Nm>` bound the wait for the owner's OpenKey approval (more than 0, at most 9m; longer values, 0 and garbage are usage errors, exit 2 `INVALID_TIMEOUT`). Use `60s` where a command may not run past 2 minutes. **Exit 8 WITH a `pending` object is not a failure:** `{"pending":{"step":N,"of":M,"approvalUrl":"<link>","expiresAt":"<ISO time>"}}` on stdout means send the owner the `approvalUrl` (only the owner, privately: the link lets anyone who has it view the request), ask them to approve, and re-run the same command with the same `--timeout`; when the link changes at step 2 of 2, send the NEW link. It is printed once as soon as a new link has been created (so it can be sent at once), and again when the wait ends with a resumed link still unanswered. `auth grant req.json --timeout 60s > grant.json` writes that object into `grant.json` on exit 8; check the exit code before using the file. stderr keeps its human text. A pending link is reused, never replaced, and a second approval is never requested. `onboard` has 2 steps; `auth grant` is step 1 of 1 (an agent grant covers exactly one space). On a profile that does not sign in through OpenKey, `auth grant --timeout` is accepted and has nothing to bound. `onboard` refuses `--timeout` together with `--code` (exit 2): running it again would send the same code to the next step. Exit 0 prints the normal result. Exit 3 `APPROVAL_REQUEST_EXPIRED` means the link expired: run the command again. The usual end is one OpenKey call: its HTTP 400 `invalid_request` answer to a status check after the link's own expiry is exit 3 and the saved request is dropped, so the next run makes a new request with a new link (exit 3 can appear twice before that, once when the link expires while the wait is on and once for the 400). A request approved just before its expiry is still collected: OpenKey serves an approved result until its own retention ends (production `APPROVAL_RESULT_RETENTION_SECONDS=600`, `docker-compose.prod.yml:28` in the OpenKey repo). Only a saved request that expired more than 11 minutes ago (10 min retention + 1 min clock skew) and holds no result is dropped without asking OpenKey. Exit 8 WITHOUT a `pending` object (`APPROVAL_REQUEST_UNAVAILABLE`, `APPROVAL_RESULT_UNAVAILABLE`, `APPROVAL_ACK_PENDING`, `APPROVAL_RESULT_ACKNOWLEDGED`) means OpenKey could not be reached or could not confirm in time; run the same command again, the saved state resumes. An HTTP 400 `APPROVAL_REQUEST_UNAVAILABLE` before the link's own `expiresAt` is not an expiry and could be a real fault: if it repeats, ask for help (do not delete anything). A network failure while waiting for a link that is still valid is reported as `pending` too, so check its `expiresAt`. Once the owner has approved, the command never reports that approval as pending: it collects, verifies, saves and acknowledges the result even past the timeout, for up to 30 s more (an acknowledgement whose reply was lost is re-sent on the next run with the same id). The total is at most the timeout plus 30 s plus up to 3 s plus local and node work; an `onboard` that moves on to step 2 also creates that link, one request of up to 10 s, so `--timeout 60s` ends in about 105 s at the most for an existing account. A new account's storage can take a moment: after step 1 the call also waits for OpenKey to host the space, for the time left of the timeout plus the 30 s grace (at least 15 s, instead of the 150 s an unbounded `onboard` waits); on a new account that is about 90 s for `--timeout 60s`, at worst a little under 2 minutes. If the space is not ready by then the call ends with exit 1 `SPACE_SETUP_PENDING`: wait a minute and run it again; the re-run continues with step 2 (it does not check the space again), and if a storage command later says `Space not found`, wait and retry. OpenKey keeps an approved result for 10 minutes, so run the command again right after sending the link. A stale `.lock` left by a killed run is reclaimed after 30 s: wait 30 s and run it again (exit 1 `PROFILE_LOCK_TIMEOUT`). Without `--timeout` the command waits until the approval is answered.

`context` always emits JSON: profile, `ownerDid`, `sessionDid`, host, `spaceId` and local session expiry, with `access: "not-tested"`. It never prints keys or signed material.

| `auth login` flag | Description |
|------|-------------|
| `--device` | Approve on another device (phone) through OpenKey device authorization. Requires a KV-scoped `--manifest` (no `tinycloud.sql`, no secret decrypt). Prints `Approve on your phone: URL (code XXXX-XXXX)` to stderr and waits for the whole approval window |
| `--manifest <file>` | Request only this manifest's permissions: one space, plus raw `tinycloud.encryption` network entries (space `encryption`) such as a secrets decrypt grant. Every scoped login adds `tinycloud.capabilities/read` on path `""` in that space when missing (OpenKey requires it to sign). File path, `base64:<json>`, or `builtin:share-publishing` |
| `--expiry <duration>` | Session lifetime (`1h`, `7d`, milliseconds; at least `1m`) counted from approval; ISO dates are refused because OpenKey signs approval time plus a lifetime. Enforced against the signed session on every login path. Normal OpenKey login defaults to `7d`; onboarding explicitly requests `30d`. Device login: at most `30d`, default `30d` |
| `--owner <did>` | Refuse approval by any identity other than this `did:pkh`; must agree with an owner the profile already recorded. OpenKey preselects that owner's key, so this is how to sign in with a key that is not the account's primary key; it works on a plain login without `--manifest` too. Also names the secrets owner for a manifest's `secrets` when the profile has no recorded owner |
| `--replace-session` | Scoped or device login: replace a live session the new scope would narrow, change or shorten (otherwise `SESSION_IN_USE`); renewals and widenings that last at least as long need no flag |
| `--replication-prefix <prefix>` | Repeatable login request; adds `get` + `sync` only when an unrestricted covering `get` is already requested. Saves prefixes on the profile and reapplies them on later logins and rotation |
| `--replication-allow-secrets` | Explicitly allow prefixes in the `secrets` space or `vault` tree; replication stores ciphertext only |
| `--method openkey\|local` | Browser OpenKey flow or local Ethereum key |
| `--paste`, `--no-popup` | Normal OpenKey login prints a short approval link on stderr, waits for approval, then automatically verifies, durably saves and acknowledges the result. It works in a non-interactive terminal without a localhost callback or return code. `--no-popup` skips opening a local browser, not waiting. Re-run the same command after interruption to resume. `--paste` instead selects the explicit manual fallback with a five-minute, single-use return code on stdin; EOF without a code returns `PASTE_CODE_MISSING` without saving a key or session. Automatic links do not produce a manual code. |

`auth login --method openkey` on a profile that does not exist creates a key-only profile first (as `init --key-only` does), then continues into the login; nothing is granted until the owner approves. A `--manifest` or `--device` login still needs the profile to exist (use `tinycloud init --key-only --name X` first). `auth logout` on a missing profile still fails with `PROFILE_NOT_FOUND` and creates nothing.

Device login JSON lists the signed, approved `permissions`, owner-unchecked `declined` capabilities, `ownerDid`, `spaceId` and `expiresAt`. `tinycloud auth request --manifest FILE --grant --paste` adds another space to the onboarding profile: send the owner the link and pass their code to the CLI exactly as sent (default lifetime 7d; `--grant --device` also works for KV-scoped manifests). `tinycloud enable share [--replace-session]` is shorthand for device login with `builtin:share-publishing`. OpenKey refuses `tinycloud.sql` and other abilities outside its device policy; use normal OpenKey login (`--method openkey --manifest`) for those. Explicit `auth login` can wait for approval non-interactively; data commands never initiate consent to repair missing authority. Only an explicit `--host` is stored on the profile. Errors: `MANIFEST_REQUIRED`, `SCOPE_REJECTED` (OpenKey refused a capability; the message names it), `SESSION_IN_USE` (the request or the approved scope would narrow a live session; use a new profile or `--replace-session`), `PROFILE_CHANGED_DURING_LOGIN` (another login, key rotation or logout changed the profile while approval was pending; nothing saved), `PROFILE_STATE_INCONSISTENT` (profile, key and session disagree after an interrupted write; `--replace-session` or a new profile), `PROFILE_LOCK_TIMEOUT` (another process held the profile lock past 45 s), `LOCAL_OWNER_PROFILE` (scoped or device login on a local-owner-key profile; use a separate profile), `OPENKEY_UNREACHABLE`, `DEVICE_AUTH_DENIED`, `DEVICE_AUTH_EXPIRED`, `DEVICE_AUTH_BINDING_MISMATCH` (OpenKey's approval metadata disagrees with the signed grant), `OPENKEY_OWNER_MISMATCH`, `OPENKEY_GRANT_BROADENED`, `OPENKEY_EXPIRY_EXCEEDED` (the signed session outlives `--expiry`). Owner addresses compare case-insensitively (EIP-55 or lowercase); chain id and space name compare exactly. See [AUTH.md](AUTH.md).

`builtin:share-publishing` requests, in the owner's `default` space, exactly:

| Prefix | Abilities | Why |
|------|-------------|-----|
| `""` (space root) | `capabilities/read` | required by OpenKey to sign any delegation; lets the CLI read its own capability set |
| `xyz.tinycloud.share/shares/` | `kv/put` | store a bearer link's source |
| | `kv/get` | mint the link's read-only child delegation (a session delegates only what it holds) |
| `shares/` | `kv/put` | store an addressed share's encrypted source; `--action edit` |
| | `kv/get`, `kv/metadata` | back the Policy/v3 root that grants recipients read; `--notify` delivery authorization |
| | `kv/list` | `--action list` on a `--prefix` share |
| `artifacts/` | `kv/put` | `share publish --artifact`: write-once version files (`If-None-Match: *`) and their `manifest.json`. The node has no write-once ACL, so this `put` covers the whole `artifacts/` prefix: a session holding it could also overwrite an existing version file |
| | `kv/get` | mint the pinned share's read-only child delegation |
| | `kv/metadata` | back the Policy/v3 root of an addressed artifact share |
| | `kv/list` | find the next version number; `share versions` |

No `del` anywhere and no `list` on the bearer prefix: no `tinycloud share` command uses them. Inspect and receive use the link's own authority. Revoke signs `tinycloud.delegation/revoke` over the delegation's own CID and a Policy/v3 root revocation with the issuing session key, not a space capability. OpenKey shows the capability read as required (not uncheckable), so it is always in the signed grant and never in `declined`.

## Delegations

```bash
tinycloud delegation create \
  --to did:pkh:eip155:1:0xRecipient... \
  --path kv/shared \
  --actions kv/get,kv/put \
  --expiry 24h

tinycloud delegation list              # All
tinycloud delegation list --granted    # Granted by me
tinycloud delegation list --received   # Received by me
tinycloud delegation info <cid>
tinycloud delegation revoke <cid>
```

Actions are auto-prefixed with `tinycloud.` if not already.

`delegation revoke <cid>` is a generic exact-CID operation. When `<cid>` is
the current sign-in session, it requires `--yes` or an interactive confirmation
warning that revocation signs you out. After the node confirms that exact CID,
the CLI runs its normal durable logout, removes the restorable session and key,
and blocks implicit reauthentication. Unrelated CIDs do not sign you out.

From a delegate (agent) profile, `delegation list --granted` lists the delegations that profile's own key issued: every page of the node's issued-delegations listing, each with its `status`, sorted by delegation ID rather than by date (the output's `note` says so). A node that does not offer the listing yet answers `ISSUED_DELEGATIONS_UNAVAILABLE` (exit 7). `delegation revoke <cid>` from a delegate profile revokes a delegation its own key issued with a revocation signed by that key, so it needs no revoke grant from the owner. Revoking one that's already revoked also succeeds. A delegation the key did not issue is refused with the node's message (`REVOKE_UNAUTHORIZED`, exit 5). A chain too long for the node to check right now answers `CHAIN_TOO_DEEP` (exit 7); retry later. Owner profiles behave as described above.

A grant the owner signed through `auth grant` can be revoked from any of the owner's profiles, including one that never recorded it (another CLI profile or machine). When this profile has no local record of the CID, the CLI reads the owner's delegation records on the node and uses that record's space only if the grant was issued by the signed-in owner (the issuer is the owner or the signed-in session key, or a key that holds a delegation recorded on the node whose own issuer is, in turn, one of those: any holder along such an owner-rooted chain counts, up to 8 hops) and every space it covers is one plain space id (`tinycloud:pkh:eip155:<chain>:<address>:<name>`) that belongs to that owner. The lookup reads at most 5,000 records (pages of 100; a larger page is refused) and refuses rather than decides on a partial list. A CID the node does not list, one issued by someone else, a space the owner does not hold, or an ambiguous record is refused (`RAW_RECAP_RESOURCE_UNSUPPORTED`, "this CLI profile has no record of this grant and the node's record does not match the signed-in owner"). An OpenKey owner uses the same space-scoped request as for a locally recorded grant; OpenKey profiles hold no wallet signer, so there is no wallet-signed revoke for them. After the revoke, the agent's next call is refused (`GRANT_REVOKED`, exit 5, the same as `tinycloud replica`: "This grant was revoked. Ask the owner for a new grant") as soon as the node has recorded it.

`tinycloud auth import` stores delegations in `additional-delegations.json`. Every replay path installs only a grant with a locally verified proof and a binding containing its signed authority; unbound and proof-less grants never install, including while migration is deferred. [AUTH-2.md](AUTH-2.md#imported-delegations-and-their-request-bindings) covers migration and recovery.

### Stored grants

```bash
tinycloud --profile PROFILE auth grants list --json
tinycloud --profile PROFILE auth grants remove <cid>
tinycloud --profile PROFILE auth grants remove <cid> --revoke --yes
```

`list` is local and does not contact the node. Its JSON contains `profile`, `session` (`cid` recomputed from stored header and `expiresAt`, or `null`), `localVerification` (`available`, `session_missing`, `session_expired`, `session_invalid`), and `grants`. Each indexed grant row contains `cid` (CID-shaped or `null`), `expiry`, `expired`, `local` (`verified`, `refused`, `not_checked`, `for_another_key`), `reason` (fixed skip code or `null`), `node: "not_checked"`, `bound`, `proof` (`siwe`, `compact`, `missing`, or `null`), `source`, `scope`, and `scopeSource` (`signed` or `stored`). `for_another_key` means the stored audience names another key; its scope is unverified stored metadata and it cannot install in this session. Local verification checks signed scope and binding, not the node's delegation chain or revocation status. Human output shows `CID | LOCAL | EXPIRES | SOURCE | BOUND | SCOPE` and the session CID.

The `session` JSON object has `label: "current session"` for the active CID;
human output marks that CID `(current session)`. Do not treat the session CID
as a disposable replica child grant.

`for_another_key` is decided from a verified signed compact audience, CID, and matching transport DID, not an unsigned `delegateDID` alone. Tampered records retain their refusal reason, and proofless records retain `proof_missing`.

Local `remove` deletes every row matching that exact CID, and is available to delegates. `--revoke` alone is owner-only: it uses normal verified local-node discovery unless a host is explicit, revokes on the node, and removes the rows only after success. If the local removal then fails, `GRANT_REVOKED_LOCAL_REMOVE_FAILED` directs a local-only retry without `--revoke`. OpenKey cannot sign raw `urn:cid` authority on the deployed version; owner OpenKey revocation uses a verified CID-bound owner-space fallback, or immediately fails `RAW_RECAP_RESOURCE_UNSUPPORTED`. Local removal does not revoke the delegation; delegated sessions cannot use `--revoke` because this SDK cannot issue a delegatee self-revocation.

`tinycloud.delegation/revoke` on a space is space-wide: it can revoke any delegation in that space, including other apps' grants and the owner's own sessions. Request it only for the command that needs it, with a short expiry, and don't keep it: the CLI's own fallback asks for 5 minutes and stores nothing. Never put it in a long-lived grant or an app manifest.

A concurrent local removal after revocation reports `removed: 0` as success. Other local cleanup failures include `error.meta.causeCode` (for example `PROFILE_LOCK_TIMEOUT`).

## Spaces

```bash
tinycloud space list
tinycloud space create myspace
tinycloud space info                   # Current space
tinycloud space info <space-id>        # Specific space
tinycloud space switch myspace
```

`space list` reads the owner's account registry (`account/spaces/`) when the session holds `tinycloud.kv/get` and `tinycloud.kv/list` on the account space's `spaces/` prefix, and falls back to `tinycloud.space/list` only when the session holds that. A session with neither (including the default OpenKey owner sign-in, which covers only the `default` space) fails with `PERMISSION_DENIED` (exit 5) naming both; an owner grants the registry read with `tinycloud auth request --grant --cap tinycloud.kv:account:spaces/:get,list`.

## Profiles

Multiple identities/environments with isolated keys and sessions.

```bash
tinycloud profile list
tinycloud profile create staging --host https://staging.tinycloud.xyz
tinycloud profile show                 # Current profile
tinycloud profile switch staging       # Change default
tinycloud profile delete old-profile
```

Per-command override: `tinycloud kv get mykey --profile staging`

## Secrets

Moved: see [REFERENCE-2.md](REFERENCE-2.md#secrets)

### Running a command with secrets: `run`

Moved: see [REFERENCE-2.md](REFERENCE-2.md#running-a-command-with-secrets-run)

### Asking the owner for a secret: `request`, `wait`, `manage`

Moved: see [REFERENCE-2.md](REFERENCE-2.md#asking-the-owner-for-a-secret-request-wait-manage)

### Scoped secret reads for agents

Moved: see [REFERENCE-2.md](REFERENCE-2.md#scoped-secret-reads-for-agents)

## Local Replicas

Moved: see [REFERENCE-2.md](REFERENCE-2.md#local-replicas)

## Courier

`tinycloud courier …` runs Courier, agent-to-agent threads over TinyCloud, with its own profile in `$COURIER_HOME` (default `~/.courier`); it takes no tinycloud options. See the [courier skill](../courier/SKILL.md).

## Read-through Replication Diagnostics

Moved: see [REFERENCE-2.md](REFERENCE-2.md#read-through-replication-diagnostics)

## Node Health

```bash
tinycloud node health                  # Ping + latency
tinycloud node version                 # Server version
tinycloud node status                  # Combined
```

## Shell Completions

```bash
eval "$(tinycloud completion bash)"
eval "$(tinycloud completion zsh)"
tinycloud completion fish | source
```

## Share Publish, Inspect, Receive, List, Revoke

Moved: see [REFERENCE-3.md](REFERENCE-3.md#share-publish-inspect-receive-list-revoke)

### Share Publish Options

Moved: see [REFERENCE-3.md](REFERENCE-3.md#share-publish-options)

### Artifacts

Moved: see [REFERENCE-4.md](REFERENCE-4.md#artifacts)

## KV Put Input Sources (mutually exclusive)

Moved: see [REFERENCE-4.md](REFERENCE-4.md#kv-put-input-sources-mutually-exclusive)

## Profile Directory Structure

Moved: see [REFERENCE-4.md](REFERENCE-4.md#profile-directory-structure)

### Profile lock

Moved: see [REFERENCE-4.md](REFERENCE-4.md#profile-lock)

## DID Formats

Moved: see [REFERENCE-4.md](REFERENCE-4.md#did-formats) (also holds the error and exit codes)
