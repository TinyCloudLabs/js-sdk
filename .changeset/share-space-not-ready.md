---
"@tinycloud/cli": patch
---

`tc share` now names a failure by class instead of a bare `INVALID_ARGUMENT` "share operation failed". A share upload the node answers with `404 Space not found` fails with `SPACE_NOT_READY` (exit 4; a known node problem, retry after the node update).

Behaviour change for scripts: share failures that used to report `INVALID_ARGUMENT` (exit 2) now report a typed code and exit code:

| Signal | code | exit |
|---|---|---|
| upload 404 "Space not found" | `SPACE_NOT_READY` | 4 |
| HTTP 401 / unauthenticated | `AUTH_REQUIRED` | 3 |
| HTTP 403 / forbidden | `PERMISSION_DENIED` | 5 |
| HTTP 404 | `NOT_FOUND` | 4 |
| HTTP 5xx, 408, 429 | `NODE_UNAVAILABLE` | 7 |
| node unreachable (a `fetch failed` error, `ECONNREFUSED`, ...) | `NETWORK_ERROR` | 6 |
| HTTP 400, 422 | `INVALID_ARGUMENT` | 2 |
| other 4xx | `NODE_REJECTED` | 1 |

A `TypeError("fetch failed")` that used to be `INVALID_ARGUMENT` is now `NETWORK_ERROR`. The message carries the HTTP status and a plain upstream code, never response text; the original error is kept as `cause`. Errors with no status or network signal are unchanged.
