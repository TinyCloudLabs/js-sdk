---
"@tinycloud/sdk-core": minor
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
"@tinycloud/sdk-services": minor
---

`ensureOwnedSpaceHosted` now consults the account spaces registry before hosting

Previously `TinyCloudNode.ensureOwnedSpaceHosted(name)` always delegated to
`hostOwnedSpace`, which unconditionally submits the host-SIWE delegation. Owners
who already had the space hosted (e.g. a git-haiku owner re-running TinyCloud
Secrets setup) were therefore prompted to "host" their `secrets` space on every
run.

`ensureOwnedSpaceHosted` now resolves the owned space id and first checks the
account spaces registry: the fast SQLite index (`account.index.spaces.list()`)
as a best-effort short-circuit, falling back to the canonical, recap-readable KV
record `account/spaces/{space_id}` (`account.spaces.get`). If the space is
already registered/hosted it returns the id WITHOUT submitting a host delegation
(no redundant signature). Only when the space is absent — or the registry check
fails in any way (e.g. a cold index reporting `no such table: spaces`) — does it
fall through to `hostOwnedSpace`. After hosting it durably write-through
registers the space so subsequent calls short-circuit on the registry.

`hostOwnedSpace` (always-host) is unchanged for callers that explicitly want it.
The KV path is used rather than `syncAccessible()` because a manifest/recap
session can read `account/spaces/` under the recap but does not hold
`tinycloud.space/list`.
