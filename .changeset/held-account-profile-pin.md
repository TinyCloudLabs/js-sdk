---
"@tinycloud/node-sdk": minor
---

`EmailProofProfileId` now includes `"tinycloud.email-held/v1"`. The profile is not enabled yet: requests for it refuse with `PROFILE_UNAVAILABLE` before any network call. No behaviour changes for the existing profile.

Details: TC-1454
