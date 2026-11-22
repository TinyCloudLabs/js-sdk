---
"@tinycloud/cli": minor
"@tinycloud/courier": minor
---

OpenKey sign-in through an approval link asks the owner to let the grant renew itself.

- `tc auth login` asks for a 30-day renewal by default. `--renew <duration>` asks for another length (at most 365d, longer than `--expiry`) and `--no-renew` asks for none. `tc status` shows how long a renewing sign-in renews.
- `courier init --request` and `courier init --wait` ask for a 90-day renewal by default. `--renew <duration>` asks for another length and `--renew off` asks for none.
- The owner can approve with or without renewal. A saved request is resumed only by a run that asks for the same renewal.

Details: TC-3522
