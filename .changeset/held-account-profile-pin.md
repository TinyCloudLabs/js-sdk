---
"@tinycloud/node-sdk": minor
---

`EmailProofProfileId` now includes `"tinycloud.email-held/v1"`. The profile is not enabled yet: requests for it refuse with `PROFILE_UNAVAILABLE` before any network call. The existing profile's requests are unchanged, but `acquireEmailProof` with a pending store now resumes a stored pending request only when it is of the requested profile; before, it resumed the newest live pending request for the address whatever its profile.

Details: TC-1454
