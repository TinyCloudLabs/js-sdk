---
"@tinycloud/cli": minor
---

`tinycloud auth login` gains `--request-expires <duration>`: how long the one-tap OpenKey approval link stays valid. The default stays 1 hour. A window over 1 hour needs `--owner did:pkh:eip155:CHAIN:ADDRESS`, so only that account's approval is accepted and another account's approval saves nothing. More than 12 hours is refused. `--paste`, `--device`, `--keys` and replication logins don't use this link and refuse the option.

Details: TC-3070
