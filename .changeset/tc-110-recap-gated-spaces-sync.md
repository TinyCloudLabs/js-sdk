---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
"@tinycloud/node-sdk": patch
"@tinycloud/sdk-services": patch
---

Stop emitting a doomed `tinycloud.space/list` invocation after manifest/recap
sign-in (TC-110).

`scheduleAccountRegistrySync()` unconditionally called
`account.spaces.syncAccessible()`, which invokes `tinycloud.space/list` — a
capability a manifest/recap session never holds — producing a benign but noisy
`401 Unauthorized Action: …/space/ tinycloud.space/list` on every sign-in
(visible in browser consoles).

The sync now skips `syncAccessible()` when the current session's recap does not
grant `tinycloud.space/list`, reusing the TC-111 `recapOperationsFromSession`
primitive. Only sessions without a SIWE recap (session-only /
restored-without-siwe) keep today's behavior — every wallet SIWE session in
this stack carries a recap, and none of them grant `space/list`, so all of
them skip.

Behavior note: `syncAccessible()` on this path could only ever register
capability-registry-derived **delegated** spaces (the owned-space listing 401
was already swallowed by `SpaceService.list`). That sign-in-time delegated
registration no longer happens; owned spaces are unaffected (bootstrap seeding
+ `spaces.register()`), and `account.spaces.list({ preferIndex: true })`
self-heals via its own `syncAccessible()` fallback.

Additionally, `withAccountRegistryRetry` no longer retries authorization
verdicts (`Unauthorized Action` / 401): those are deterministic, not transient,
so it warns once and stops instead of re-emitting the doomed request. Generic
errors still get the full retry budget.

Guard only — no registry-convergence writes and no sdk-core changes; the CLI
(`tc account spaces sync`) still uses `syncAccessible()` for explicit discovery.
