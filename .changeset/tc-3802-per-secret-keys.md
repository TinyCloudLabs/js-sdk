---
"@tinycloud/sdk-core": minor
"@tinycloud/sdk-services": minor
"@tinycloud/operations": minor
"@tinycloud/cli": minor
---

Manifest permissions can name one secret's own key (`urn:tinycloud:encryption:<owner>:default/secrets/<name>`) with `decrypt` or `key.create`. Any `secrets/` prefix is still refused. `tc secrets get` asks the owner to decrypt only that secret. `tc secrets put` asks to save and read that secret and to create and decrypt only its key, so saving and then reading it takes one approval. `--keys` refuses folders under `secrets/`.

A `secrets:` block in a manifest now asks for each secret's own key as well as the network decrypt, so secrets not yet migrated stay readable. The first CLI release after the per-secret flip drops the network decrypt from the block.

`tinycloud.secrets.get` plans a decrypt on the secret's own key; a session that holds only the network decrypt keeps reading with it. Two new errors: `SECRET_LEGACY_ENVELOPE` (the secret is still in the older format) and `SECRET_KEY_GRANT_REQUIRED` (the secret has its own key and the session reads only the older format). For an owner, `tc secrets get` asks for the missing decrypt instead.

`tinycloud.secrets.get` refuses a secret name or scope over 64 characters with `INPUT_INVALID`; it no longer reads one with the network decrypt. Names over 64 characters are unreachable through get and delete after this release; none exist on TinyCloud's production nodes, and a self-hosted owner can rename one with the previous CLI first.

`tc secrets migrate [NAME…] [--scope] [--dry-run]` and `migrateSecrets()` move secrets in the older format onto each secret's own key. A secret moves only after its new copy decrypts to the same bytes and only if nothing wrote it in between; anything else leaves the old copy. A name over 64 characters has no key of its own: it is counted as staying in the older format, and the others still move. The output gives counts only. The command asks the owner twice: once to read the older format, then for exactly the keys of the secrets being moved. `migrateSecrets()` takes an `authorizeKeys(keyPaths)` callback for that second step. A dry run asks only to list and read.

`tc secrets network grant` signs the grant with the owner's wallet, so `tc account delegations revoke <cid>` can end it. It lasts 1 hour unless `--expiry` asks for longer, at most 7 days (longer values are cut to 7 days), and its output gives the grant's `expiresAt`. A profile that signs in through OpenKey is refused with the steps for a wallet key (`TC_PRIVATE_KEY`, or `tc init --key-only` then `tc auth login --method local`).

`tc auth grant` can now approve an agent's request for one secret's own key. With a local key, the owner's wallet signs a one-use session that holds exactly the requested keys, cuts the grant from it (1 hour unless the request asks for longer, at most 7 days) and ends it; the stored session is unchanged. With an OpenKey owner, the request may carry decrypt on one exact `secrets/<name>` key; a `secrets/` prefix, the whole network and key creation are still refused.

Fixed: an agent's request for a secret named the owner in lowercase, which an owner could not sign; it now names the owner in checksummed form.

Fixed: approving a secret command from an OpenKey owner profile failed with "invalid approval request", because the request carried a local-only `skipPrefix` field. The approval request now leaves it out.

Details: TC-3802
