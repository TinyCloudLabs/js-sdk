---
"@tinycloud/share-sdk": minor
---

Addressed publish, receive, credential invitations, the sender index and `validateShareLink` use the `#v=4` link grammar of `@tinycloud/share-envelope/links`.

- `publishAddressedShare` returns the full `v=4` link (`/s/full#v=4&k=…&r=…`), its header signed by the key that signs the envelope. `AddressedSharePublishOptions.apiOrigin` (default `https://api.tinycloud.xyz`) is the header's audience. A sealed envelope over `MAX_LINK_BODY_BYTES` fails with a `LinkError` (`body_over_cap`) and returns no link.
- `inspectShare` and `receiveShare` resolve short and full links through `resolveLink`. `ShareFetchOptions` gains `apiOrigin` and `fetch`; `expectedOrigin` is the trusted viewer origin (default: the link's own origin).
- `deliverCredentialInvitation` accepts only the short share link (lowercase id, at most 512 bytes).
- `notifyShare` ends without a retry when the adapter throws an error with the code `delivery-authorization-invalid` (the node's refusal of a delivery authorization): the result is `partial-failure` with `attempts: 1` and `retryable: false`, as for HTTP 401 and 403.
- `validateShareLink` returns the shape `"link"` for both `v=4` forms.
- The share index keeps a short `v=4` link beside a record's delivery material and checks that it is the link of that material (`assertLinkBoundToMaterial`). A full link is not stored in an index record. `expandShareRecord(record)` takes no origin.
- `inspectShare`, `receiveShare`, `publishAddressedShare` and `deliverCredentialInvitation` load `@tinycloud/share-envelope/links` with `import()` when they first need it. The package build keeps it a package import, so a bundle that embeds `@tinycloud/share-sdk` holds no links code.

Removed:

- The `"inline"` link shape and the inline `#v=2&p=` reader and writer calls.
- `shareLinkForRecord` and the `shareOrigin` option of `AgentShareRecordStore`.

Do not release before the deploy window for the links API, witness, node, Share web and CLI.

Details: TC-1737
