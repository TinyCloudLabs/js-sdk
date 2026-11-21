---
"@tinycloud/cli": minor
---

`tinycloud share publish --to person@example.com` (or `--to email:person@example.com`) shares to one email address. Only the person who proves that address through the built-in OpenCredentials issuer can open the share, and you give no credential options. If the CLI can't reach that issuer, or the issuer doesn't match the one the CLI trusts, it stops with `UNAVAILABLE` (exit 4) and nothing is shared. To use another issuer, give `--credential-descriptor`, `--issuer-did` and `--issuer-kid` together. `--notify` emails the invitation to that address. If the sign-in can't decrypt, the CLI asks the owner to approve the share's own key first and publishes only after that. `--to did:` and `--to domain:` are refused with `UNAVAILABLE` (exit 4). Needs a TinyCloud node with named keys switched on.

Upgrading: `--to email:` stopped with `UNAVAILABLE` in earlier versions; it shares to that address.

Details: TC-3582
