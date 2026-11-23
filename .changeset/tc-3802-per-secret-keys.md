---
"@tinycloud/sdk-core": minor
"@tinycloud/sdk-services": minor
"@tinycloud/operations": minor
"@tinycloud/cli": minor
---

Manifest permissions can name one secret's own key (`urn:tinycloud:encryption:<owner>:default/secrets/<name>`) with `decrypt` or `key.create`. Any `secrets/` prefix is still refused, and so is a key path of more than 64 segments. `--keys` refuses folders under `secrets/`.

A `secrets:` block in a manifest asks for the network decrypt and for each secret's own key, so secrets not yet migrated stay readable.

`tc secrets migrate [NAME…] [--scope] [--dry-run]` and `migrateSecrets()` (from `@tinycloud/sdk-services/secrets/migrate`, not the package root) move secrets in the older format onto each secret's own key. A secret moves only after its new copy decrypts to the same bytes and only if nothing wrote it in between; anything else leaves the old copy. A name over 64 characters has no key of its own: it is counted as staying in the older format, and the others still move. The output gives counts only. The command asks the owner twice: once to read the older format, then for exactly the keys of the secrets being moved. `migrateSecrets()` takes an `authorizeKeys(keyPaths)` callback for that second step. A dry run asks only to list and read.

`tinycloud.secrets.get` reports `SECRET_LEGACY_ENVELOPE` for a secret still in the older format, with the network decrypt to approve.

With `TC_SECRETS_NAMED_KEY_WRITES=1`, `tc secrets put` asks to save and read that secret and to create and decrypt only its own key, so saving and then reading it takes one approval. Without it, `put` keeps saving in the older format.

`tc secrets network grant` signs the grant with the owner's wallet, so `tc account delegations revoke <cid>` can end it. It lasts 1 hour unless `--expiry` asks for longer, at most 7 days (longer values are cut to 7 days), and its output gives the grant's `expiresAt`. A profile that signs in through OpenKey is refused with the steps for a wallet key (`TC_PRIVATE_KEY`, or `tc init --key-only` then `tc auth login --method local`).

`tc auth grant` can now approve an agent's request for one secret's own key. With a local key, the owner's wallet signs a one-use session that holds exactly the requested keys, cuts the grant from it (1 hour unless the request asks for longer, at most 7 days) and ends it; the stored session is unchanged. With an OpenKey owner, the request may carry decrypt on one exact `secrets/<name>` key; a `secrets/` prefix, the whole network and key creation are still refused.

`tc secrets list` shows a secret whose name or scope is over 64 characters with a note that this version can't read or delete it and which CLI version can (`unreadable` in the JSON output); nothing is hidden. `migrateSecrets()` refuses a vault that cannot move secrets before asking for any key.

TinyChat's bot-history key and data live under a reserved scope. `tc secrets list`, `delete`, `put`, `migrate`, `request` and `manage` refuse that scope, in any spelling that canonicalises to it, before they sign in or ask; `migrateSecrets()` neither counts nor reseals anything under it; and the `tinycloud.secrets.get` and `tinycloud.secrets.status` operations and Secret Manager links refuse it.

Fixed: approving a secret command from an OpenKey owner profile failed with "invalid approval request", because the request carried a local-only `skipPrefix` field. The approval request now leaves it out.

Details: TC-3802
