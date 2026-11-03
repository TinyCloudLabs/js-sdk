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

Details: TC-2481
