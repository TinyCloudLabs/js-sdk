---
"@tinycloud/cli": patch
---

`tc auth login --method openkey` creates the profile when it does not exist yet; the profile, its key and its session are saved only after the approval verifies. A login that is abandoned or refused leaves no profile behind.

Details: TC-2067
