---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/sdk-services": patch
---

TC-111 follow-up: primary-grant selection now returns the caller's scoped
session so multi-space recaps mint resources against the correct target space.

TC-111 registers the primary session's own recap as a synthetic
`provenance: "primary"` runtime grant that wins invocation selection when it
covers the requested op. The two invocation call sites then used
`grant.session` — the stored primary `ServiceSession`, whose `spaceId` is the
PRIMARY space. For scoped ops on OTHER spaces that a multi-space recap also
covers (e.g. an account-registry write whose fallback session targets the
`account` space), the invocation was minted against the primary space
(`applications/kv/...` instead of `account/kv/...`) and the node rejected it
(observed as 404/40x in prod).

`selectInvocationSession` and `invokeAnyWithRuntimePermissions` now invoke with
the caller's passed/fallback session — which shares the primary delegation but
carries the correct target `spaceId` — whenever the winning grant is the
primary one. Non-primary grants keep using `grant.session`. Ranking semantics in
`findGrantForOperations` are unchanged. This fixes wrong-space invocations for
account/secrets ops that were minted against the primary space.
