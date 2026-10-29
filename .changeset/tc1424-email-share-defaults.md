---
"@tinycloud/cli": patch
---

Default exact-email publication to the verified production OpenCredentials email descriptor, issuer DID and controller key, while retaining explicit overrides. Check exact share-key decrypt authority against verified session and active runtime capabilities instead of static manifest expansion, without loosening manifest validation. Missing authority now points to a same-profile, single OpenKey approval request rather than a paste relogin. Unknown share errors retain their actual class and a reviewed fixed local diagnostic; unreviewed details are redacted. Known HTTP/network error mappings are unchanged.

Details: TC-1424, TC-2202
