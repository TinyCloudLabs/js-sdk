---
"@tinycloud/cli": minor
---

`tc auth login --device` asks for up to 30 days of renewal by default for ordinary scopes, with a 7-day initial session suggestion when `--expiry` is omitted. The owner can decline renewal. Use `--renew <duration>` for a different lease or `--no-renew` for finite access. Older OpenKey versions, unsupported nodes and unconfirmed lease admission leave the verified session finite. One-shot Share approvals and local-key sign-in still do not ask for renewal.

Renewal requires the node to confirm the exact original grant CID. If a concurrent profile change prevents saving an admitted renewal, the CLI identifies the lease by its public CID so the owner can stop it in OpenKey Settings.

Details: TC-3744
