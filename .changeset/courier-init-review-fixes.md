---
"@tinycloud/courier": patch
---

Follow-up corrections to `courier init` state handling.

- A corrupt or cut-short `approval-pending.json` is reported with a fixed reason. The JSON parser's message quoted the text around the failure, which could include `relayPrivateKey`.
- A `grant.json` that has the shape of a grant but is not owner-only is a saved grant: `init` stops with `profile-permissions` and `chmod 600` advice and changes no file (before, it counted as no grant and a renewal could replace it). `init --rotate-key` still discards the grant, as before. A loose-mode `grant.json` that is corrupt or not a grant gets the corrupt-file warning instead, with no `chmod` advice.
- `init --rotate-key`, with or without `--request`/`--wait`, refuses before writing anything when the saved approval cannot be read, naming the file and the `chmod` that fixes it. Before, a plain `--rotate-key` rotated the key and left that approval bound to the old one.
- The rotation record's key is proven before replay: `kty` OKP, `crv` Ed25519, `x` and `d` as unpadded base64url text of exactly 32 bytes, `x` the public key of `d`, and a `did:key` (and its fragment, when present) derived from `x`. Any other record is refused and no file changes.
- Stray key-bearing temporary files now include those of `approval-pending.json`. A file whose writing process is still running (`kill(pid, 0)` answers, or `EPERM`) is kept, not deleted, and reported by name. The process may be a live writer, whose key must not be zeroed between its fsync and its rename, or an unrelated process that was given the same pid after Courier died; Courier cannot tell which, so the file stays until that process is gone or the owner removes it.
- The rotation record notes the installed grant's delegation CID and expiry (no secrets) before `grant.json` is removed. The rotation, and an `init` that finishes an interrupted one, then says the old grant is not revoked, may still be valid, and that the owner can revoke it at https://account.tinycloud.xyz/delegations. A saved approval that holds only a result reference is not a grant and gets no revocation page.
- When `key.json` cannot be read, redeemed grants in `pending-grant.json` cannot be matched to the old key. The rotation keeps them and reports each with its CID and the revocation page. A later `init --resume` that finds a saved grant bound to a key the profile does not hold drops it, as it always has; the rotation's report is the record of it.
- A temporary file holds key material of any of the three files: an agent key (the new one, or the one being rewritten) or an approval's relay key and encrypted result. Those of `approval-pending.json` are now scrubbed silently like the others.

Details: TC-2383
