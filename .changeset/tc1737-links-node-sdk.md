---
"@tinycloud/node-sdk": minor
"@tinycloud/sdk-core": minor
---

`authorizeShareDeliveryV3` sends the strict short-link body of `POST /policy/v3/deliveries/authorize` and checks the node's delivery admission v1.

- The request body is exactly `{shareUrl, recipientEmail, documentName, jti, expiresAt, requestBodyDigest}`. `expiresAt` is `new Date(expiresAt).toISOString()` (`YYYY-MM-DDTHH:mm:ss.SSSZ`, UTC), whatever form the caller passes. `requestBodyDigest` is the base64url SHA-256 of the JCS of the body without it.
- `shareUrl` must be a short share link (`/s/<id>#v=4&k=…&c=…`) on one of `trustedOrigins` (new optional input; default `https://share.tinycloud.xyz`, the `DEFAULT_SHARE_ORIGINS` of `@tinycloud/share-envelope/links`) with a lowercase id. Any other link throws `share delivery requires a short share link` before a request is made.
- The `sealedEnvelope`, `envelopeKey` and `shareCid` inputs are removed. `envelope` stays an input: it checks the admission locally and is not sent.
- The admission has the schema `xyz.tinycloud.policy/delivery-admission/v1` and the signing domain `xyz.tinycloud.policy/delivery-admission/v1\0`; `returnLink` is the submitted short link and `envelopeRef` is its `c`. A v0 admission is refused. `verifyShareDeliveryAuthorizationV3Bytes` (async) verifies a delivery admission with the strict Ed25519 rule of the links contract (`S < L`, canonical and prime-order `A` and `R`) and a canonical base64url signature, through `assertDidKeySignature` of `@tinycloud/share-envelope/links`.
- HTTP 400 and HTTP 422 from the node are one refusal: a `ShareDeliveryRefusedError` (code `delivery-authorization-invalid`, status 400, message `share delivery authorization refused`) that carries nothing of the reply. Any other HTTP error carries the node's reply with the share link and its key replaced, so neither reaches a log or a thrown message.
- HTTP 429 is not the refusal: it keeps its status and is retried by `notifyShare` like any other server answer.
- `@tinycloud/sdk-core` exports `ShareDeliveryRefusedError`, `shortDeliveryLinkBodyCid`, `verifyShareDeliveryAuthorizationV3Bytes` and `withoutShareLink`, and loads `@tinycloud/share-envelope/links` with `import()` when it first needs it.
- `@tinycloud/sdk-core` no longer exports `validateShareDeliveryAuthorizationV3Bytes`.

Do not release before the node release that serves the new body.

Details: TC-1737
