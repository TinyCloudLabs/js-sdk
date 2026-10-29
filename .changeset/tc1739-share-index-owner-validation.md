---
"@tinycloud/share-sdk": patch
---

Expose the existing owner record-schema context, schema checker and registration-time validator through `@tinycloud/share-sdk/share-index`. Admit canonical exact read-only artifact version files with their existing signed source checks. Retain original full-link renderer origin, signed header and signature beside one sealed body, and restore the original URL during readback with trusted-origin validation before owner admission. Existing three-field delivery material remains readable.

Metadata-bearing records require the updated reader; earlier strict readers reject the added `deliveryMaterial.fullLink` field. Upgrade every reader of the shared owner index before using the existing owner-agent `recheck` operation for affected agents: an older reader can cache schema rejections again or pause the agent. Updating the SDK alone does not clear those cached rejections.

`STORED_DELIVERY_MATERIAL_KEYS` now lists required keys rather than the exact allowed key set; external exact-key validators need to be updated for optional `fullLink` metadata.

Details: TC-1739
