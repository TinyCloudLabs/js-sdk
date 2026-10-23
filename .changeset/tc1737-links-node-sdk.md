---
"@tinycloud/node-sdk": minor
"@tinycloud/sdk-core": minor
---

`authorizeShareDeliveryV3` sends the strict short-link body of `POST /policy/v3/deliveries/authorize` and checks the node's delivery admission v1.

- The request body is exactly `{shareUrl, recipientEmail, documentName, jti, expiresAt, requestBodyDigest}`. `requestBodyDigest` is the base64url SHA-256 of the JCS of the body without it.
- `shareUrl` must be a short share link (`/s/<id>#v=4&k=…&c=…`). Any other link throws `share delivery requires a short share link` before a request is made.
- The `sealedEnvelope`, `envelopeKey` and `shareCid` inputs are removed. `envelope` stays an input: it checks the admission locally and is not sent.
- The admission has the schema `xyz.tinycloud.policy/delivery-admission/v1` and the signing domain `xyz.tinycloud.policy/delivery-admission/v1\0`; `returnLink` is the submitted short link and `envelopeRef` is its `c`. A v0 admission is refused.
- An HTTP error from the node carries the node's reply with the share link and its key replaced, so neither reaches a log or a thrown message.
- `@tinycloud/sdk-core` exports `shortDeliveryLinkBodyCid` and `withoutShareLink`, and loads `@tinycloud/share-envelope/links` with `import()` when it first needs it.

Do not release before the node release that serves the new body.

Details: TC-1737
