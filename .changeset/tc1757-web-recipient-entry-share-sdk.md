---
"@tinycloud/share-sdk": minor
---

Add the `@tinycloud/share-sdk/web-recipient` subpath. It exports `inspectShare`, `ShareRecipientClient`, and the `ShareMetadata` type, so browser bundles can import the recipient surface without the package root barrel. The root barrel's exports are unchanged.

Details: TC-1757
