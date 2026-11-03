---
"@tinycloud/courier": patch
---

Follow-up corrections to `courier init` state handling.

- A corrupt or cut-short `approval-pending.json` is reported with a fixed reason. The JSON parser's message quoted the text around the failure, which could include `relayPrivateKey`.
- A `grant.json` that has the shape of a grant but is not owner-only is a saved grant: `init` stops with `profile-permissions` and `chmod 600` advice and changes no file (before, it counted as no grant and a renewal could replace it). `init --rotate-key` still discards the grant, as before. A loose-mode `grant.json` that is corrupt or not a grant gets the corrupt-file warning instead, with no `chmod` advice.
- `init --rotate-key`, with or without `--request`/`--wait`, refuses before writing anything when the saved approval cannot be read, naming the file and the `chmod` that fixes it. Before, a plain `--rotate-key` rotated the key and left that approval bound to the old one.
- The rotation record's key must be a JWK object with its public and private parts as text; a parseable record with another shape is refused and no file changes.
- Stray key-bearing temporary files now include those of `approval-pending.json`. A file whose writing process is still running (`kill(pid, 0)` answers, or `EPERM`) is kept, not deleted, and reported by name. The process may be a live writer, whose key must not be zeroed between its fsync and its rename, or an unrelated process that was given the same pid after Courier died; Courier cannot tell which, so the file stays until that process is gone or the owner removes it.
- The rotation record notes the installed grant's delegation CID and expiry (no secrets) before `grant.json` is removed, so an `init` that finishes an interrupted rotation says the old grant is not revoked and may still be valid. That notice does not name the revocation page.
- When `key.json` cannot be read, redeemed grants saved in `pending-grant.json` cannot be matched to the old key: they are kept as they are, and the rotation reports each with its CID and the revocation page.

Details: TC-2383
