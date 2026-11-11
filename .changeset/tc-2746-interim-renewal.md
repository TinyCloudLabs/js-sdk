---
"@tinycloud/courier": patch
---

Courier renews a paired peer's read access, up to 30 days at a time, while your own access is live, and asks for your approval in OpenKey before your access ends. To stop sharing, revoke the pairing. A renewal Courier already published can stay usable until Courier next runs, and never past its own end date (at most 30 days). Expired or revoked access requires a new pairing.

Details: TC-2746
