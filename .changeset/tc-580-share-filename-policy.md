---
"@tinycloud/share-sdk": patch
---

Share publication now NFC-normalizes filenames and refuses control, format, surrogate, and line/paragraph separator code points, matching the share viewer's filename policy. Invalid filenames are rejected before content is consumed or publication begins.
