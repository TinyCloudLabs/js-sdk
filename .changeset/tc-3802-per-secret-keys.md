---
"@tinycloud/sdk-core": minor
"@tinycloud/cli": minor
---

Manifest permissions can name one secret's own key (`urn:tinycloud:encryption:<owner>:default/secrets/<name>`) with `decrypt` or `key.create`. Any `secrets/` prefix is still refused. `tc secrets get` asks the owner to decrypt only that secret, and `tc secrets put` asks to create only its key. `--keys` refuses folders under `secrets/`.

A `secrets:` block in a manifest now asks for each secret's own key as well as the network decrypt, so secrets not yet migrated stay readable. The first CLI release after the per-secret flip drops the network decrypt from the block.

Details: TC-3802
