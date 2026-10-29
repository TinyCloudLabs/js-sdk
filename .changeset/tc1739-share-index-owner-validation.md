---
"@tinycloud/share-sdk": patch
---

Expose the existing owner record-schema context, schema checker and registration-time validator through `@tinycloud/share-sdk/share-index`. Admit canonical exact read-only artifact version files with their existing signed source checks. Retain original full-link renderer origin, signed header and signature beside one sealed body, and restore the original URL during readback with trusted-origin validation before owner admission. Existing three-field delivery material remains readable.

Details: TC-1739
