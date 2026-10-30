---
"@tinycloud/share-sdk": patch
---

The share recipient checks a V3 source's wrapped-key digest by source kind. A path-bound source (`encryptionKeyPath`) must register the digest of the raw wrapped-key bytes, as before; a legacy no-path source must register the canonical hash of the base64 key, which the node accepts for that case. Shares made by stable CLI 1.4.0 and the old share composer open again. The invoke body, facts and response checks are unchanged.

Details: TC-2242
