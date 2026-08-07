---
"@tinycloud/web-sdk": patch
---

Restore the most recently persisted TinyCloud account for `share.receive(..., { identity: "auto" })` before falling back to an accountless receiver key.
