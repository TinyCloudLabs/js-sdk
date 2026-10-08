---
"@tinycloud/cli": patch
---

Write `kv`, `vault`, `vars`, and `secrets` get outputs through a shared private atomic writer. `auth logout` now removes the profile's local replicas by default, with `--keep-replicas` to retain them and a warning that node grants remain valid until expiry. Sync warns when it replicates secret ciphertext (related to TC-755).
