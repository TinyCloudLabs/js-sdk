---
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

`grantRuntimePermissions` (and `TinyCloudWeb.requestPermissions`) asks for one approval for a request across several spaces and returns one `PortableDelegation` per space. A requested space that isn't set up is never created: the call throws `MissingSpacesError` (`code: "SPACE_NOT_FOUND"`, `missingSpaceIds`, and `delegations` for the spaces that were granted). A space this account doesn't own throws before any approval (`code: "SPACE_NOT_OWNED"`). `MissingSpacesError` is exported from `@tinycloud/node-sdk`, `@tinycloud/node-sdk/core` and `@tinycloud/web-sdk`.

Details: TC-3338
