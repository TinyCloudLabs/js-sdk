---
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-core": patch
---

fix(node-sdk,sdk-core): durably sync the account registry within signIn

Fresh accounts could sign in with their spaces created server-side yet see an
empty Overview/Spaces UI, because the account-spaces registry records
(`account/spaces/{id}`, which the account index reads) were written only as
fire-and-forget best-effort with silently swallowed failures. A floating
unawaited `index.ensure()` reached the account space before it was hosted,
404'd, and the failure was hidden.

`signIn()` now awaits `syncAccountRegistry()`: it proactively hosts the account
space before writing to it, awaits the index ensure + accessible-spaces sync
(keeping the existing 3-attempt retry), and surfaces a definitive failure as a
non-fatal `node.registryStatus` (`{ synced, reason }`) instead of throwing —
so an at-cap 402 on a registry write degrades to a status rather than locking
the user out of sign-in. The three previously silent registry-write catch
sites (owned-space hosting, the sync retry, and `SpaceService`'s create-path
`onSpaceRegistered` callback) now log/propagate instead of swallowing.
