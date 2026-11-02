---
"@tinycloud/cli": patch
---

An approval request that expired before anyone approved it no longer leaves `onboard`, `auth grant` and `auth login` in an endless loop. Production OpenKey answers a status check for an expired request with HTTP 400 `invalid_request`, which the CLI reported as exit 8 `APPROVAL_REQUEST_UNAVAILABLE` while keeping the saved request, so "exit 8, run it again" never ended. Now that answer, received after the request's own expiry for a request that holds no result, is exit 3 `APPROVAL_REQUEST_EXPIRED` and the saved request is dropped, so the next run makes a new request with a new link. The same 400 before the request's expiry still ends as exit 8 `APPROVAL_REQUEST_UNAVAILABLE` and keeps the saved request, a saved request that already holds an approved result is never dropped, and every other behaviour is unchanged. If OpenKey cannot be reached at all, an expired request still waits as before.

Details: TC-2323
