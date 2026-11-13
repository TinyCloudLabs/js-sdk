# @tinycloud/courier

## 0.6.0-beta.31

### Patch Changes

- Updated dependencies [2a8edc2]
  - @tinycloud/node-sdk@3.12.0-beta.26

## 0.6.0-beta.30

### Patch Changes

- f6e60a8: `courier watch` makes far fewer node calls while idle:
  - It lists every peer in full every 5 minutes while its hook subscriptions are healthy, instead of every minute. Hook events still deliver at once. A failed or ended subscription catches up at once and brings back the full listing every `--poll` seconds until a new stream is healthy. A peer whose sync did not finish is listed again at the next minute.
  - A catch-up lists the pause markers once for all peers, reads receipts only when the listing holds a message they are not known to cover, and lists known threads only for a peer's pause notice.
  - The scheduled renewal and authority check runs every 5 minutes, so detecting an idle revocation and cleaning up sibling grants takes up to 5 minutes. Enforcement is unchanged: the node refuses revoked grants. A hook event for a peer's renewal marker or a refusal checks at once, after re-reading the marker; a refused sync is retried only under a different grant.

  Watcher state (`watch.json`, pause markers, wake claims) now lives under `me/state/agents/<did:key id>/` for each Courier agent, so two agents of one owner can run in one space without a state conflict. `courier pause` and `courier resume` use the same keys. The old shared `me/state/` records for an agent's own peers are copied on its first start and left in place. `courier pause` and `courier resume` read a thread's shared pause marker too, so a thread paused before the upgrade stays paused until a human resumes it. A second watcher of the same agent no longer exits with `state-conflict`, which `Restart=always` turned into a restart and catch-up loop. It stands by instead, checks `watch.json` once per window (5 to 30 minutes), and takes over after a quiet window. `--once` still exits with `state-conflict`.

  `courier intake` doubles its wait after a cycle that queued nothing, up to 5 minutes or `--interval` if that is longer, and returns to `--interval` on the next queued message. `courier read` caches create-only messages and meta in `<COURIER_HOME>/read-cache/<agent>/`, so reading an unchanged thread again fetches only its listings and tasks. Messages are create-only; a later overwrite of the same key isn't shown. The cache is owner-only, bounded at 64 MiB and 7 days per agent, and deleted on `revoke`, a refusal, an owner revocation and a key rotation.

  Importing from a peer, waking an agent for it and informing it each take a fresh authority check first; a removed or refused peer's queued wake or inform is dropped, and a check that cannot confirm access (a node error, a timeout) fails closed: nothing runs and the item is retried on the next pass. With `--poll` above 5 minutes, the authority check and dirty-peer retries still run every 5 minutes.

  Details: TC-2917

## 0.6.0-beta.29

### Patch Changes

- Updated dependencies [56df81d]
  - @tinycloud/sdk-core@3.12.0-beta.24
  - @tinycloud/node-sdk@3.12.0-beta.24

## 0.6.0-beta.28

### Patch Changes

- Updated dependencies [e3cd63b]
  - @tinycloud/share-envelope@1.6.0-beta.1
  - @tinycloud/node-sdk@3.12.0-beta.23
  - @tinycloud/sdk-core@3.12.0-beta.23
  - @tinycloud/share-sdk@1.5.0-beta.3

## 0.6.0-beta.27

### Patch Changes

- Updated dependencies [d4366f9]
  - @tinycloud/sdk-core@3.12.0-beta.22
  - @tinycloud/node-sdk@3.12.0-beta.22

## 0.6.0-beta.26

### Patch Changes

- Updated dependencies [766d27a]
  - @tinycloud/sdk-core@3.12.0-beta.21
  - @tinycloud/node-sdk@3.12.0-beta.21

## 0.6.0-beta.25

### Patch Changes

- @tinycloud/node-sdk@3.12.0-beta.20
- @tinycloud/sdk-core@3.12.0-beta.20

## 0.6.0-beta.24

### Patch Changes

- d4cb4df: Courier renews a paired peer's read access, up to 30 days at a time, while your own access is live, and asks for your approval in OpenKey before your access ends. To stop sharing, revoke the pairing. Expired or revoked access requires a new pairing.

  Details: TC-2746

## 0.6.0-beta.23

### Patch Changes

- 33a2fde: Courier now picks up renewed access from paired peers before reading their messages or subscribing to them, while the current access is still valid.

  Details: TC-2746

## 0.6.0-beta.22

### Patch Changes

- 3dfd566: `courier revoke` now revokes the peer's access on your TinyCloud node, so their next read is refused. If it can't finish, the pairing is kept and you can run it again.

  Details: TC-712

- Updated dependencies [5fe6cff]
  - @tinycloud/sdk-core@3.12.0-beta.19
  - @tinycloud/node-sdk@3.12.0-beta.19

## 0.6.0-beta.21

### Patch Changes

- 82a327f: Hide the beta Courier invite command from help and usage documentation.

  Details: TC-2234

## 0.6.0-beta.20

### Patch Changes

- Updated dependencies [7266493]
  - @tinycloud/share-sdk@1.5.0-beta.2
  - @tinycloud/node-sdk@3.12.0-beta.18
  - @tinycloud/sdk-core@3.12.0-beta.18

## 0.6.0-beta.19

### Minor Changes

- e3e4bd7: `courier invite --mode email` asks the owner for one approval per invitation. The approval request carries the recipient, session name and dates; OpenKey chooses the Share key and returns a grant for that one key (`key.create` and `decrypt`), valid until the invitation expires (at most 24 hours). Courier writes the pending invitation before asking, sends nothing until the approval is verified, and uses the approved grant only for that invitation's key; the main Courier grant is not changed. Run the same command again to continue a pending invitation. `@tinycloud/share-envelope/links` adds an optional strict `context` to the approval request (with no permissions) and `buildShareInvitationApprovalSpec`.

  Details: TC-2234

### Patch Changes

- Updated dependencies [e3e4bd7]
- Updated dependencies [273491d]
  - @tinycloud/share-envelope@1.6.0-beta.0
  - @tinycloud/sdk-core@3.12.0-beta.17
  - @tinycloud/share-sdk@1.5.0-beta.1
  - @tinycloud/node-sdk@3.12.0-beta.17

## 0.6.0-beta.18

### Patch Changes

- a6234a9: Add `courier status [--peer <peer>] [--json]` to show saved inbound and outbound grant expiry separately, with warnings within 24 hours of expiry.

  Details: TC-2747, TC-2755

## 0.6.0-beta.17

### Patch Changes

- Updated dependencies [f859fb3]
  - @tinycloud/node-sdk@3.12.0-beta.16
  - @tinycloud/sdk-core@3.12.0-beta.16

## 0.6.0-beta.16

### Minor Changes

- 88a5f28: Adds the Courier email-invitation code on the existing Share path (`courier invite --mode email --recipient <email>`, `courier join <share link> --consent [--code-stdin]`). **It cannot send a real invitation yet:** there is no Courier path to request or install per-invitation authority (see below), so `courier invite --mode email` fails closed for every real grant: an ordinary grant ends at `invite-authority-missing`, and a grant carrying a `share/` prefix, several keys or half a pair is refused earlier, when the grant is loaded, as `grant-too-broad`. The design is: the invitation body, with its existing pairing relay, is encrypted under a fresh `share/<shareId>` key and registered as one path-bound, digested Share policy owned by the Courier `did:key`; OpenCredentials mails the link and only the verified mailbox holder can open it; the session join, read and peer-delegation path is the existing one. The mode is not listed in `INVITATION_MODES` or the guide. The send and receive steps are tested only against stand-ins; no full link, decrypt and join run exists and no OpenKey call was made.

  Courier's grant check is exact: the base grant is exactly `AGENT_GRANT`, and any `share/` entry (one exact key, the prefix, several keys, half a pair) is refused at grant load as `grant-too-broad`. The standing base grant never carries a share key. `courier invite --mode email` now generates the random share id first and checks that exact `share/<id>` authority before it creates anything: a grant with no share key, or one well-formed exact key for another id, stops with `invite-authority-missing` and has created no pairing relay delegation, invitation state, Share key, link or email. With authority for the generated id, the relay and state are created and the same id goes to the Share step. Courier does not request that authority and nothing binds a previously signed key to the generated id, so today the check only passes for a grant that already names it, which no real grant can (the id is random and generated at invite time). What is missing is a per-invitation owner approval: an OpenKey `/delegate` that issues an exact-key `key.create` + `decrypt` grant (not run, not proven; `DelegateRequest.permissions` can carry the entries) and a Courier path to install it (Courier stores one `grant.json`, and `installGrant` replaces it). That is OpenKey and grant-scope work, not done; which scope to request is an open decision. Future design constraint: the installed grant is valid for up to 30 days (`AGENT_GRANT_EXPIRY` is the default and the maximum; `courier init --expiry` can shorten it) while an invitation lives at most 24 hours, so an approval that re-issues the whole grant per invitation would renew that authority each time, and a key-only approval should expire with the invitation. Calling the library `sendEmailInvitation` after `issueInvitation` and failing the same check leaves the relay delegation (it expires with the invitation) and the invitation state record, which nothing deletes; the error message names both.

  Opening an invitation (`courier join <link> --consent --code-stdin`) checks everything it can before the one-time code reaches the witness: the signed envelope's exact resource path (`…/to/invite-<id>/envelope/<shareId>.json`), its expiry, its node origin against this profile's host, that its issuer is not this agent, the local profile, grant and node, and whether this invitation id was already joined. A failed check leaves the pending proof untouched. The body is encrypted, so its session, relay and pairing artifact cannot be checked until it is decrypted; then its id, node origin, issuer, expiry and space must equal the envelope's and the join state is checked again. The pending proof follows `courier credential acquire`: it is kept after a recoverable witness rejection (`EmailProofError.recoverable`) so the same request takes another code, and deleted on a terminal failure, once the code was accepted, and on success.

  `@tinycloud/node-sdk` adds `@tinycloud/node-sdk/share-publish` (`publishEmailShareV3`, moved unchanged from the CLI), `emailProofDescriptor` in `@tinycloud/node-sdk/credentials`, and `resumeAgentShareReceive` in `@tinycloud/node-sdk/share-receive` for a two-step receive across processes. The CLI imports `publishEmailShareV3` from node-sdk.

  Needs a node release containing the Policy/v3 named-key binding (#481) and the refusal of unbound registrations (#485) before it works against production.

  Details: TC-2234

### Patch Changes

- Updated dependencies [88a5f28]
  - @tinycloud/node-sdk@3.12.0-beta.15

## 0.5.3-beta.15

### Patch Changes

- c55863a: Resolve known threads to their peers and preserve available messages when a peer read fails. Read and inbox output explicitly report partial results instead of claiming an unreadable inbox is empty.

  Details: TC-2748

## 0.5.3-beta.14

### Patch Changes

- Updated dependencies [e50dd6c]
  - @tinycloud/sdk-core@3.12.0-beta.14
  - @tinycloud/node-sdk@3.12.0-beta.14

## 0.5.3-beta.13

### Patch Changes

- Updated dependencies [649bb18]
  - @tinycloud/sdk-core@3.12.0-beta.13
  - @tinycloud/node-sdk@3.12.0-beta.13

## 0.5.3-beta.12

### Patch Changes

- Updated dependencies [693676e]
  - @tinycloud/sdk-core@3.12.0-beta.12
  - @tinycloud/node-sdk@3.12.0-beta.12

## 0.5.3-beta.11

### Patch Changes

- Updated dependencies [5f271e5]
  - @tinycloud/node-sdk@3.12.0-beta.11

## 0.5.3-beta.10

### Patch Changes

- Updated dependencies [593f051]
  - @tinycloud/node-sdk@3.12.0-beta.10
  - @tinycloud/sdk-core@3.12.0-beta.10

## 0.5.3-beta.9

### Patch Changes

- Updated dependencies [e409bef]
  - @tinycloud/sdk-core@3.12.0-beta.9
  - @tinycloud/node-sdk@3.12.0-beta.9

## 0.5.3-beta.8

### Patch Changes

- Updated dependencies [c070c4b]
  - @tinycloud/sdk-core@3.12.0-beta.8
  - @tinycloud/node-sdk@3.12.0-beta.8

## 0.5.3-beta.7

### Patch Changes

- @tinycloud/node-sdk@3.12.0-beta.7
- @tinycloud/sdk-core@3.12.0-beta.7

## 0.5.3-beta.6

### Patch Changes

- 2c3c65d: Courier refuses a flag the command does not accept: it exits 2 with `Unknown flag --name for <command>` and the accepted flags, before reading stdin or a grant file or touching the profile.

  Details: TC-2343

## 0.5.3-beta.5

### Patch Changes

- 2139b24: Sign-in requests to OpenKey now include only the standard public members of the session key.

  Details: TC-2582

- Updated dependencies [2139b24]
  - @tinycloud/sdk-core@3.12.0-beta.5
  - @tinycloud/node-sdk@3.12.0-beta.5

## 0.5.3-beta.4

### Patch Changes

- Updated dependencies [ccf3347]
  - @tinycloud/sdk-core@3.12.0-beta.4
  - @tinycloud/node-sdk@3.12.0-beta.4

## 0.5.3-beta.3

### Patch Changes

- Updated dependencies [b32f52e]
- Updated dependencies [66a03e0]
  - @tinycloud/sdk-core@3.12.0-beta.3
  - @tinycloud/node-sdk@3.12.0-beta.3

## 0.5.3-beta.2

### Patch Changes

- Updated dependencies [9ff4cf2]
  - @tinycloud/node-sdk@3.12.0-beta.2

## 0.5.3-beta.1

### Patch Changes

- Updated dependencies [55d52f7]
  - @tinycloud/node-sdk@3.12.0-beta.1

## 0.5.3-beta.0

### Patch Changes

- Updated dependencies [5817c2b]
  - @tinycloud/node-sdk@3.11.1-beta.0

## 0.5.2

### Patch Changes

- 7062e9f: Courier now prints `Next:` lines on stderr. Every line that hands the owner a link asks the agent only to send the owner that link in its reply now, and, where there is a follow-up command, to run it when the owner next writes to the agent (it no longer asks for the command in the same reply). The follow-up command is named in backticks, written as the user ran Courier (`courier` or `tinycloud courier`). This works best with a short `--timeout` (for example `1s`) so the pending exit is immediate and the flow continues on the owner's next message; in testing the request is not always followed, so it is a request, not a guarantee. `courier init --request` ends its stderr with a line that asks for the link above to be sent now and `init --wait --timeout 60s` to be run when the owner next writes. A pending `courier init --wait` (exit 8) ends with a line that names the same command again (only when every part of the command line is a known `init --wait` flag with a plain value; otherwise the words `this same command` and nothing from the command line, including any control character, is echoed): for a link created in this run, send the link now and run the command when the owner next writes; for a resumed request, send the link only if it has not been sent yet. A pending `courier invite --wait` ends its stderr, after the existing `[invite-pending]` line, with a line that asks for the invitation link (which stays on stdout) to be sent now and `invite serve <id> --wait 60` to be run when the owner next writes. `courier invite serve` prints, at the start of every run of a live, unclaimed invitation (not an expired or already-claimed one), a line with the saved invitation link to send if it has not been sent yet, and, if it ends pending, a last line after `[invite-pending]` that says no one has joined yet and to run the same command again now (it has no link to hand over, so it keeps the run-again wording). A claimed invitation prints no run-again line. stdout JSON and exit codes are unchanged, and other runs print no such line.

  Details: TC-2360

## 0.5.2-beta.0

### Patch Changes

- 7062e9f: Courier now prints `Next:` lines on stderr. Every line that hands the owner a link asks the agent only to send the owner that link in its reply now, and, where there is a follow-up command, to run it when the owner next writes to the agent (it no longer asks for the command in the same reply). The follow-up command is named in backticks, written as the user ran Courier (`courier` or `tinycloud courier`). This works best with a short `--timeout` (for example `1s`) so the pending exit is immediate and the flow continues on the owner's next message; in testing the request is not always followed, so it is a request, not a guarantee. `courier init --request` ends its stderr with a line that asks for the link above to be sent now and `init --wait --timeout 60s` to be run when the owner next writes. A pending `courier init --wait` (exit 8) ends with a line that names the same command again (only when every part of the command line is a known `init --wait` flag with a plain value; otherwise the words `this same command` and nothing from the command line, including any control character, is echoed): for a link created in this run, send the link now and run the command when the owner next writes; for a resumed request, send the link only if it has not been sent yet. A pending `courier invite --wait` ends its stderr, after the existing `[invite-pending]` line, with a line that asks for the invitation link (which stays on stdout) to be sent now and `invite serve <id> --wait 60` to be run when the owner next writes. `courier invite serve` prints, at the start of every run of a live, unclaimed invitation (not an expired or already-claimed one), a line with the saved invitation link to send if it has not been sent yet, and, if it ends pending, a last line after `[invite-pending]` that says no one has joined yet and to run the same command again now (it has no link to hand over, so it keeps the run-again wording). A claimed invitation prints no run-again line. stdout JSON and exit codes are unchanged, and other runs print no such line.

  Details: TC-2360

## 0.5.1

### Patch Changes

- d93ac9b: `courier init` works out where it stands once, from the profile status, the saved grant, the agent key, a saved redeemed grant, the saved approval request and the key-rotation record, and every mode (`--request`, `--wait`, `--resume`, `--rotate-key`, `--grant-file`) recovers from that one result.
  - `init --resume` continues as `init --wait` when an approval from the owner is saved and no grant is waiting to be installed; with a grant waiting it installs the grant and keeps the approval for the next `init --wait`.
  - A saved approval whose profile or agent key is missing is refused, and no file is changed (before, `init --wait` and `init --request` started a new request over it).
  - A `grant.json` that is cut short or is not a grant counts as no saved grant and is reported once. A `profile.json` that cannot be read is reported as such and never treated as missing.
  - `init --rotate-key` replaces the agent key, the profile and the grant as one journaled step that the next `init` finishes if it is interrupted. The record is checked before it is replayed, and a stray temporary key file left by a killed process is overwritten with zeros and removed. It still discards a held approval with a warning; when the approval already held a granted result, or a redeemed grant for the old key was saved, it also says a live grant may exist, until when, and that the owner can revoke it at https://account.tinycloud.xyz/delegations.
  - A corrupt key file could print part of the private key in an error message; fixed. Courier now reports only the file name and that it is unreadable or corrupt for the state files it reads with its profile reader (`key.json`, `profile.json`, `grant.json`, `rotation.json`) and for `approval-pending.json`. Parse errors for input a person supplies, such as an invitation passed to `invite join`, are outside this change.
  - The saved approval request is read, written and classified in one module (`approval-phase`); the file format and the approval flow are unchanged.

  Details: TC-2383

- d93ac9b: Follow-up corrections to `courier init` state handling.
  - A corrupt or cut-short `approval-pending.json` is reported with a fixed reason. The JSON parser's message quoted the text around the failure, which could include `relayPrivateKey`.
  - A `grant.json` that has the shape of a grant but is not owner-only is a saved grant: `init` stops with `profile-permissions` and `chmod 600` advice and changes no file (before, it counted as no grant and a renewal could replace it). `init --rotate-key` still discards the grant, as before. A loose-mode `grant.json` that is corrupt or not a grant gets the corrupt-file warning instead, with no `chmod` advice.
  - `init --rotate-key`, with or without `--request`/`--wait`, refuses before writing anything when the saved approval cannot be read, naming the file and the `chmod` that fixes it. Before, a plain `--rotate-key` rotated the key and left that approval bound to the old one.
  - The rotation record's key is proven before replay: `kty` OKP, `crv` Ed25519, `x` and `d` as unpadded base64url text of exactly 32 bytes, `x` the public key of `d` (both in canonical base64url), and a `did:key` derived from `x` whose single optional `#fragment` names the same key. Any other record is refused and no file changes.
  - Stray key-bearing temporary files now include those of `approval-pending.json`. A file whose writing process is still running (`kill(pid, 0)` answers, or `EPERM`) is kept, not deleted, and reported by name. The process may be a live writer, whose key must not be zeroed between its fsync and its rename, or an unrelated process that was given the same pid after Courier died; Courier cannot tell which, so the file stays until that process is gone or the owner removes it.
  - The rotation record notes the installed grant's delegation CID and expiry (no secrets) before `grant.json` is removed. The rotation, and an `init` that finishes an interrupted one, then says the old grant is not revoked, may still be valid, and that the owner can revoke it at https://account.tinycloud.xyz/delegations. A saved approval that holds only a result reference is not a grant and gets no revocation page.
  - When `key.json` cannot be read, redeemed grants in `pending-grant.json` cannot be matched to the old key. The rotation keeps them and reports each with its CID and the revocation page. A later `init --resume` that finds a saved grant bound to a key the profile does not hold drops it, as it always has; the rotation's report is the record of it.
  - A temporary file holds key material of any of the three files: an agent key (the new one, or the one being rewritten) or an approval's relay key and encrypted result. Those of `approval-pending.json` are now scrubbed silently like the others.
  - The read-only readers added for this work (`pending-grant.json`, and `grant.json` for the loose-mode check and the rotation notice) never follow a symlink and never block on a FIFO; a `pending-grant.json` that is not a regular file of this user counts as no saved delegation. The `rm` command in the recovery line is shell-quoted. Stray temporary files are classified from one directory listing with one liveness check each.

  Details: TC-2383

- 053f912: Courier no longer loses pairings, revocations or key rotations when two commands use the same profile. A command that holds a copy of `profile.json` for a long time (`init --wait`, `invite serve`) used to save that copy over whatever another command had written meanwhile.
  - `profile.json` is saved under a lock (`profile.json.lock`) that uses the intake lock: an `{pid, nonce}` owner record created whole, released only by its own nonce, broken only when its holder is established dead (on this machine and host, either a different true boot id (Linux boot_id, macOS kern.bootsessionuuid) or its pid is absent (on Linux, in the same pid namespace); a pid that exists is never judged dead, so a crashed holder whose pid was reused needs the manual recovery line). A stale lock is broken by one breaker at a time. A lock is never broken because it is old. If its holder is alive, is on another host or pid namespace, or the record cannot be read, the save waits 10 s and then refuses with `[profile-locked]` and one line naming the lock file, the holder and `rm -f -- <lock>` (PowerShell on Windows: `Remove-Item -LiteralPath <lock> -Force`) to clear it once no Courier command is running; the lock is left in place. The save re-reads the file and writes only what the command itself changed: a pairing made, a peer revoked or a renewal imported meanwhile is kept. Two renewals racing keep every outbound delegation and the longer inbound one, so a shorter artifact imported last no longer replaces a longer one.
  - A command that started before `init --rotate-key` finished is refused with `[profile-changed]` and writes nothing, including no `grant.json` for the old key.
  - Two commands that add the same handle never replace each other's peer or delegations (`[profile-changed]`), and a command whose peer was revoked meanwhile fails (`[peer-revoked]`) instead of printing an artifact.
  - A `pending-A` or `awaiting-C` pairing that is more than 7 days old is forgotten.
  - Starting a pairing again over a pending one that expired is no longer refused.
  - `pair accept` of an artifact A that names an already paired peer is refused (`[usage]`, "Already paired with <peer>") before any delegation is created (a pairing that completes during `delegateTo` is refused with a warning naming the unsaved delegation and where to revoke it), and the pairing is left as it was.
  - `courier intake` uses the same lock: a lock it cannot prove dead is kept and its refusal is one line naming the lock file, the holder and the removal command (`rm -f -- <lock>`, or `Remove-Item -LiteralPath <lock> -Force` on Windows), to run only after confirming no Courier command is running.

  Details: TC-2384

- 60607b5: Courier now persists a private identity sidecar before writing key-bearing temp bytes. Recovery scrubs a temp only when its recorded identity and liveness prove the writer is gone; missing, malformed, or foreign host/PID-namespace metadata keeps the temp and reports platform-specific manual recovery guidance (`rm -f --` or PowerShell `Remove-Item -LiteralPath`). Only UUID-shaped `linux:`/`macos:` boot values are accepted; malformed boot metadata is never reboot evidence and makes a lock record unreadable or a sidecar unknown. Operators must confirm no Courier writer anywhere could still be writing the temp or sidecar before using that command. After a successful rename, Courier syncs the installed target before best-effort sidecar removal; orphan sidecars are handled conservatively.

  Details: TC-2464

- Updated dependencies [dc48089]
- Updated dependencies [75c0432]
- Updated dependencies [75c0432]
- Updated dependencies [cb0c6ce]
- Updated dependencies [cb0c6ce]
  - @tinycloud/node-sdk@3.11.0
  - @tinycloud/sdk-core@3.11.0

## 0.5.1-beta.5

### Patch Changes

- 60607b5: Courier now persists a private identity sidecar before writing key-bearing temp bytes. Recovery scrubs a temp only when its recorded identity and liveness prove the writer is gone; missing, malformed, or foreign host/PID-namespace metadata keeps the temp and reports platform-specific manual recovery guidance (`rm -f --` or PowerShell `Remove-Item -LiteralPath`). Only UUID-shaped `linux:`/`macos:` boot values are accepted; malformed boot metadata is never reboot evidence and makes a lock record unreadable or a sidecar unknown. Operators must confirm no Courier writer anywhere could still be writing the temp or sidecar before using that command. After a successful rename, Courier syncs the installed target before best-effort sidecar removal; orphan sidecars are handled conservatively.

  Details: TC-2464

## 0.5.1-beta.4

### Patch Changes

- 053f912: Courier no longer loses pairings, revocations or key rotations when two commands use the same profile. A command that holds a copy of `profile.json` for a long time (`init --wait`, `invite serve`) used to save that copy over whatever another command had written meanwhile.
  - `profile.json` is saved under a lock (`profile.json.lock`) that uses the intake lock: an `{pid, nonce}` owner record created whole, released only by its own nonce, broken only when its holder is established dead (on this machine and host, either a different true boot id (Linux boot_id, macOS kern.bootsessionuuid) or its pid is absent (on Linux, in the same pid namespace); a pid that exists is never judged dead, so a crashed holder whose pid was reused needs the manual recovery line). A stale lock is broken by one breaker at a time. A lock is never broken because it is old. If its holder is alive, is on another host or pid namespace, or the record cannot be read, the save waits 10 s and then refuses with `[profile-locked]` and one line naming the lock file, the holder and `rm -f -- <lock>` (PowerShell on Windows: `Remove-Item -LiteralPath <lock> -Force`) to clear it once no Courier command is running; the lock is left in place. The save re-reads the file and writes only what the command itself changed: a pairing made, a peer revoked or a renewal imported meanwhile is kept. Two renewals racing keep every outbound delegation and the longer inbound one, so a shorter artifact imported last no longer replaces a longer one.
  - A command that started before `init --rotate-key` finished is refused with `[profile-changed]` and writes nothing, including no `grant.json` for the old key.
  - Two commands that add the same handle never replace each other's peer or delegations (`[profile-changed]`), and a command whose peer was revoked meanwhile fails (`[peer-revoked]`) instead of printing an artifact.
  - A `pending-A` or `awaiting-C` pairing that is more than 7 days old is forgotten.
  - Starting a pairing again over a pending one that expired is no longer refused.
  - `pair accept` of an artifact A that names an already paired peer is refused (`[usage]`, "Already paired with <peer>") before any delegation is created (a pairing that completes during `delegateTo` is refused with a warning naming the unsaved delegation and where to revoke it), and the pairing is left as it was.
  - `courier intake` uses the same lock: a lock it cannot prove dead is kept and its refusal is one line naming the lock file, the holder and the removal command (`rm -f -- <lock>`, or `Remove-Item -LiteralPath <lock> -Force` on Windows), to run only after confirming no Courier command is running.

  Details: TC-2384

## 0.5.1-beta.3

### Patch Changes

- d93ac9b: `courier init` works out where it stands once, from the profile status, the saved grant, the agent key, a saved redeemed grant, the saved approval request and the key-rotation record, and every mode (`--request`, `--wait`, `--resume`, `--rotate-key`, `--grant-file`) recovers from that one result.
  - `init --resume` continues as `init --wait` when an approval from the owner is saved and no grant is waiting to be installed; with a grant waiting it installs the grant and keeps the approval for the next `init --wait`.
  - A saved approval whose profile or agent key is missing is refused, and no file is changed (before, `init --wait` and `init --request` started a new request over it).
  - A `grant.json` that is cut short or is not a grant counts as no saved grant and is reported once. A `profile.json` that cannot be read is reported as such and never treated as missing.
  - `init --rotate-key` replaces the agent key, the profile and the grant as one journaled step that the next `init` finishes if it is interrupted. The record is checked before it is replayed, and a stray temporary key file left by a killed process is overwritten with zeros and removed. It still discards a held approval with a warning; when the approval already held a granted result, or a redeemed grant for the old key was saved, it also says a live grant may exist, until when, and that the owner can revoke it at https://account.tinycloud.xyz/delegations.
  - A corrupt key file could print part of the private key in an error message; fixed. Courier now reports only the file name and that it is unreadable or corrupt for the state files it reads with its profile reader (`key.json`, `profile.json`, `grant.json`, `rotation.json`) and for `approval-pending.json`. Parse errors for input a person supplies, such as an invitation passed to `invite join`, are outside this change.
  - The saved approval request is read, written and classified in one module (`approval-phase`); the file format and the approval flow are unchanged.

  Details: TC-2383

- d93ac9b: Follow-up corrections to `courier init` state handling.
  - A corrupt or cut-short `approval-pending.json` is reported with a fixed reason. The JSON parser's message quoted the text around the failure, which could include `relayPrivateKey`.
  - A `grant.json` that has the shape of a grant but is not owner-only is a saved grant: `init` stops with `profile-permissions` and `chmod 600` advice and changes no file (before, it counted as no grant and a renewal could replace it). `init --rotate-key` still discards the grant, as before. A loose-mode `grant.json` that is corrupt or not a grant gets the corrupt-file warning instead, with no `chmod` advice.
  - `init --rotate-key`, with or without `--request`/`--wait`, refuses before writing anything when the saved approval cannot be read, naming the file and the `chmod` that fixes it. Before, a plain `--rotate-key` rotated the key and left that approval bound to the old one.
  - The rotation record's key is proven before replay: `kty` OKP, `crv` Ed25519, `x` and `d` as unpadded base64url text of exactly 32 bytes, `x` the public key of `d` (both in canonical base64url), and a `did:key` derived from `x` whose single optional `#fragment` names the same key. Any other record is refused and no file changes.
  - Stray key-bearing temporary files now include those of `approval-pending.json`. A file whose writing process is still running (`kill(pid, 0)` answers, or `EPERM`) is kept, not deleted, and reported by name. The process may be a live writer, whose key must not be zeroed between its fsync and its rename, or an unrelated process that was given the same pid after Courier died; Courier cannot tell which, so the file stays until that process is gone or the owner removes it.
  - The rotation record notes the installed grant's delegation CID and expiry (no secrets) before `grant.json` is removed. The rotation, and an `init` that finishes an interrupted one, then says the old grant is not revoked, may still be valid, and that the owner can revoke it at https://account.tinycloud.xyz/delegations. A saved approval that holds only a result reference is not a grant and gets no revocation page.
  - When `key.json` cannot be read, redeemed grants in `pending-grant.json` cannot be matched to the old key. The rotation keeps them and reports each with its CID and the revocation page. A later `init --resume` that finds a saved grant bound to a key the profile does not hold drops it, as it always has; the rotation's report is the record of it.
  - A temporary file holds key material of any of the three files: an agent key (the new one, or the one being rewritten) or an approval's relay key and encrypted result. Those of `approval-pending.json` are now scrubbed silently like the others.
  - The read-only readers added for this work (`pending-grant.json`, and `grant.json` for the loose-mode check and the rotation notice) never follow a symlink and never block on a FIFO; a `pending-grant.json` that is not a regular file of this user counts as no saved delegation. The `rm` command in the recovery line is shell-quoted. Stray temporary files are classified from one directory listing with one liveness check each.

  Details: TC-2383

## 0.5.1-beta.2

### Patch Changes

- Updated dependencies [dc48089]
  - @tinycloud/node-sdk@3.11.0-beta.2
  - @tinycloud/sdk-core@3.11.0-beta.2

## 0.5.1-beta.1

### Patch Changes

- Updated dependencies [cb0c6ce]
- Updated dependencies [cb0c6ce]
  - @tinycloud/node-sdk@3.11.0-beta.1
  - @tinycloud/sdk-core@3.11.0-beta.1

## 0.5.1-beta.0

### Patch Changes

- Updated dependencies [75c0432]
- Updated dependencies [75c0432]
  - @tinycloud/node-sdk@3.11.0-beta.0
  - @tinycloud/sdk-core@3.11.0-beta.0

## 0.5.0

### Minor Changes

- 1d688b3: Courier uses the same short-link approval flow as `tinycloud onboard`, so the owner has no code to copy back.
  - `courier init --request` creates an OpenKey approval request for the agent key (the `agents` space grant, 30 days), saves it in `$COURIER_HOME/approval-pending.json` (owner-only, fsynced) before printing, and prints the same JSON as before with `openkeyUrl` now a short `https://openkey.so/a/<id>#…` link. Asking again reuses the saved request while it is open and unchanged.
  - New `courier init --wait [--timeout <duration, at most 9m>]` polls OpenKey with a proof signed by the agent key, decrypts and checks the result (request id, digest, requester, target, owner, expiry, exact permissions), installs the grant, and only then acknowledges it. The default timeout is 60 s; at the deadline it exits 8 (not a failure: the approval is still pending) with `{"pending":{"step":1,"of":1,"approvalUrl":…,"expiresAt":…}}` on stdout, and the next run resumes the same request, with no second approval. A request that already holds an approval is never replaced by a run with other flags, a renewal approved by a different owner than the one holding the grant is refused (`--rotate-key` binds a new owner), and the granted lifetime may not exceed the requested one. The approved result is saved encrypted before any install work, so a process that is killed at any point resumes from disk. An expired request (`approval-expired`) or an approved result that passed OpenKey's 10-minute retention (`approval-result-expired`) installs nothing and says to run `init --request` again.
  - Courier's grant, profile and pending-request files are now written with fsync before anything acknowledges them.
  - `--grant-file`, `--paste` (old `XXXX-XXXX` codes) and plain `init` are unchanged.
  - `@tinycloud/share-envelope/links` exports the requester side of an approval request as a pure client: `approvalSessionProof`, `discoverApprovalResult`, `fetchApprovalResult`, `ackApprovalResult`, `collectApprovalResult`, `generateRelayKey`, `openRelayResult` and `checkApprovalResultBinding`.

  Details: TC-2300

- 0d968db: `courier pair renew <peer> --renew-artifact` emits a fresh C artifact for one already-paired peer without requiring the issuer's inbound delegation. The receiver can install it with `courier pair accept`; both sides preserve the established peer and exact mailbox scope, and the renewed delegation remains limited to seven days. Export is rate-limited to one renewal per peer per 20 hours unless the owner passes `--force`; no automatic renewal is added.

  Details: TC-712

### Patch Changes

- Updated dependencies [1d688b3]
- Updated dependencies [7f81a1d]
  - @tinycloud/share-envelope@1.5.0
  - @tinycloud/sdk-core@3.10.0
  - @tinycloud/node-sdk@3.10.0

## 0.5.0-beta.3

### Patch Changes

- @tinycloud/node-sdk@3.10.0-beta.3

## 0.5.0-beta.2

### Minor Changes

- 0d968db: `courier pair renew <peer> --renew-artifact` emits a fresh C artifact for one already-paired peer without requiring the issuer's inbound delegation. The receiver can install it with `courier pair accept`; both sides preserve the established peer and exact mailbox scope, and the renewed delegation remains limited to seven days. Export is rate-limited to one renewal per peer per 20 hours unless the owner passes `--force`; no automatic renewal is added.

  Details: TC-712

## 0.5.0-beta.1

### Patch Changes

- Updated dependencies [7f81a1d]
  - @tinycloud/sdk-core@3.10.0-beta.2
  - @tinycloud/node-sdk@3.10.0-beta.2

## 0.5.0-beta.0

### Minor Changes

- 1d688b3: Courier uses the same short-link approval flow as `tinycloud onboard`, so the owner has no code to copy back.
  - `courier init --request` creates an OpenKey approval request for the agent key (the `agents` space grant, 30 days), saves it in `$COURIER_HOME/approval-pending.json` (owner-only, fsynced) before printing, and prints the same JSON as before with `openkeyUrl` now a short `https://openkey.so/a/<id>#…` link. Asking again reuses the saved request while it is open and unchanged.
  - New `courier init --wait [--timeout <duration, at most 9m>]` polls OpenKey with a proof signed by the agent key, decrypts and checks the result (request id, digest, requester, target, owner, expiry, exact permissions), installs the grant, and only then acknowledges it. The default timeout is 60 s; at the deadline it exits 8 (not a failure: the approval is still pending) with `{"pending":{"step":1,"of":1,"approvalUrl":…,"expiresAt":…}}` on stdout, and the next run resumes the same request, with no second approval. A request that already holds an approval is never replaced by a run with other flags, a renewal approved by a different owner than the one holding the grant is refused (`--rotate-key` binds a new owner), and the granted lifetime may not exceed the requested one. The approved result is saved encrypted before any install work, so a process that is killed at any point resumes from disk. An expired request (`approval-expired`) or an approved result that passed OpenKey's 10-minute retention (`approval-result-expired`) installs nothing and says to run `init --request` again.
  - Courier's grant, profile and pending-request files are now written with fsync before anything acknowledges them.
  - `--grant-file`, `--paste` (old `XXXX-XXXX` codes) and plain `init` are unchanged.
  - `@tinycloud/share-envelope/links` exports the requester side of an approval request as a pure client: `approvalSessionProof`, `discoverApprovalResult`, `fetchApprovalResult`, `ackApprovalResult`, `collectApprovalResult`, `generateRelayKey`, `openRelayResult` and `checkApprovalResultBinding`.

  Details: TC-2300

### Patch Changes

- Updated dependencies [1d688b3]
  - @tinycloud/share-envelope@1.5.0-beta.0
  - @tinycloud/node-sdk@3.10.0-beta.1
  - @tinycloud/sdk-core@3.10.0-beta.1

## 0.4.2

### Patch Changes

- f7639ea: An OpenKey short code is consumed the moment it is redeemed, so a run that was killed after the redeem (an agent tool's two-minute limit hit this) lost the owner's approval and the retry could only say "Delegation code not found". The redeemed delegation is now saved first, to an owner-only `pending-grant.json` in the Courier home (`pending-delegation-code.json` in the CLI profile directory), fsynced and holding public fields only. Re-running with the same code, or `courier init --resume`, finishes from that copy with no second redeem and no second approval; the record is deleted only after the grant and profile are saved (the CLI: after its login or grant commit), and an expired or wrong-key record is never installed. `courier init --resume` also accepts a profile left `awaiting-grant` beside a saved grant. Courier covers `init` with a code, and the CLI covers `--paste` for `auth login`, `init`, `auth rotate`, `auth grant` and `onboard --code`. One limit remains: the first `tc auth login --paste` on a profile with no saved key keeps its new private key only in memory until the login commits, so a kill before the commit needs a fresh approval. Nothing changes when a run is not interrupted: every message and exit code is unchanged, and no flag is added.

  Details: TC-2301

- Updated dependencies [8d278fb]
- Updated dependencies [8d278fb]
  - @tinycloud/node-sdk@3.9.1
  - @tinycloud/sdk-core@3.9.1

## 0.4.2-beta.2

### Patch Changes

- f7639ea: An OpenKey short code is consumed the moment it is redeemed, so a run that was killed after the redeem (an agent tool's two-minute limit hit this) lost the owner's approval and the retry could only say "Delegation code not found". The redeemed delegation is now saved first, to an owner-only `pending-grant.json` in the Courier home (`pending-delegation-code.json` in the CLI profile directory), fsynced and holding public fields only. Re-running with the same code, or `courier init --resume`, finishes from that copy with no second redeem and no second approval; the record is deleted only after the grant and profile are saved (the CLI: after its login or grant commit), and an expired or wrong-key record is never installed. `courier init --resume` also accepts a profile left `awaiting-grant` beside a saved grant. Courier covers `init` with a code, and the CLI covers `--paste` for `auth login`, `init`, `auth rotate`, `auth grant` and `onboard --code`. One limit remains: the first `tc auth login --paste` on a profile with no saved key keeps its new private key only in memory until the login commits, so a kill before the commit needs a fresh approval. Nothing changes when a run is not interrupted: every message and exit code is unchanged, and no flag is added.

  Details: TC-2301

## 0.4.2-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.9.1-beta.1

## 0.4.2-beta.0

### Patch Changes

- Updated dependencies [8d278fb]
- Updated dependencies [8d278fb]
  - @tinycloud/node-sdk@3.9.1-beta.0
  - @tinycloud/sdk-core@3.9.1-beta.0

## 0.4.1

### Patch Changes

- a9bc978: The SDK can acquire a `tinycloud.email-held/v1` credential from the witness, for a caller that opts in per call. Nothing is enabled by default: the held profile stays disabled, and a call without `allowHeldProfile: true` is refused `PROFILE_UNAVAILABLE` before any request. `@tinycloud/node-sdk`: `acquireEmailProof`, `requestEmailProofCode` and `completeEmailProof` take `allowHeldProfile: true`; the holder is a canonical `did:pkh:eip155:1` (EIP-55) account with `EIP191`; the address is trimmed, refused if non-ASCII, lowercased and checked against the witness's rules (`ADDRESS_INVALID` before any request); the account binding the witness serves is checked against the SDK's own values before the wallet is asked to sign; the result is verified with the held verifier against the pinned issuer and cross-checked against the request. New public error code `CLIENT_CLOCK_SKEW` (not recoverable; default message "Your device clock is more than 5 minutes behind. Correct it and try again."): a device clock more than 5 minutes behind the witness is refused after the create call and before the code is mailed. `DESCRIPTOR_MISMATCH` and `UNSUPPORTED_VERSION` from the witness map to `PROFILE_UNAVAILABLE`. `EmailProofResult.verified` is now the ticket or the held verifier's result (`isTicketEmailProofResult` narrows it), and `EMAIL_PROOF_PINS` is exported from `@tinycloud/node-sdk/credentials`. `@tinycloud/sdk-core`: the credential descriptor and holder binding accept the held account shape next to the ticket shape (`AccountHolderBinding`, `TicketHolderBinding`, `ACCOUNT_HOLDER_BINDING_DOMAIN`). `@tinycloud/web-sdk`: `createAccountHolderSigner` signs only an exact held account binding for its own account and refuses any other bytes with `HOLDER_INVALID` before the wallet is called; `acquireHeldCredential` takes `allowHeldProfile`, checks that the issuer policy accepts the pinned issuer and reads the member's storage strictly before any request (a failed read is `OFFLINE`), and stores at `max(client time, credential iat)`. `@tinycloud/courier` stores ticket credentials only (a held result is refused there).

  Only the email-proof functions (and the held source that forwards their `allowHeldProfile: true`) reach the held profile. `OpenCredentialsHttpTransport` (constructor option) and `interpretCredentialFlow` (input) refuse an account-bound descriptor with `UNSUPPORTED_PROFILE`, before any request, unless called with `allowAccountSubject: true`. That is a public option of both; the SDK's own callers pass it only for the held profile, after the per-call opt-in was accepted. The `CredentialsService` operations (`acquire`, `ensure`, `verify`) refuse a held requirement or descriptor with `UNSUPPORTED_PROFILE` and `publishEmailShareV3` refuses it; `validateCredentialFlowDescriptor` stays shape-only. A held request that stopped after a failed wallet prompt (`SIGNATURE_REJECTED`, recoverable, the pending kept) or a failed notice (`ISSUER_UNAVAILABLE`) is retried with the same pending: the SDK reads the binding again and checks it, does not ask the wallet again after the signature was accepted, and mails no second code. On the retry the `jti` of the binding is format-checked only (contract addendum A3): a witness that serves a different `jti` is detected only when the credential disagrees with it, after the notice was sent. The file pending store persists a held request's non-secret `serverExpiresAt` (a ticket file is unchanged) and adds no other secret. `HELD_ACCOUNT_BINDING_PINS` (exported from `@tinycloud/node-sdk/credentials`) holds the static fields of the account binding; the create request, the binding checks and the web-sdk account signer all use it, and the signer refuses a binding with free text in any field. In `@tinycloud/web-sdk` the account signer copies its input once and decodes it strictly (a byte-order mark is refused); a cache miss without the opt-in is `PROFILE_UNAVAILABLE`. `email-publish-v3` refuses a descriptor that is not a ticket descriptor.

  Details: TC-2254

- Updated dependencies [614c1c2]
- Updated dependencies [614c1c2]
- Updated dependencies [614c1c2]
- Updated dependencies [9758dfd]
- Updated dependencies [a9bc978]
- Updated dependencies [5e47629]
- Updated dependencies [b0da170]
- Updated dependencies [f1744fb]
  - @tinycloud/node-sdk@3.9.0
  - @tinycloud/sdk-core@3.9.0
  - @tinycloud/share-envelope@1.4.1

## 0.4.1-beta.7

### Patch Changes

- Updated dependencies [b0da170]
  - @tinycloud/share-envelope@1.4.1-beta.1
  - @tinycloud/node-sdk@3.9.0-beta.8
  - @tinycloud/sdk-core@3.9.0-beta.8

## 0.4.1-beta.6

### Patch Changes

- @tinycloud/node-sdk@3.9.0-beta.6

## 0.4.1-beta.5

### Patch Changes

- Updated dependencies [9758dfd]
  - @tinycloud/sdk-core@3.9.0-beta.5
  - @tinycloud/node-sdk@3.9.0-beta.5

## 0.4.1-beta.4

### Patch Changes

- a9bc978: The SDK can acquire a `tinycloud.email-held/v1` credential from the witness, for a caller that opts in per call. Nothing is enabled by default: the held profile stays disabled, and a call without `allowHeldProfile: true` is refused `PROFILE_UNAVAILABLE` before any request. `@tinycloud/node-sdk`: `acquireEmailProof`, `requestEmailProofCode` and `completeEmailProof` take `allowHeldProfile: true`; the holder is a canonical `did:pkh:eip155:1` (EIP-55) account with `EIP191`; the address is trimmed, refused if non-ASCII, lowercased and checked against the witness's rules (`ADDRESS_INVALID` before any request); the account binding the witness serves is checked against the SDK's own values before the wallet is asked to sign; the result is verified with the held verifier against the pinned issuer and cross-checked against the request. New public error code `CLIENT_CLOCK_SKEW` (not recoverable; default message "Your device clock is more than 5 minutes behind. Correct it and try again."): a device clock more than 5 minutes behind the witness is refused after the create call and before the code is mailed. `DESCRIPTOR_MISMATCH` and `UNSUPPORTED_VERSION` from the witness map to `PROFILE_UNAVAILABLE`. `EmailProofResult.verified` is now the ticket or the held verifier's result (`isTicketEmailProofResult` narrows it), and `EMAIL_PROOF_PINS` is exported from `@tinycloud/node-sdk/credentials`. `@tinycloud/sdk-core`: the credential descriptor and holder binding accept the held account shape next to the ticket shape (`AccountHolderBinding`, `TicketHolderBinding`, `ACCOUNT_HOLDER_BINDING_DOMAIN`). `@tinycloud/web-sdk`: `createAccountHolderSigner` signs only an exact held account binding for its own account and refuses any other bytes with `HOLDER_INVALID` before the wallet is called; `acquireHeldCredential` takes `allowHeldProfile`, checks that the issuer policy accepts the pinned issuer and reads the member's storage strictly before any request (a failed read is `OFFLINE`), and stores at `max(client time, credential iat)`. `@tinycloud/courier` stores ticket credentials only (a held result is refused there).

  Only the email-proof functions (and the held source that forwards their `allowHeldProfile: true`) reach the held profile. `OpenCredentialsHttpTransport` (constructor option) and `interpretCredentialFlow` (input) refuse an account-bound descriptor with `UNSUPPORTED_PROFILE`, before any request, unless called with `allowAccountSubject: true`. That is a public option of both; the SDK's own callers pass it only for the held profile, after the per-call opt-in was accepted. The `CredentialsService` operations (`acquire`, `ensure`, `verify`) refuse a held requirement or descriptor with `UNSUPPORTED_PROFILE` and `publishEmailShareV3` refuses it; `validateCredentialFlowDescriptor` stays shape-only. A held request that stopped after a failed wallet prompt (`SIGNATURE_REJECTED`, recoverable, the pending kept) or a failed notice (`ISSUER_UNAVAILABLE`) is retried with the same pending: the SDK reads the binding again and checks it, does not ask the wallet again after the signature was accepted, and mails no second code. On the retry the `jti` of the binding is format-checked only (contract addendum A3): a witness that serves a different `jti` is detected only when the credential disagrees with it, after the notice was sent. The file pending store persists a held request's non-secret `serverExpiresAt` (a ticket file is unchanged) and adds no other secret. `HELD_ACCOUNT_BINDING_PINS` (exported from `@tinycloud/node-sdk/credentials`) holds the static fields of the account binding; the create request, the binding checks and the web-sdk account signer all use it, and the signer refuses a binding with free text in any field. In `@tinycloud/web-sdk` the account signer copies its input once and decodes it strictly (a byte-order mark is refused); a cache miss without the opt-in is `PROFILE_UNAVAILABLE`. `email-publish-v3` refuses a descriptor that is not a ticket descriptor.

  Details: TC-2254

- Updated dependencies [a9bc978]
  - @tinycloud/sdk-core@3.9.0-beta.4
  - @tinycloud/node-sdk@3.9.0-beta.4

## 0.4.1-beta.3

### Patch Changes

- Updated dependencies [614c1c2]
- Updated dependencies [614c1c2]
- Updated dependencies [614c1c2]
  - @tinycloud/node-sdk@3.9.0-beta.3
  - @tinycloud/sdk-core@3.9.0-beta.3

## 0.4.1-beta.2

### Patch Changes

- @tinycloud/node-sdk@3.8.1-beta.2
- @tinycloud/sdk-core@3.8.1-beta.2

## 0.4.1-beta.1

### Patch Changes

- Updated dependencies [5e47629]
  - @tinycloud/share-envelope@1.4.1-beta.0
  - @tinycloud/node-sdk@3.8.1-beta.1
  - @tinycloud/sdk-core@3.8.1-beta.1

## 0.4.1-beta.0

### Patch Changes

- Updated dependencies [f1744fb]
  - @tinycloud/node-sdk@3.8.1-beta.0

## 0.4.0

### Minor Changes

- c6b78b2: Courier pairing now accepts artifacts from a different Courier agent key of the same owner, so two agents sharing one `did:pkh` pair like any two agents. Pairing still refuses the agent's own courier DID, and the peer delegation binding is unchanged. Tested with an isolated same-owner A→B→C exchange plus self-pair, key-substitution and different-owner regression checks.

  Details: TC-1248

### Patch Changes

- 406ec01: Add a one-prompt guided start with persisted chat discovery, explicit selection, and signed invitation links. Support same-owner agents, anyone holding the link, and named Courier keys or verified paired handles through a participating issuer's scoped KV pairing relay. Bind joins and durable winning claims to the intended session; keep existing manual pairing guards and restrict guided peer grants to one thread. Email recipient identifiers are refused rather than treated as verified names.

  Explicitly supplied empty invitation links, including positional links, are refused before chat discovery or creation; they cannot create or activate a fallback session.

  Details: TC-1543

- Updated dependencies [15080ed]
- Updated dependencies [32ed899]
- Updated dependencies [49f3665]
- Updated dependencies [20a872e]
- Updated dependencies [479205d]
- Updated dependencies [19048ec]
- Updated dependencies [92e4bd0]
- Updated dependencies [e740a6d]
- Updated dependencies [c541786]
- Updated dependencies [e424ba9]
- Updated dependencies [812a818]
- Updated dependencies [7b22f61]
- Updated dependencies [4a19c47]
- Updated dependencies [5d9d314]
- Updated dependencies [44c439a]
- Updated dependencies [2789240]
- Updated dependencies [f167805]
- Updated dependencies [9fb359a]
- Updated dependencies [9fb359a]
- Updated dependencies [812a818]
  - @tinycloud/node-sdk@3.8.0
  - @tinycloud/sdk-core@3.8.0
  - @tinycloud/share-envelope@1.4.0

## 0.4.0-beta.23

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.23
- @tinycloud/sdk-core@3.8.0-beta.23

## 0.4.0-beta.22

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.22
- @tinycloud/sdk-core@3.8.0-beta.22

## 0.4.0-beta.21

### Patch Changes

- Updated dependencies [9fb359a]
- Updated dependencies [9fb359a]
  - @tinycloud/sdk-core@3.8.0-beta.21
  - @tinycloud/node-sdk@3.8.0-beta.21

## 0.4.0-beta.20

### Patch Changes

- Updated dependencies [e424ba9]
  - @tinycloud/node-sdk@3.8.0-beta.20
  - @tinycloud/sdk-core@3.8.0-beta.20

## 0.4.0-beta.19

### Patch Changes

- Updated dependencies [19048ec]
  - @tinycloud/share-envelope@1.4.0-beta.2
  - @tinycloud/node-sdk@3.8.0-beta.19
  - @tinycloud/sdk-core@3.8.0-beta.19

## 0.4.0-beta.18

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.18
- @tinycloud/sdk-core@3.8.0-beta.18

## 0.4.0-beta.17

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.17
- @tinycloud/sdk-core@3.8.0-beta.17

## 0.4.0-beta.16

### Patch Changes

- 406ec01: Add a one-prompt guided start with persisted chat discovery, explicit selection, and signed invitation links. Support same-owner agents, anyone holding the link, and named Courier keys or verified paired handles through a participating issuer's scoped KV pairing relay. Bind joins and durable winning claims to the intended session; keep existing manual pairing guards and restrict guided peer grants to one thread. Email recipient identifiers are refused rather than treated as verified names.

  Explicitly supplied empty invitation links, including positional links, are refused before chat discovery or creation; they cannot create or activate a fallback session.

  Details: TC-1543

## 0.4.0-beta.15

### Minor Changes

- c6b78b2: Courier pairing now accepts artifacts from a different Courier agent key of the same owner, so two agents sharing one `did:pkh` pair like any two agents. Pairing still refuses the agent's own courier DID, and the peer delegation binding is unchanged. Tested with an isolated same-owner A→B→C exchange plus self-pair, key-substitution and different-owner regression checks.

  Details: TC-1248

## 0.3.3-beta.14

### Patch Changes

- Updated dependencies [812a818]
- Updated dependencies [812a818]
  - @tinycloud/node-sdk@3.8.0-beta.16
  - @tinycloud/sdk-core@3.8.0-beta.16

## 0.3.3-beta.13

### Patch Changes

- Updated dependencies [f167805]
  - @tinycloud/sdk-core@3.8.0-beta.15
  - @tinycloud/node-sdk@3.8.0-beta.15

## 0.3.3-beta.12

### Patch Changes

- Updated dependencies [49f3665]
- Updated dependencies [e740a6d]
  - @tinycloud/sdk-core@3.8.0-beta.14
  - @tinycloud/node-sdk@3.8.0-beta.14

## 0.3.3-beta.11

### Patch Changes

- Updated dependencies [32ed899]
  - @tinycloud/node-sdk@3.8.0-beta.13

## 0.3.3-beta.10

### Patch Changes

- Updated dependencies [5d9d314]
  - @tinycloud/node-sdk@3.8.0-beta.11

## 0.3.3-beta.9

### Patch Changes

- Updated dependencies [20a872e]
  - @tinycloud/node-sdk@3.8.0-beta.10

## 0.3.3-beta.8

### Patch Changes

- Updated dependencies [92e4bd0]
  - @tinycloud/node-sdk@3.8.0-beta.9
  - @tinycloud/sdk-core@3.8.0-beta.9

## 0.3.3-beta.7

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.7

## 0.3.3-beta.6

### Patch Changes

- Updated dependencies [479205d]
  - @tinycloud/node-sdk@3.8.0-beta.6

## 0.3.3-beta.5

### Patch Changes

- Updated dependencies [44c439a]
  - @tinycloud/sdk-core@3.8.0-beta.5
  - @tinycloud/node-sdk@3.8.0-beta.5

## 0.3.3-beta.4

### Patch Changes

- Updated dependencies [c541786]
  - @tinycloud/sdk-core@3.8.0-beta.4
  - @tinycloud/node-sdk@3.8.0-beta.4

## 0.3.3-beta.3

### Patch Changes

- @tinycloud/sdk-core@3.8.0-beta.3
- @tinycloud/node-sdk@3.8.0-beta.3

## 0.3.3-beta.2

### Patch Changes

- Updated dependencies [4a19c47]
  - @tinycloud/sdk-core@3.8.0-beta.2
  - @tinycloud/node-sdk@3.8.0-beta.2

## 0.3.3-beta.1

### Patch Changes

- Updated dependencies [2789240]
  - @tinycloud/sdk-core@3.8.0-beta.1
  - @tinycloud/node-sdk@3.8.0-beta.1

## 0.3.3-beta.0

### Patch Changes

- Updated dependencies [15080ed]
  - @tinycloud/node-sdk@3.8.0-beta.0

## 0.3.2

### Patch Changes

- Updated dependencies [c142537]
- Updated dependencies [279c8e9]
- Updated dependencies [71fa087]
- Updated dependencies [147bb78]
  - @tinycloud/node-sdk@3.7.0
  - @tinycloud/sdk-core@3.7.0

## 0.3.2-beta.4

### Patch Changes

- Updated dependencies [c142537]
  - @tinycloud/node-sdk@3.7.0-beta.4
  - @tinycloud/sdk-core@3.7.0-beta.4

## 0.3.2-beta.3

### Patch Changes

- Updated dependencies [279c8e9]
  - @tinycloud/node-sdk@3.7.0-beta.3
  - @tinycloud/sdk-core@3.7.0-beta.3

## 0.3.2-beta.2

### Patch Changes

- Updated dependencies [147bb78]
  - @tinycloud/node-sdk@3.7.0-beta.2
  - @tinycloud/sdk-core@3.7.0-beta.2

## 0.3.2-beta.1

### Patch Changes

- Updated dependencies [71fa087]
  - @tinycloud/node-sdk@3.7.0-beta.1
  - @tinycloud/sdk-core@3.7.0-beta.1

## 0.3.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.6.2-beta.0

## 0.3.1

### Patch Changes

- 8acd73d: The courier test suite now runs every test file under a temporary home, and with `COURIER_TEST=1` the profile directory resolver refuses a home outside `COURIER_TEST_HOME` (`test-home-escape`). Without `COURIER_TEST=1` behaviour is unchanged.

  Details: TC-712

- Updated dependencies [271155a]
- Updated dependencies [09b7dc0]
  - @tinycloud/node-sdk@3.6.1
  - @tinycloud/sdk-core@3.6.1

## 0.3.1-beta.2

### Patch Changes

- 8acd73d: The courier test suite now runs every test file under a temporary home, and with `COURIER_TEST=1` the profile directory resolver refuses a home outside `COURIER_TEST_HOME` (`test-home-escape`). Without `COURIER_TEST=1` behaviour is unchanged.

  Details: TC-712

## 0.3.1-beta.1

### Patch Changes

- Updated dependencies [09b7dc0]
  - @tinycloud/node-sdk@3.6.1-beta.1

## 0.3.1-beta.0

### Patch Changes

- Updated dependencies [271155a]
  - @tinycloud/node-sdk@3.6.1-beta.0

## 0.3.0

### Minor Changes

- c0acb86: Adds `courier credential acquire --email <addr>` and `courier credential show --email <addr>`. `acquire` requests an email verification code. Run it again with `--code-stdin` and enter the code on stdin to store the verified credential under `COURIER_HOME/credentials/` (owner-only). `show` prints `email`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential itself.

  Details: TC-712

- 7bd4ae6: `@tinycloud/node-sdk/credentials` adds `verifyStoredEmailProof`, which re-verifies a stored email-proof credential offline: descriptor digest pin, envelope rebuild, pinned issuer keys, status check, and holder match. `@tinycloud/node-sdk/credential-pending-store` exports `ensureSecureDir` and `checkSecureDir`. The credentials directory must be a real directory with owner-only mode; a symlink or a file is refused, and a pre-existing directory with loose permissions is refused rather than chmodded. A pending request expires at the earlier of the witness expiry and 15 minutes after creation.

  `courier credential acquire` writes one JSON document to stdout per call (pretty printed, nothing else on stdout; hints go to stderr): `status: "code-sent"` with `codeExpiresAt` on the first call, then `status: "acquired"` with `issuedAt` and `expiresAt` on the second. The verification code must be entered within 5 minutes. `courier credential show` writes one JSON document with `address`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential. Stored credentials are re-verified offline on every read before any other rule applies; a record that fails is refused with `credential-record-invalid` and kept, and nothing is deleted on the strength of unverified stored fields. A credential that passed verification is dropped when less than 60 seconds of its own expiry remain or once older than the 3600-second maximum age. Courier refuses to run when both `HOME` and `COURIER_HOME` are unset. `courier --version` prints the package version.

  Details: TC-1757

### Patch Changes

- 7bd4ae6: `courier credential show` no longer deletes a stored credential that fails offline re-verification. The record is refused with `credential-record-invalid` and kept under `COURIER_HOME/credentials/` for inspection. Lifecycle drops are unchanged: a credential within 60 seconds of its own expiry, or older than the 3600-second maximum age, is still deleted.

  `@tinycloud/node-sdk/credentials` also exports the `StoredEmailProofInput` type.

  `@tinycloud/web-sdk/credentials` adds `verifyStoredEmailProof` and the `StoredEmailProofInput` and `StoredEmailProofRecord` types, so headless clients can re-verify a stored email-proof credential offline without importing `@tinycloud/node-sdk` directly.

  Details: TC-712

- Updated dependencies [e600a1a]
- Updated dependencies [0c09d7b]
- Updated dependencies [1f831e3]
- Updated dependencies [7bd4ae6]
- Updated dependencies [7bd4ae6]
- Updated dependencies [e32bc41]
- Updated dependencies [c0acb86]
  - @tinycloud/node-sdk@3.6.0
  - @tinycloud/sdk-core@3.6.0

## 0.3.0-beta.7

### Patch Changes

- Updated dependencies [1f831e3]
  - @tinycloud/sdk-core@3.6.0-beta.8
  - @tinycloud/node-sdk@3.6.0-beta.8

## 0.3.0-beta.6

### Minor Changes

- 7bd4ae6: `@tinycloud/node-sdk/credentials` adds `verifyStoredEmailProof`, which re-verifies a stored email-proof credential offline: descriptor digest pin, envelope rebuild, pinned issuer keys, status check, and holder match. `@tinycloud/node-sdk/credential-pending-store` exports `ensureSecureDir` and `checkSecureDir`. The credentials directory must be a real directory with owner-only mode; a symlink or a file is refused, and a pre-existing directory with loose permissions is refused rather than chmodded. A pending request expires at the earlier of the witness expiry and 15 minutes after creation.

  `courier credential acquire` writes one JSON document to stdout per call (pretty printed, nothing else on stdout; hints go to stderr): `status: "code-sent"` with `codeExpiresAt` on the first call, then `status: "acquired"` with `issuedAt` and `expiresAt` on the second. The verification code must be entered within 5 minutes. `courier credential show` writes one JSON document with `address`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential. Stored credentials are re-verified offline on every read before any other rule applies; a record that fails is refused with `credential-record-invalid` and kept, and nothing is deleted on the strength of unverified stored fields. A credential that passed verification is dropped when less than 60 seconds of its own expiry remain or once older than the 3600-second maximum age. Courier refuses to run when both `HOME` and `COURIER_HOME` are unset. `courier --version` prints the package version.

  Details: TC-1757

### Patch Changes

- 7bd4ae6: `courier credential show` no longer deletes a stored credential that fails offline re-verification. The record is refused with `credential-record-invalid` and kept under `COURIER_HOME/credentials/` for inspection. Lifecycle drops are unchanged: a credential within 60 seconds of its own expiry, or older than the 3600-second maximum age, is still deleted.

  `@tinycloud/node-sdk/credentials` also exports the `StoredEmailProofInput` type.

  `@tinycloud/web-sdk/credentials` adds `verifyStoredEmailProof` and the `StoredEmailProofInput` and `StoredEmailProofRecord` types, so headless clients can re-verify a stored email-proof credential offline without importing `@tinycloud/node-sdk` directly.

  Details: TC-712

- Updated dependencies [7bd4ae6]
- Updated dependencies [7bd4ae6]
  - @tinycloud/node-sdk@3.6.0-beta.7

## 0.3.0-beta.5

### Patch Changes

- Updated dependencies [e600a1a]
  - @tinycloud/node-sdk@3.6.0-beta.6

## 0.3.0-beta.4

### Minor Changes

- c0acb86: Adds `courier credential acquire --email <addr>` and `courier credential show --email <addr>`. `acquire` requests an email verification code. Run it again with `--code-stdin` and enter the code on stdin to store the verified credential under `COURIER_HOME/credentials/` (owner-only). `show` prints `email`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential itself.

  Details: TC-712

### Patch Changes

- Updated dependencies [c0acb86]
  - @tinycloud/node-sdk@3.6.0-beta.5

## 0.2.4-beta.3

### Patch Changes

- Updated dependencies [e32bc41]
  - @tinycloud/node-sdk@3.6.0-beta.4

## 0.2.4-beta.2

### Patch Changes

- @tinycloud/node-sdk@3.6.0-beta.3

## 0.2.4-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.6.0-beta.2

## 0.2.4-beta.0

### Patch Changes

- Updated dependencies [0c09d7b]
  - @tinycloud/node-sdk@3.6.0-beta.0

## 0.2.3

### Patch Changes

- Updated dependencies [d60f81d]
- Updated dependencies [7b92156]
- Updated dependencies [7b92156]
  - @tinycloud/node-sdk@3.5.0

## 0.2.3-beta.1

### Patch Changes

- Updated dependencies [7b92156]
- Updated dependencies [7b92156]
  - @tinycloud/node-sdk@3.5.0-beta.1

## 0.2.3-beta.0

### Patch Changes

- Updated dependencies [d60f81d]
  - @tinycloud/node-sdk@3.5.0-beta.0

## 0.2.2

### Patch Changes

- @tinycloud/node-sdk@3.4.0

## 0.2.2-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.3.2-beta.1

## 0.2.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.3.2-beta.0

## 0.2.1

### Patch Changes

- @tinycloud/node-sdk@3.3.1

## 0.2.1-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.3.1-beta.0

## 0.2.0

### Minor Changes

- f81a22c: `courier approval <requestId>`: verifies the owner's decision before a gated action. The approval in `me/approvals/` must name the request, carry the SHA-256 of the request's canonical JSON (`canonicalJson` and `requestHash` are exported), say `approved`, be under 24 hours old and inside the request's lifetime, and match your `--verb` and `--target`; it is consumed once (create-only marker under `me/consumed/`). `courier watch` now wakes the thread's agent as soon as a new approval appears; the wake prompt tells the agent to run `courier approval` first.

  `courier request` now requires `--verb` (merge, deploy, publish, spend, other), `--target` (canonical per verb) and `--summary` (one line, at most 200 characters); they are stored in the request and covered by its hash, so older free-text-only requests can no longer be approved. `--action` is optional display text.

  One text rule set applies when `courier request` writes, when `courier approval` reads and in the `/courier` view: a frozen Unicode 15.0.0 allow-list (Lu/Ll/Lt/Lo/Nd minus Default*Ignorable), NFC, ASCII punctuation only (summary `. , : ; - * / # ( ) ? !`and U+0027; free multiline text all printable ASCII punctuation plus LF), plain U+0020 space only, caps (target and summary 200, action/reason/risk 2000),`target`printable ASCII in its per-verb canonical shape; violations are refused, never repaired.`canonicalJson`/`requestHash`throw on non-finite numbers and nesting deeper than 64.`test/vectors/request-fields.json`and the exhaustive`text-verdicts.json`hold the shared contract;`src/text-ranges.ts` is the generated table. Previously accepted emoji, smart apostrophes and all remaining combining marks are now refused. Watcher shutdown permanently latches runner cancellation so adapter follow-on commands cannot start after SIGINT/SIGTERM.

- ecaf34b: Wake budget, pause and notifications for `courier watch`: at most `--wake-budget` (default 12) message wakes per side per thread per UTC day, then the thread pauses: a marker under `me/state/paused/`, an `inform` "thread paused" to the peer (never wakes it), and a notification to your human through `--notify none|osascript|exec` (queued in state; at most three notification attempts, every success/failure counts toward the 10/hour/peer and global caps). A paused thread still delivers and mirrors but never wakes; the peer's watcher notifies its human when it sees the inform. New `courier pause <peer> <thread>` and `courier resume <peer> <thread>` (the budget starts over). Approval wakes are never counted or blocked.

  Count wake attempts (including failures), cap and deduplicate fixed-text notices with bounded persisted retries, and retain a bounded backlog through pause/resume. Notifications use local logs, osascript or an operator exec command only; no notification starts or messages an agent.

  Track pause/resume transitions in fixed records for locally known threads, ignore notice ULIDs that are not newer than the stored one or are more than ten minutes ahead of the local clock, keep inform ids stable through retries, and persist separate message/approval backoff from attempt completion. Keep two fixed pending episode slots per known thread, with separate retries and a bounded count for additional pauses. Reserve up to three of the global hourly attempts per locally paired peer.

  In notify-only mode, coalesce messages and decisions into two fixed slots per locally paired peer, with separate retries, counts and latest thread ULIDs. Admit and dispatch eligible notifications in peer round-robin order while retaining deferred retry metadata and arrivals during dispatch.

- db4781a: `courier guard`: a Claude Code PreToolUse hook that refuses direct merge, deploy, publish, pushes, credential-access and human-only Courier commands. It inspects quoting, wrappers, chains, subshells and nested shells. Approved PR merges use the fixed-argv `courier run-approved <requestId>` broker, which consumes the approval before executing. `courier watch --wake claude` installs guard settings and gives the agent its Courier-only profile snapshot.

  The courier grant now includes `me/consumed/` (get, put, list; no del) and approvals are marked used there instead of under `me/state/`, so the courier key cannot un-consume an approval. Existing grants are refused with `grant-incomplete` until `courier init` renews them (one passkey approval). The used check reads from the network every time and fails closed on anything but a key-level 404.

  `courier watch --wake paseo` now installs the same guard in `<cwd>/.claude/settings.local.json` (merged with what is there), runs the hook once on a call no approval can unlock and requires a refusal, and wakes nothing otherwise. It only messages Paseo agents labelled `courier-guard=1` that run Claude in the guarded directory, deletes an agent Paseo started elsewhere, and drops `PASEO_AGENT_*`/`PASEO_WORKSPACE_ID` from its environment so `--cwd` is honoured. Non-Claude `--paseo-provider` values are refused. Named agent CLI commands, recognized package entrypoints and unknown MCP tools are refused.

  `courier watch --wake exec` installs no guard, so it now needs `--exec <cmd> --unguarded` (also with `--install-launchd|--install-systemd`); without the flag the watcher refuses, wakes nothing and names the flag. Every exec wake prints "this wake is not approval-guarded" to stderr and adds it to `COURIER_PROMPT`. `--unguarded` is refused with the `claude`, `paseo` and `none` adapters, which are always guarded or wake nobody. Use `claude` or `paseo` for guarded agent sessions.

  The guard's first rule is now fail-closed: a command with run-time expansion or indirection syntax (`{a,b}`, `$…`, backticks, `eval`, `source`, `alias`, here-strings, `xargs`, `find -exec`, `env`/`command`/`sudo` prefixes, `| sh`, …) that also names a gated tool or verb is refused ("expansion syntax with a gated tool name"); plain-word commands are read as before. README, `--help` and the skill document refused commands and the broker invocation.

  Woken `claude` and `exec` runs get an environment allowlist and a separate HOME. `--env-pass NAME` adds an explicitly selected variable. The Paseo adapter blanks known credential names and credential-looking watcher variables. Guard settings refuse Read access to credential files.

  `courier pause`, `courier resume` and `courier watch` (also as `tc courier …`) and `courier approval` without `--peek` are refused for a woken agent even with an approval, like `courier pair|revoke|init`: the wake budget is the reply loop's breaker, so an agent must not lift its own pause or start a watcher.

  Details: TC-1634

- f7e95e4: Add `courier intake`: reads the mirror of each paired peer's messages from your self-space KV and writes one JSON record per message into a queue directory for a local reader, with cheap text checks and flags. Peers default to 100 inbound messages per hour; `peers.json` can lower that per peer. An invalid `peers.json` entry refuses the whole file: startup stops, and a running reader keeps its last good map. Queue text is capped at 16 KiB. Each cycle reads at most 200 mirror messages per peer, from a cyclic cursor kept in the state file; messages more than 7 days old by message time are not fetched. Messages over the per-peer cap are kept in an overflow directory until they are 7 days old, capped at 200 files and 1 MiB per peer, oldest dropped first. One intake process runs per state directory: a live lock holder refuses a second start, a dead holder's lock is broken, and an unreadable lock refuses. To skip existing history, run `courier intake --init-from-now` before the first run.
- c0d4f70: `courier outbox add` publishes each item through a same-directory `.tmp-` file (fsynced, then hard-linked into place), so the sender never sees a partial `<itemId>.json`. Item files and ledger entries are mode 0600 (were 0644), and peer outbox directories are created setgid, mode 2750 (were 0755). `outbox add` writes canonical bytes (`canonicalJson(item)` plus a newline) and the sender accepts only those bytes.
- c0d4f70: The outbox sender (`courier outbox serve`) now refuses to send unless the item is approved and unchanged:
  - Each send is bound to an owner-only approval ledger at `<outbox>/approved/<itemId>` (mode 0600), created by `outbox add` before the item. A missing ledger is `refused:not-approved`. Its digest must match the item bytes read in the same open snapshot, or the reply is `refused:hash-mismatch`.
  - Items must be the exact canonical bytes written by `outbox add`: no leading whitespace or byte-order mark, no invalid UTF-8, no pretty-printing, duplicate keys, or missing trailing newline (`refused:bad-item`). Items must be owned by the sender uid and mode 0600 (`refused:unsafe-item`).
  - A request is one frame of at most 64 bytes, `{"v":1,"itemId":"<ULID>"}` followed by a newline, validated before JSON parsing. The frame ends at its first newline. Bytes after that newline that arrive before the request is served refuse with `refused:bad-request` and zero sends. A connection that sends bytes but no complete frame within 5 seconds gets `refused:bad-request`. A connection that sends nothing is closed without a reply. One frame per connection.
  - A reservation that was consumed but has no result is recorded as `uncertain` at startup (`<itemId>.result.json`, state `uncertain`) and is never resent. A later request for that item is refused `refused:uncertain`.
  - Replies and sender logs carry fixed codes only. They never include item ids, paths, text, or peer ids. Diagnostic logs are capped at 10 per 60 seconds.
  - Connections (64) and pending requests (32) are bounded separately from the send quota. Requests are capped at 60 per 60 seconds; excess and pending overflow are refused `refused:busy`. Connections over the cap are closed without a reply. The socket keeps its 5 second idle timeout.
  - Peer policy errors keep the last valid policy loaded in this process and log `outbox.peers-invalid` with a fixed code only. If no policy has loaded since start, the outbound cap is 1 per hour until a valid file loads.

- 38271aa: `courier watch --wake paseo|claude|exec`: wake adapters. `paseo` messages the agent labelled `courier-thread=<id>` or creates one (labels `courier-thread`, `courier-peer`, title `✉ <peer> · <subject>`); `claude` runs `claude -p`, keeps the session id per thread and resumes it; `exec` runs a command with `COURIER_THREAD`, `COURIER_PEER`, `COURIER_MESSAGES`. The wake prompt frames the message as a counterparty request, not an instruction from the owner. `--install-launchd` and `--install-systemd` generate and install a launchd agent or a `systemd --user` unit (`--dry-run` prints the exact file and commands). Woken claude runs may use only `Bash(courier:*)` unless `--claude-settings`/`--claude-allow` widen it.
- 35bfabc: Add `courier watch`: subscribes to each paired peer's `to/<me>/` and your `me/approvals/` through write hooks (25 s tickets), polls every 60 s as the fallback, mirrors new messages, peer `meta.json` and peer tasks into `me/mirror/`, advances receipts, and wakes per thread after a 30 s debounce (`inform` never wakes). State lives in `me/state/watch.json`. This release logs the wake (`--wake none`); wake adapters follow.

### Patch Changes

- dbdb20e: Classify conditional-write and read failures from structured error fields (`code`, `status`, `meta.status`) only, never from message text. Previously the storage key was matched against a 412 pattern, so a non-412 failure on a key containing the digits `412` could be reported as a write conflict and silently skipped. Missing-key detection and transient read retries use the same structured fields.

  Details: TC-1684

- 19ca88c: `courier watch` wake budget, pause and notifications, final behaviour: `--notify` accepts `none`, `osascript` and `exec`. Notifications for new messages and decisions are coalesced into two fixed slots per locally paired peer, with separate retries and counts, and pause notices use fixed per-thread episode slots. Eligible notifications are admitted and dispatched in peer round-robin order within the hourly caps, a retry never delays another peer's reserved share, and a message that arrives while a notice is being delivered keeps its own pending notice. Each known thread keeps two pause-notice slots; further pauses are counted in a bounded counter. A notice id that is not newer than the stored one, or is more than ten minutes ahead of the local clock, is ignored.

  Details: TC-1634

- 842c596: `courier intake` and `courier outbox serve` accept `--peers-owner <name|uid>` (or `COURIER_PEERS_OWNER`) to name the account that must own `peers.json`. A user name is looked up in `/etc/passwd` and must match exactly one uid; accounts that exist only in NSS need the numeric uid. Without the flag the default is the running user on POSIX systems; elsewhere startup refuses unless the flag is given. The mode, symlink, and regular-file checks are unchanged.

  Details: TC-1634

- c06c304: Courier profile permission errors use code profile-permissions; documentation wording updates.
- 0524256: Keep broker configuration outside Courier and resolve the owner's gh credential at runtime without copying it. Woken agents use a separate home and Courier-only identity snapshot. Existing broker token files are no longer used; owners configure the broker again after signing in with gh.

  Refuse protected-root traversal, gated executable aliases/copies, local network destinations and additional GitHub, registry and credential-access commands.

  Require registered executable identities for tool allowances, including Courier entrypoints and wrappers. Unregistered executables and package launchers fail closed. Protect registered tools from agent edits and preserve the installed census across automatic refreshes; owners refresh it after tool upgrades.

  Inspect interpreter script and preload files independently of their extension, and classify agent and gated-tool package entrypoints by their package manifest. Require the installed executable census and use its git identity for guard probes.

  Details: TC-1634

- 030fdf4: TC-712: refuse direct gated commands from woken agents and execute approved PR merges through a fixed-argv, single-use broker. Protect guard settings, dependencies and credential paths. Existing hook allow-once workflows must use `courier run-approved <requestId>` instead; publish, deploy and direct pushes require the owner.
- 2f3978c: Bind merge approval requests to a head commit and case-sensitive base branch (TC-712). Merge requests now require `--head-sha` and `--base`; older unpinned merge requests must be re-requested and approved again. Other verbs reject these fields. Approval verification returns both pins and can require exact matches for the broker.
- Updated dependencies [2aa917e]
- Updated dependencies [b6d0b9f]
- Updated dependencies [d2ad845]
- Updated dependencies [29440be]
- Updated dependencies [a553392]
- Updated dependencies [86815bd]
- Updated dependencies [e7f709d]
- Updated dependencies [94566db]
- Updated dependencies [38980b0]
- Updated dependencies [41e5fca]
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [87a137e]
- Updated dependencies [ef9653b]
- Updated dependencies [370a8e4]
- Updated dependencies [ef49c14]
- Updated dependencies [cce8b26]
- Updated dependencies [0c4c6b2]
- Updated dependencies [e99a127]
- Updated dependencies [f97d73d]
- Updated dependencies [18b6c9f]
- Updated dependencies [2292db7]
  - @tinycloud/node-sdk@3.3.0

## 0.2.0-beta.47

### Patch Changes

- Updated dependencies [ef49c14]
  - @tinycloud/node-sdk@3.3.0-beta.39

## 0.2.0-beta.46

### Patch Changes

- 842c596: `courier intake` and `courier outbox serve` accept `--peers-owner <name|uid>` (or `COURIER_PEERS_OWNER`) to name the account that must own `peers.json`. A user name is looked up in `/etc/passwd` and must match exactly one uid; accounts that exist only in NSS need the numeric uid. Without the flag the default is the running user on POSIX systems; elsewhere startup refuses unless the flag is given. The mode, symlink, and regular-file checks are unchanged.

  Details: TC-1634

## 0.2.0-beta.45

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.38

## 0.2.0-beta.44

### Minor Changes

- c0d4f70: `courier outbox add` publishes each item through a same-directory `.tmp-` file (fsynced, then hard-linked into place), so the sender never sees a partial `<itemId>.json`. Item files and ledger entries are mode 0600 (were 0644), and peer outbox directories are created setgid, mode 2750 (were 0755). `outbox add` writes canonical bytes (`canonicalJson(item)` plus a newline) and the sender accepts only those bytes.
- c0d4f70: The outbox sender (`courier outbox serve`) now refuses to send unless the item is approved and unchanged:
  - Each send is bound to an owner-only approval ledger at `<outbox>/approved/<itemId>` (mode 0600), created by `outbox add` before the item. A missing ledger is `refused:not-approved`. Its digest must match the item bytes read in the same open snapshot, or the reply is `refused:hash-mismatch`.
  - Items must be the exact canonical bytes written by `outbox add`: no leading whitespace or byte-order mark, no invalid UTF-8, no pretty-printing, duplicate keys, or missing trailing newline (`refused:bad-item`). Items must be owned by the sender uid and mode 0600 (`refused:unsafe-item`).
  - A request is one frame of at most 64 bytes, `{"v":1,"itemId":"<ULID>"}` followed by a newline, validated before JSON parsing. The frame ends at its first newline. Bytes after that newline that arrive before the request is served refuse with `refused:bad-request` and zero sends. A connection that sends bytes but no complete frame within 5 seconds gets `refused:bad-request`. A connection that sends nothing is closed without a reply. One frame per connection.
  - A reservation that was consumed but has no result is recorded as `uncertain` at startup (`<itemId>.result.json`, state `uncertain`) and is never resent. A later request for that item is refused `refused:uncertain`.
  - Replies and sender logs carry fixed codes only. They never include item ids, paths, text, or peer ids. Diagnostic logs are capped at 10 per 60 seconds.
  - Connections (64) and pending requests (32) are bounded separately from the send quota. Requests are capped at 60 per 60 seconds; excess and pending overflow are refused `refused:busy`. Connections over the cap are closed without a reply. The socket keeps its 5 second idle timeout.
  - Peer policy errors keep the last valid policy loaded in this process and log `outbox.peers-invalid` with a fixed code only. If no policy has loaded since start, the outbound cap is 1 per hour until a valid file loads.

## 0.2.0-beta.43

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.37

## 0.2.0-beta.42

### Minor Changes

- f7e95e4: Add `courier intake`: reads the mirror of each paired peer's messages from your self-space KV and writes one JSON record per message into a queue directory for a local reader, with cheap text checks and flags. Peers default to 100 inbound messages per hour; `peers.json` can lower that per peer. An invalid `peers.json` entry refuses the whole file: startup stops, and a running reader keeps its last good map. Queue text is capped at 16 KiB. Each cycle reads at most 200 mirror messages per peer, from a cyclic cursor kept in the state file; messages more than 7 days old by message time are not fetched. Messages over the per-peer cap are kept in an overflow directory until they are 7 days old, capped at 200 files and 1 MiB per peer, oldest dropped first. One intake process runs per state directory: a live lock holder refuses a second start, a dead holder's lock is broken, and an unreadable lock refuses. To skip existing history, run `courier intake --init-from-now` before the first run.

## 0.2.0-beta.41

### Patch Changes

- dbdb20e: Classify conditional-write and read failures from structured error fields (`code`, `status`, `meta.status`) only, never from message text. Previously the storage key was matched against a 412 pattern, so a non-412 failure on a key containing the digits `412` could be reported as a write conflict and silently skipped. Missing-key detection and transient read retries use the same structured fields.

  Details: TC-1684

## 0.2.0-beta.40

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.36

## 0.2.0-beta.39

### Patch Changes

- 19ca88c: `courier watch` wake budget, pause and notifications, final behaviour: `--notify` accepts `none`, `osascript` and `exec`. Notifications for new messages and decisions are coalesced into two fixed slots per locally paired peer, with separate retries and counts, and pause notices use fixed per-thread episode slots. Eligible notifications are admitted and dispatched in peer round-robin order within the hourly caps, a retry never delays another peer's reserved share, and a message that arrives while a notice is being delivered keeps its own pending notice. Each known thread keeps two pause-notice slots; further pauses are counted in a bounded counter. A notice id that is not newer than the stored one, or is more than ten minutes ahead of the local clock, is ignored.

  Details: TC-1634

## 0.2.0-beta.38

### Minor Changes

- ecaf34b: Wake budget, pause and notifications for `courier watch`: at most `--wake-budget` (default 12) message wakes per side per thread per UTC day, then the thread pauses: a marker under `me/state/paused/`, an `inform` "thread paused" to the peer (never wakes it), and a notification to your human through `--notify paseo|osascript|exec` (queued in state and retried). A paused thread still delivers and mirrors but never wakes; the peer's watcher notifies its human when it sees the inform. New `courier pause <peer> <thread>` and `courier resume <peer> <thread>` (the budget starts over). Approval wakes are never counted or blocked.

  Count wake attempts (including failures), cap and deduplicate fixed-text notices with bounded persisted retries, and retain a bounded backlog through pause/resume. Notifications use local logs, osascript or an operator exec command only; no notification starts or messages an agent.

- db4781a: `courier guard`: a Claude Code PreToolUse hook that refuses direct merge, deploy, publish, pushes, credential-access and human-only Courier commands. It inspects quoting, wrappers, chains, subshells and nested shells. Approved PR merges use the fixed-argv `courier run-approved <requestId>` broker, which consumes the approval before executing. `courier watch --wake claude` installs guard settings and gives the agent its Courier-only profile snapshot.

  The courier grant now includes `me/consumed/` (get, put, list; no del) and approvals are marked used there instead of under `me/state/`, so the courier key cannot un-consume an approval. Existing grants are refused with `grant-incomplete` until `courier init` renews them (one passkey approval). The used check reads from the network every time and fails closed on anything but a key-level 404.

  `courier watch --wake paseo` now installs the same guard in `<cwd>/.claude/settings.local.json` (merged with what is there), runs the hook once on a call no approval can unlock and requires a refusal, and wakes nothing otherwise. It only messages Paseo agents labelled `courier-guard=1` that run Claude in the guarded directory, deletes an agent Paseo started elsewhere, and drops `PASEO_AGENT_*`/`PASEO_WORKSPACE_ID` from its environment so `--cwd` is honoured. Non-Claude `--paseo-provider` values are refused. Named agent CLI commands, recognized package entrypoints and unknown MCP tools are refused.

  `courier watch --wake exec` installs no guard, so it now needs `--exec <cmd> --unguarded` (also with `--install-launchd|--install-systemd`); without the flag the watcher refuses, wakes nothing and names the flag. Every exec wake prints "this wake is not approval-guarded" to stderr and adds it to `COURIER_PROMPT`. `--unguarded` is refused with the `claude`, `paseo` and `none` adapters, which are always guarded or wake nobody. Use `claude` or `paseo` for guarded agent sessions.

  The guard's first rule is now fail-closed: a command with run-time expansion or indirection syntax (`{a,b}`, `$…`, backticks, `eval`, `source`, `alias`, here-strings, `xargs`, `find -exec`, `env`/`command`/`sudo` prefixes, `| sh`, …) that also names a gated tool or verb is refused ("expansion syntax with a gated tool name"); plain-word commands are read as before. README, `--help` and the skill document refused commands and the broker invocation.

  Woken `claude` and `exec` runs get an environment allowlist and a separate HOME. `--env-pass NAME` adds an explicitly selected variable. The Paseo adapter blanks known credential names and credential-looking watcher variables. Guard settings refuse Read access to credential files.

  `courier pause`, `courier resume` and `courier watch` (also as `tc courier …`) and `courier approval` without `--peek` are refused for a woken agent even with an approval, like `courier pair|revoke|init`: the wake budget is the reply loop's breaker, so an agent must not lift its own pause or start a watcher.

  Details: TC-1634

### Patch Changes

- 0524256: Keep broker configuration outside Courier and resolve the owner's gh credential at runtime without copying it. Woken agents use a separate home and Courier-only identity snapshot. Existing broker token files are no longer used; owners configure the broker again after signing in with gh.

  Refuse protected-root traversal, gated executable aliases/copies, local network destinations and additional GitHub, registry and credential-access commands.

  Require registered executable identities for tool allowances, including Courier entrypoints and wrappers. Unregistered executables and package launchers fail closed. Protect registered tools from agent edits and preserve the installed census across automatic refreshes; owners refresh it after tool upgrades.

  Inspect interpreter script and preload files independently of their extension, and classify agent and gated-tool package entrypoints by their package manifest. Require the installed executable census and use its git identity for guard probes.

  Details: TC-1634

- 030fdf4: TC-712: refuse direct gated commands from woken agents and execute approved PR merges through a fixed-argv, single-use broker. Protect guard settings, dependencies and credential paths. Existing hook allow-once workflows must use `courier run-approved <requestId>` instead; publish, deploy and direct pushes require the owner.

## 0.2.0-beta.37

### Patch Changes

- c06c304: Courier profile permission errors use code profile-permissions; documentation wording updates.

## 0.2.0-beta.36

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.35

## 0.2.0-beta.35

### Patch Changes

- 2f3978c: Bind merge approval requests to a head commit and case-sensitive base branch (TC-712). Merge requests now require `--head-sha` and `--base`; older unpinned merge requests must be re-requested and approved again. Other verbs reject these fields. Approval verification returns both pins and can require exact matches for the broker.

## 0.2.0-beta.34

### Minor Changes

- f81a22c: `courier approval <requestId>`: verifies the owner's decision before a gated action. The approval in `me/approvals/` must name the request, carry the SHA-256 of the request's canonical JSON (`canonicalJson` and `requestHash` are exported), say `approved`, be under 24 hours old and inside the request's lifetime, and match your `--verb` and `--target`; it is consumed once (create-only marker under `me/state/approvals-used/`). `courier watch` now wakes the thread's agent as soon as a new approval appears; the wake prompt tells the agent to run `courier approval` first.

  `courier request` now requires `--verb` (merge, deploy, publish, spend, other), `--target` (canonical per verb) and `--summary` (one line, at most 200 characters); they are stored in the request and covered by its hash, so older free-text-only requests can no longer be approved. `--action` is optional display text.

  One text rule set applies when `courier request` writes, when `courier approval` reads and in the `/courier` view: a frozen Unicode 15.0.0 allow-list (Lu/Ll/Lt/Lo/Nd minus Default*Ignorable), NFC, ASCII punctuation only (summary `. , : ; - * / # ( ) ? !`and U+0027; free multiline text all printable ASCII punctuation plus LF), plain U+0020 space only, caps (target and summary 200, action/reason/risk 2000),`target`printable ASCII in its per-verb canonical shape; violations are refused, never repaired.`canonicalJson`/`requestHash`throw on non-finite numbers and nesting deeper than 64.`test/vectors/request-fields.json`and the exhaustive`text-verdicts.json`hold the shared contract;`src/text-ranges.ts` is the generated table. Previously accepted emoji, smart apostrophes and all remaining combining marks are now refused. Watcher shutdown permanently latches runner cancellation so adapter follow-on commands cannot start after SIGINT/SIGTERM.

## 0.2.0-beta.33

### Patch Changes

- Updated dependencies [a553392]
  - @tinycloud/node-sdk@3.3.0-beta.34

## 0.2.0-beta.32

### Minor Changes

- 38271aa: `courier watch --wake paseo|claude|exec`: wake adapters. `paseo` messages the agent labelled `courier-thread=<id>` or creates one (labels `courier-thread`, `courier-peer`, title `✉ <peer> · <subject>`); `claude` runs `claude -p`, keeps the session id per thread and resumes it; `exec` runs a command with `COURIER_THREAD`, `COURIER_PEER`, `COURIER_MESSAGES`. The wake prompt frames the message as a counterparty request, not an instruction from the owner. `--install-launchd` and `--install-systemd` generate and install a launchd agent or a `systemd --user` unit (`--dry-run` prints the exact file and commands). Woken claude runs may use only `Bash(courier:*)` unless `--claude-settings`/`--claude-allow` widen it.

## 0.2.0-beta.31

### Minor Changes

- 35bfabc: Add `courier watch`: subscribes to each paired peer's `to/<me>/` and your `me/approvals/` through write hooks (25 s tickets), polls every 60 s as the fallback, mirrors new messages, peer `meta.json` and peer tasks into `me/mirror/`, advances receipts, and wakes per thread after a 30 s debounce (`inform` never wakes). State lives in `me/state/watch.json`. This release logs the wake (`--wake none`); wake adapters follow.

## 0.1.6-beta.30

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.33

## 0.1.6-beta.29

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.31

## 0.1.6-beta.28

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.30

## 0.1.6-beta.27

### Patch Changes

- Updated dependencies [e99a127]
  - @tinycloud/node-sdk@3.3.0-beta.29

## 0.1.6-beta.26

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.28

## 0.1.6-beta.25

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.27

## 0.1.6-beta.24

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.26

## 0.1.6-beta.23

### Patch Changes

- Updated dependencies [87a137e]
  - @tinycloud/node-sdk@3.3.0-beta.25

## 0.1.6-beta.22

### Patch Changes

- Updated dependencies [b6d0b9f]
  - @tinycloud/node-sdk@3.3.0-beta.24

## 0.1.6-beta.21

### Patch Changes

- Updated dependencies [d2ad845]
  - @tinycloud/node-sdk@3.3.0-beta.23

## 0.1.6-beta.20

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.22

## 0.1.6-beta.19

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.21

## 0.1.6-beta.18

### Patch Changes

- Updated dependencies [cce8b26]
  - @tinycloud/node-sdk@3.3.0-beta.20

## 0.1.6-beta.17

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.18

## 0.1.6-beta.16

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.17

## 0.1.6-beta.15

### Patch Changes

- Updated dependencies [18b6c9f]
  - @tinycloud/node-sdk@3.3.0-beta.16

## 0.1.6-beta.14

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.15

## 0.1.6-beta.13

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.14

## 0.1.6-beta.12

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.13

## 0.1.6-beta.11

### Patch Changes

- Updated dependencies [2292db7]
  - @tinycloud/node-sdk@3.3.0-beta.11

## 0.1.6-beta.10

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.10

## 0.1.6-beta.9

### Patch Changes

- Updated dependencies [ef9653b]
  - @tinycloud/node-sdk@3.3.0-beta.9

## 0.1.6-beta.8

### Patch Changes

- Updated dependencies [f97d73d]
  - @tinycloud/node-sdk@3.3.0-beta.8

## 0.1.6-beta.7

### Patch Changes

- Updated dependencies [29440be]
- Updated dependencies [86815bd]
- Updated dependencies [e7f709d]
- Updated dependencies [94566db]
- Updated dependencies [38980b0]
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [0c4c6b2]
  - @tinycloud/node-sdk@3.3.0-beta.7

## 0.1.6-beta.6

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.6

## 0.1.6-beta.5

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.5

## 0.1.6-beta.4

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.4

## 0.1.6-beta.3

### Patch Changes

- Updated dependencies [41e5fca]
  - @tinycloud/node-sdk@3.2.6-beta.3

## 0.1.6-beta.2

### Patch Changes

- Updated dependencies [370a8e4]
  - @tinycloud/node-sdk@3.2.6-beta.2

## 0.1.6-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.1

## 0.1.6-beta.0

### Patch Changes

- Updated dependencies [2aa917e]
  - @tinycloud/node-sdk@3.2.6-beta.0

## 0.1.5

### Patch Changes

- @tinycloud/node-sdk@3.2.5

## 0.1.5-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.5-beta.0

## 0.1.4

### Patch Changes

- 079afb6: Release a new beta built from its version commit. npm's 0.5.4-beta.1 (operations) and 0.1.4-beta.1 (courier) came from b6038b10, a run whose version commit never landed (TC-1095).
- 9704c99: The tc-cli and courier skills now find the CLI as `tinycloud` (`node_modules/.bin/tinycloud`, or `$(npm prefix --global)/bin/tinycloud`) and tell agents to run `tinycloud`, so relayed hints no longer reach iproute2's `/usr/sbin/tc`. Requires CLI 1.2.3 or later.
  - @tinycloud/node-sdk@3.2.4

## 0.1.4-beta.2

### Patch Changes

- 079afb6: Release a new beta built from its version commit. npm's 0.5.4-beta.1 (operations) and 0.1.4-beta.1 (courier) came from b6038b10, a run whose version commit never landed (TC-1095).

## 0.1.4-beta.1

### Patch Changes

- 9704c99: The tc-cli and courier skills now find the CLI as `tinycloud` (`node_modules/.bin/tinycloud`, or `$(npm prefix --global)/bin/tinycloud`) and tell agents to run `tinycloud`, so relayed hints no longer reach iproute2's `/usr/sbin/tc`. Requires CLI 1.2.3 or later.

## 0.1.4-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.4-beta.0

## 0.1.3

### Patch Changes

- 1a8a8a7: Skills resolve the CLI from the agents.tinycloud.xyz private install (`~/.local/share/tinycloud/cli`, or `TC_BIN`), falling back to a global npm install; tc-cli INSTALL.md points at agents.tinycloud.xyz for setup and skill installs.
- 021330d: Hints, examples and completion scripts name the command you ran: `tinycloud …` when invoked as `tinycloud`, `tc …` otherwise. `@tinycloud/operations` exports `CLI_NAME` from `@tinycloud/operations/cli-name` for this. Courier's missing-space hint names the TinyCloud CLI it runs inside (`tinycloud space host agents` under `tinycloud courier`), and `tc` when run as the standalone `courier` bin.
- Updated dependencies [c13720c]
  - @tinycloud/node-sdk@3.2.3

## 0.1.3-beta.2

### Patch Changes

- 1a8a8a7: Skills resolve the CLI from the agents.tinycloud.xyz private install (`~/.local/share/tinycloud/cli`, or `TC_BIN`), falling back to a global npm install; tc-cli INSTALL.md points at agents.tinycloud.xyz for setup and skill installs.

## 0.1.3-beta.1

### Patch Changes

- Updated dependencies [c13720c]
  - @tinycloud/node-sdk@3.2.3-beta.0

## 0.1.3-beta.0

### Patch Changes

- 021330d: Hints, examples and completion scripts name the command you ran: `tinycloud …` when invoked as `tinycloud`, `tc …` otherwise. `@tinycloud/operations` exports `CLI_NAME` from `@tinycloud/operations/cli-name` for this. Courier's missing-space hint names the TinyCloud CLI it runs inside (`tinycloud space host agents` under `tinycloud courier`), and `tc` when run as the standalone `courier` bin.

## 0.1.2

### Patch Changes

- @tinycloud/node-sdk@3.2.2

## 0.1.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.2-beta.0

## 0.1.1

### Patch Changes

- Updated dependencies [10359c5]
- Updated dependencies [eda1f78]
  - @tinycloud/node-sdk@3.2.1

## 0.1.1-beta.1

### Patch Changes

- Updated dependencies [10359c5]
  - @tinycloud/node-sdk@3.2.1-beta.1

## 0.1.1-beta.0

### Patch Changes

- Updated dependencies [eda1f78]
  - @tinycloud/node-sdk@3.2.1-beta.0

## 0.1.0

### Minor Changes

- d84cfed: New package `@tinycloud/courier` (first beta): Courier, agent-to-agent threads over TinyCloud, moved into this repo from TinyCloudLabs/courier. It ships the standalone `courier` bin, the library entry `main(argv, { prog })`, and the `courier` agent skill. The package has no `license` field yet (TC-861).

  `@tinycloud/cli` bundles Courier as `tc courier …`. It takes the same arguments as `courier`, keeps its own profile in `$COURIER_HOME` (default `~/.courier`) rather than a tc profile, and is loaded only when invoked. tc options before `courier` (for example `tc -p x courier …`) exit 2. The CLI tarball now ships the `courier` skill next to `tc-cli`; install both with `--skill tc-cli courier`.

  `courier init --paste` and `courier init --grant-file -` accept OpenKey `XXXX-XXXX` short codes (TC-823). The code is redeemed at `--openkey-api-host`, `COURIER_OPENKEY_API_HOST`, or by default `https://api.openkey.so` (for `https://openkey.so`, otherwise the OpenKey host). The redeemed delegation must be bound to the local Courier agent key.

### Patch Changes

- 05c4efa: Courier waits up to 2.5 minutes during init when OpenKey reports `spacePending: true` with `spaceReady: null`. It saves the grant and pending profile before waiting so interrupted or timed-out setup can resume without a new approval. Pending `init --resume` waits up to one minute and clears the marker when the space is ready. Responses without literal `spacePending: true` keep the existing single-probe behavior and manual hosting guidance. Authentication and network errors still propagate.

  The CLI bundles the updated Courier behavior and skill as `tc courier`. Both packages release on the existing beta channel. Release Courier before, or in the same window as, the TC-945 OpenKey API deployment.

- Updated dependencies [33efc8c]
- Updated dependencies [26f86bd]
- Updated dependencies [6a7fa64]
- Updated dependencies [4756923]
- Updated dependencies [4f851e6]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [47eb547]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [d825e49]
  - @tinycloud/node-sdk@3.2.0

## 0.1.0-beta.6

### Patch Changes

- Updated dependencies [d825e49]
  - @tinycloud/node-sdk@3.2.0-beta.9

## 0.1.0-beta.5

### Patch Changes

- 05c4efa: Courier waits up to 2.5 minutes during init when OpenKey reports `spacePending: true` with `spaceReady: null`. It saves the grant and pending profile before waiting so interrupted or timed-out setup can resume without a new approval. Pending `init --resume` waits up to one minute and clears the marker when the space is ready. Responses without literal `spacePending: true` keep the existing single-probe behavior and manual hosting guidance. Authentication and network errors still propagate.

  The CLI bundles the updated Courier behavior and skill as `tc courier`. Both packages release on the existing beta channel. Release Courier before, or in the same window as, the TC-945 OpenKey API deployment.

## 0.1.0-beta.4

### Patch Changes

- Updated dependencies [4756923]
  - @tinycloud/node-sdk@3.2.0-beta.8

## 0.1.0-beta.3

### Patch Changes

- Updated dependencies [26f86bd]
  - @tinycloud/node-sdk@3.2.0-beta.7

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies [33efc8c]
  - @tinycloud/node-sdk@3.2.0-beta.6

## 0.1.0-beta.1

### Patch Changes

- Updated dependencies [47eb547]
  - @tinycloud/node-sdk@3.2.0-beta.5

## 0.1.0-beta.0

### Minor Changes

- d84cfed: New package `@tinycloud/courier` (first beta): Courier, agent-to-agent threads over TinyCloud, moved into this repo from TinyCloudLabs/courier. It ships the standalone `courier` bin, the library entry `main(argv, { prog })`, and the `courier` agent skill. The package has no `license` field yet (TC-861).

  `@tinycloud/cli` bundles Courier as `tc courier …`. It takes the same arguments as `courier`, keeps its own profile in `$COURIER_HOME` (default `~/.courier`) rather than a tc profile, and is loaded only when invoked. tc options before `courier` (for example `tc -p x courier …`) exit 2. The CLI tarball now ships the `courier` skill next to `tc-cli`; install both with `--skill tc-cli courier`.

  `courier init --paste` and `courier init --grant-file -` accept OpenKey `XXXX-XXXX` short codes (TC-823). The code is redeemed at `--openkey-api-host`, `COURIER_OPENKEY_API_HOST`, or by default `https://api.openkey.so` (for `https://openkey.so`, otherwise the OpenKey host). The redeemed delegation must be bound to the local Courier agent key.
