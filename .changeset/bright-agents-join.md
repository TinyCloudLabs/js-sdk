---
"@tinycloud/bootstrap": minor
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
---

New canonical `agents` space; existing accounts run one bootstrap repair on next sign-in to add it. Bootstrap repair keeps existing account space records (renamed, archived, custom permissions) and only adds missing ones; new `AccountService.spaces.registerMissing()`. A sign-in that skips a non-account canonical space now repairs instead of re-seeding.
