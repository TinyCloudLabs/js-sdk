---
"@tinycloud/cli": minor
"@tinycloud/courier": minor
"@tinycloud/node-sdk": minor
---

OpenKey sign-in through an approval link asks the owner to let the grant renew itself.

- `tc auth login` asks for a 30-day renewal by default. A sign-in that asks for any encryption permission (decrypt included) or for the secrets space asks for no renewal unless `--renew` names one. `--renew <duration>` asks for another length (at most 365d, longer than `--expiry`) and `--no-renew` asks for none. `tc status` shows when a renewing sign-in stops renewing.
- `courier init --request` and `courier init --wait` ask for a 90-day renewal by default. `--renew <duration>` asks for another length and `--renew off` asks for none.
- The owner can approve with or without renewal. A saved request is resumed only by a run that asks for the same renewal.
- A renewing Courier grant keeps its peers' access going past the grant's signed end, up to the end the node has renewed it to.
- `TinyCloudNode.sessionEnd` gives when the session's authority ends. After `restoreSessionWithRenewal` it is the renewed end the node reported, and `delegateTo` can delegate up to it.

Details: TC-3522
