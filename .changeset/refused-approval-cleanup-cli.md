---
"@tinycloud/cli": patch
---

When the CLI refuses an approval OpenKey already granted (a wrong owner, a scope that does not match, a grant broader or narrower than asked, a bad proof, a signed lifetime above `--expiry`), the delegation is live even though nothing was saved, and the CLI cannot revoke it itself (a login's approval carries no revoke ability). The CLI now says so once, on stderr: the delegation's CID, until when OpenKey granted it, whether its key was deleted or still exists on this device (the delegation's CID is printed only when it looks like a CID), and where to revoke it (https://account.tinycloud.xyz/delegations). It also stops keeping what would let the refused result be used or served again:

- `tc auth login`, `tc init`, `tc onboard`, `tc auth rotate`, `tc auth request --grant`, `tc auth login --device` and the agent grant commands drop the saved copy of a pasted short code and the pending approval request (its result key and reference) of a refused result.
- The profile's key is deleted only when this command created it: a profile it created (which is removed again, with the previous default profile restored) or a key that exists only in memory or in the refused pending request. A key that already existed, which other grants or sessions may use, is kept.
- `tc auth rotate` no longer touches `key.json` or the session until the approval is verified: the new key waits in memory (`--paste`) or in the pending approval request's file (mode 0600, the default flow) and is written with the new session only then. A refused rotation leaves the old key and the old login exactly as they were, and any failure after the approval arrived drops the pending request that holds the new key; before, the old session was cleared and the new key written first.
- A pasted short code that OpenKey no longer has (already used, expired or refused) now says to approve again in OpenKey, instead of telling you to re-run the same command with the same code.

A refusal that only means the approval cannot be saved yet (an expired approval, a lifetime that only looks too long because this computer's clock is behind OpenKey's, a session in use, a profile changed or locked meanwhile, a replica logout) keeps the saved approval so the same command can finish it, and prints no notice. A successful login or rotation is unchanged.

Details: TC-2363
