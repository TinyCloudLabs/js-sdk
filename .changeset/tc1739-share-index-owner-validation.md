---
"@tinycloud/share-sdk": patch
---

Expose the existing owner record-schema context, schema checker and registration-time validator through `@tinycloud/share-sdk/share-index`. Admit canonical exact read-only artifact version files with their existing signed source checks. Retain original full-link renderer origin, signed header and signature beside one sealed body, and restore the original URL during readback with trusted-origin validation before owner admission. Existing three-field delivery material remains readable.

Metadata-bearing records require the updated reader; earlier strict readers reject the added `deliveryMaterial.fullLink` field. After updating, use the existing owner-agent `recheck` operation for affected agents to clear cached schema rejections before reconciliation. Updating the SDK alone does not clear those cached rejections.

Details: TC-1739
