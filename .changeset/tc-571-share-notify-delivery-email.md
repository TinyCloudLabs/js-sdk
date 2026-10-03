---
"@tinycloud/cli": patch
"@tinycloud/share-envelope": patch
"@tinycloud/share-sdk": patch
---

`tc share publish --to email:<address> --notify` now emails the invitation and exits 0 on tinycloud-node 1.17.2. Exact-email shares now sign their canonical recipient as the envelope's delivery address. Node 1.17.2 requires it before it authorizes an invitation (without it the node answers `403 delivery-authorization-invalid` and the CLI exits 9); 1.17.3 accepts it but no longer requires it. A mailbox the share envelope cannot carry as a delivery address (for example `a/b@example.com`) is published without one, as before, so on nodes before 1.17.3 it cannot be emailed. On those nodes, email shares published by earlier CLI versions cannot be emailed either; publish them again.

`@tinycloud/share-envelope` exports `isEnvelopeDeliveryEmail`, the rule envelopes apply to `deliveryEmail`. `prepareAddressedShare` in `@tinycloud/share-sdk` now refuses a `deliveryEmail` that rule rejects before any side effect, instead of failing after upload and policy registration.
