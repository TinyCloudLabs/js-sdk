---
"@tinycloud/sdk-core": minor
"@tinycloud/sdk-services": minor
"@tinycloud/operations": minor
"@tinycloud/cli": minor
---

Manifest permissions can name one secret's own key (`urn:tinycloud:encryption:<owner>:default/secrets/<name>`) with `decrypt` or `key.create`. Any `secrets/` prefix is still refused. `tc secrets get` asks the owner to decrypt only that secret, and `tc secrets put` asks to create only its key. `--keys` refuses folders under `secrets/`.

A `secrets:` block in a manifest now asks for each secret's own key as well as the network decrypt, so secrets not yet migrated stay readable. The first CLI release after the per-secret flip drops the network decrypt from the block.

`tinycloud.secrets.get` plans a decrypt on the secret's own key; a session that holds only the network decrypt keeps reading with it. Two new errors: `SECRET_LEGACY_ENVELOPE` (the secret is still in the older format) and `SECRET_KEY_GRANT_REQUIRED` (the secret has its own key and the session reads only the older format). For an owner, `tc secrets get` asks for the missing decrypt instead.

`tc secrets migrate [NAME…] [--scope] [--dry-run]` and `migrateSecrets()` move secrets in the older format onto each secret's own key. A secret moves only after its new copy decrypts to the same bytes and only if nothing wrote it in between; anything else leaves the old copy. The output gives counts only.

Details: TC-3802
