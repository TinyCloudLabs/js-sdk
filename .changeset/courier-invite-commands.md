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
- The owner's approval and welcome step is not part of this release, so `join` does not complete a pairing yet.

Details: TC-712
