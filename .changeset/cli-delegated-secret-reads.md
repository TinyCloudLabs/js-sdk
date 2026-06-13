---
"@tinycloud/cli": minor
---

Add `tc secrets get <NAME> --delegation <file-or-imported-profile>` for reading a secret you were delegated access to. The `--delegation` source can be a delegation JSON file or the name of a profile that imported the delegation (resolved from `additional-delegations.json`). The read path validates that the delegation covers both the secret's `tinycloud.kv/get` path and the envelope's `tinycloud.encryption/decrypt` network, then activates the delegation in wallet mode via `node.useDelegation(...)` to fetch and decrypt the value. Adds a `smoke:delegated-secrets` script that exercises the full owner-delegate flow against a live node.
