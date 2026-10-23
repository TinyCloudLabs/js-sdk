---
"@tinycloud/web-sdk": minor
---

The panel's three reads (account, delegations, storage) now start in the background after sign-in or session restore, once the browser is idle and the account registry has synced. Opening the panel, or hovering or focusing the launcher, starts them immediately. Reads are not retried after a failure until the next sign-in, restore, or intent. Sign-out cancels a pending start.

Behavior change for integrators: a signed-in page now makes the panel's three reads without the panel being opened, starting after the browser is idle. Pages that must not make these reads before the user opens the panel will see them; there is no option to disable the prefetch.

The storage section reads from the prefetched cache. Opening it serves the cached snapshot without a new `storage.status` call, and the snapshot refreshes only when it is older than 60 s. Episode changes, approval, and retry force a network read. `PanelDataSource.storage` takes an optional `{ fresh?: boolean }` argument; this is additive, and callers that pass no argument behave as before.

The eager root grows by about 112 B gzip (`index.mjs` 1,479,876 → 1,479,988 B; `index.cjs` 1,407,586 → 1,407,689 B). The lazy panel chunk grows by about 107 B.
