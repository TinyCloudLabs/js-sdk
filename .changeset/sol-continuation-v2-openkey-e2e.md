---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
"@tinycloud/web-sdk": patch
"@tinycloud/sdk-core": patch
---

Sol continuation v2: add a production-shape narrowed-SIWE round-trip test
to `NodeUserAuthorization.signInWithOpenKey.e2e.test.ts` that exercises
the client's `signInWithOpenKeyResult` acceptance path against the exact
wire shape the OpenKey `/authorize-sign` route emits when a user narrows
capabilities in the widget. The test asserts:

- The narrowed `signedMessage` decodes to the expected reduced ability
  set (kv/put removed, kv/get + capabilities/read retained).
- The ReCap-derived statement in `signedMessage` no longer mentions the
  removed abilities.
- The signature verifies against `signedMessage`.
- Every canonical four-part `selectedActionKeys` entry resolves to a
  real (resource, ability) pair.
- Every `permissions` entry has non-empty actions and matches a resource
  in the signed ReCap.

This complements the matching OpenKey-side test in
`apps/api/src/__tests__/delegate-authorize-sign-nodeauth-e2e.test.ts`
which invokes the actual Hono router with the same production-shape
SIWE. Together the two tests cover the wire boundary from both sides
using real production code paths.
