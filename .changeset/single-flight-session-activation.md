---
"@tinycloud/sdk-core": patch
---

Coalesce concurrent identical session activations into a single `POST /delegate` (TC-332).

`activateSessionWithHost` had no de-duplication, so the ~17 call sites that replay a
byte-identical session delegation header — registry sync, space-hosting hooks and their
retry wrappers, several of which fire without awaiting each other — could issue the same
request concurrently. A parentless root session delegation acquires no chain guard locks on
the node, and PostgreSQL deployments have no `writer_lock` to serialize writes, so two
identical concurrent requests compute the same `epoch_hash`, both insert into `epoch`, and
the loser fails with a unique-constraint violation surfaced as HTTP 500.

Concurrent callers with the same host and header now share one in-flight request. Only
in-flight promises are shared, never completed results, so sequential calls still issue a
fresh request and a revoked session is never masked by a cached success. A caller that
joins a request which then fails at the network level gets its own second attempt rather
than inheriting a failure it did not cause.
