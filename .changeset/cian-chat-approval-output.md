---
"@tinycloud/cli": patch
---

Print signed OpenKey approval links on their own line in login, permission approval and onboarding output so chat clients can copy the complete URL and fragment. Document the existing short-link wait/resume path and the explicit longer `--paste` fallback. Approval authority, requested scope and expiry checks are unchanged.

Details: TC-2212
