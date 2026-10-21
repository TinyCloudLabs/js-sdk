---
"@tinycloud/courier": minor
---

Add `courier invite <handle>`, `courier invite list`, `courier invite revoke <invite-id>`, `courier join <invite-string>` and `courier join --resume`.

- `invite` creates a one-time invite for a handle and email address and prints the invite string once. `invite list` shows metadata only. `invite revoke` deletes the sealed invite and any pending hello or welcome.
- With `--invites-public-dir <dir>` or `COURIER_INVITES_PUBLIC_DIR`, `invite` also writes a non-secret copy of the invite record (`<invite-id>.json`, mode 0640) and `invite revoke` updates its status. The copy holds no keys, tokens or blob ids.
- `join` reads the invite string from `--stdin` or `--file`; the positional form also works but is visible in `ps`. It sends a hello with an optional credential from `--credential-file` or `--credential-stdin`, and waits about 10 minutes for the owner's reply. `join --resume` continues a pending join without sending a second hello.
- Handles may not begin with `_`. Stored peers whose handle begins with `_` are excluded from notice tracking in `watch`.
- The words `list` and `revoke` cannot be invitee handles, because they select `invite` subcommands.
- Revoking an invite does not revoke delegations granted to its one-time key. Those end at their TTL.
- `watch` checks each incoming hello. A hello that fails a check, or whose pairing cannot finish, leaves the invite held and emits an `invite-held` notice. A held invite is not complete: `invite approve` or `invite deny` it. A failed write to the public copy does not change the pairing; the reason code is logged and the next sweep rewrites the public `status` and `completedPeer` from the private record.
- An invite left `consumed` by a crash is recovered on watch startup and on each sweep, once it is at least 10 minutes old. If its hello is still present and valid it is held with reason `internal-error` (one `invite-held` notice). If the hello is gone or invalid it is marked `failed` with reason `hello-lost` (one `invite-failed` notice) and closes at its expiry.
- `invite approve <invite-id> [--tier strict|trusted]` completes a held invite: it pairs the peer, writes one Welcome and marks the invite completed. `--tier trusted` records a trusted request; the peer starts as strict until you confirm trusted status. Retrying `approve` after a failure completes the same pairing without a second Welcome.
- `invite deny <invite-id>` rejects a held invite, writes a rejected Welcome and drops the pending peer.

Details: TC-712
