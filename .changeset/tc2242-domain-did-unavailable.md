---
"@tinycloud/cli": patch
---

Temporarily refuse domain and DID addressed share publication with UNAVAILABLE (exit 4), first in the share authority adapter, before authentication, profile or key access, or any request. Anyone (link) shares are unchanged, and email-addressed publication is refused as before. Sharing to an email address, domain or DID isn't available in this release; link shares are.

Details: TC-2242
