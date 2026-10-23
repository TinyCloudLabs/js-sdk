---
"@tinycloud/courier": minor
---

Adds `courier credential acquire --email <addr>` and `courier credential show --email <addr>`. `acquire` requests an email verification code. Run it again with `--code-stdin` and enter the code on stdin to store the verified credential under `COURIER_HOME/credentials/` (owner-only). `show` prints `email`, `credentialId`, `issuedAt`, `expiresAt`, and `status`, never the credential itself.

Details: TC-712
