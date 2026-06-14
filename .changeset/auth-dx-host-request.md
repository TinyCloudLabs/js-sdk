---
"@tinycloud/node-sdk": minor
"@tinycloud/cli": minor
---

Auth/hosting developer experience for the delegate-asks-owner-to-host model.

- **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.

- **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched.

- **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.
