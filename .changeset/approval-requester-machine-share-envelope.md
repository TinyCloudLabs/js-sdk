---
"@tinycloud/share-envelope": minor
---

`@tinycloud/share-envelope/links` now has one state machine for the side that asks OpenKey for an approval (the CLI and Courier, which still use their own loops until they adopt it). Nothing that exists changes, and the package root is untouched.

- `reduce(state, event)` is pure: time and clock skew come in as event fields, and every step returns the effects to run (persist, purge keys, call, sleep, verify, commit, finish). `driveApproval` runs them with an injected clock, store and transport. An entry that is dropped always comes with a purge of the private keys it held, and nothing in an effect or outcome carries a key.
- One table (`RULES`, fed by `classifyReply`) says what each OpenKey answer means. A denied request (HTTP 410 `expired_request` with `status: "denied"`, or the code `request_denied`) ends in `denied`, is never reopened and has its entry and keys removed. A plain 410 `expired_request` is `lapsed`. A 400 `invalid_request` on discover is a refusal of the request and never an expiry. A 401 `invalid_proof` stays kept only until the signed expiry plus 30 s, and is exit 12 only when the local clock is more than 60 s off the reply's `Date` header (otherwise the entry is dropped: exit 5, or exit 3 after expiry). Nothing is kept forever: every entry has a purge time, and a run always ends by the signed expiry plus 30 s.
- The first status check of a run always gets the full request limit, so a slow answer is never reported as pending, and a first check that gets no answer is "unreachable", not "pending".
- `APPROVAL_EXIT` gives one exit number per outcome (0, 3, 5, 6, 7, 8, 11 denied, 12 clock). Exit 8 is returned only with the request's expiry and a live confirmation from this run.
- `parseApprovalFile` reads the one `approval-pending.json` (version 2) and the two files it replaces (the CLI's array and Courier's single object), keeps every entry (unreadable ones are set aside, not deleted), and `sweepApprovalFile` removes entries and their keys once they are past their purge time.

Not in this change: the CLI and Courier still print and exit as before, and `collectApprovalResult` and `refuse` are unchanged.

Details: TC-2377
