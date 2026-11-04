---
"@tinycloud/sdk-core": minor
"@tinycloud/sdk-services": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/operations": patch
"@tinycloud/cli": patch
---
Route full-space reads and writes using verified owner-signed registry v2 memberships, with independent encryption-node transport and invocation audiences. Verify advertised node identities, preserve typed unreachable-node failures through secret operations and the CLI, and report incomplete multi-node writes explicitly. Read-only members may register their listed replicas without receiving ordinary writes.

Breaking: registry routing is now always v2-first and fail-closed. Explicit or saved hosts and local discovery are used only for genuine no-entry onboarding; v1-only registrations and registered resources without destinations do not fall back. The obsolete legacy-fallback policy is removed. Existing no-entry onboarding remains supported.

Register original mixed grants on the union of their listed data and encryption destinations. Stored-grant replay preserves node availability, identity and registry failures instead of converting them into missing authority or new approval requests; operations expose distinct routing error codes and retain partial registration outcomes.

Request-bound imports may follow a verified full-resource registry destination when the issuer's transport host differs from the saved request/profile hint. Request/profile/audience/signed-scope checks remain binding; genuine absence retains strict host matching, and registered encryption or inventory entries never imply data membership.

Details: TC-2481
