---
"@tinycloud/cli": minor
---

`tc auth login` gains `--request-expires <duration>` for how long the one-tap OpenKey approval link stays valid. The default stays 1 hour. A window over 1 hour needs `--owner did:pkh:eip155:CHAIN:ADDRESS`, so only that account's approval is accepted and any other account's approval saves nothing; more than 12 hours is refused with or without `--owner`. The option is refused for `--paste`, `--device`, `--keys` and replication logins, which do not use this link.

Details: TC-3070
