---
"@tinycloud/cli": minor
---

`tinycloud onboard --with feed` now asks only for what the Feed needs: its two databases and their answer notifications, with no read-only `account` listing. The approval says so ("Set up TinyCloud on this computer: use your Feed, for 7 days."), and onboarding no longer waits for the account space. Any selection that includes the Feed (`--with feed` or `--with apps,feed`) lasts 7 days by default instead of 30; `--with apps,feed` keeps the read-only `account` listing, and `--with apps` is unchanged. A new `--expiry <number><m|h|d|w>` option sets the approval's lifetime for any selection, at most 30 days (the longest an OpenKey approval lasts); a longer or malformed value is refused before anything is created.

Details: TC-3293
