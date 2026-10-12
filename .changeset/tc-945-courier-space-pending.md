---
"@tinycloud/courier": patch
"@tinycloud/cli": patch
---

Courier waits up to 2.5 minutes during init when OpenKey reports `spacePending: true` with `spaceReady: null`. It saves the grant and pending profile before waiting so interrupted or timed-out setup can resume without a new approval. Pending `init --resume` waits up to one minute and clears the marker when the space is ready. Responses without literal `spacePending: true` keep the existing single-probe behavior and manual hosting guidance. Authentication and network errors still propagate.

The CLI bundles the updated Courier behavior and skill as `tc courier`. Both packages release on the existing beta channel. Release Courier before, or in the same window as, the TC-945 OpenKey API deployment.
