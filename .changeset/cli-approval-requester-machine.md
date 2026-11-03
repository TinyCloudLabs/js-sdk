---
"@tinycloud/cli": minor
---

The CLI's OpenKey approval requests (`tc auth login`, `tc onboard`, `tc auth grant`, `tc auth rotate` and the agent grant commands) now run on the shared requester state machine of `@tinycloud/share-envelope/links`: one table says what each OpenKey answer means, the pending request is kept in one versioned file, and no private key outlives its use. The `--timeout` and `--wait` flags, the resume flow (re-running the command collects an approval already given) and every error code string are unchanged. The strings `APPROVAL_PENDING`, `APPROVAL_REQUEST_EXPIRED`, `APPROVAL_RESULT_EXPIRED`, `APPROVAL_REQUEST_NOT_FOUND`, `APPROVAL_RESULT_NOT_FOUND`, `APPROVAL_RESULT_ACKNOWLEDGED`, `APPROVAL_RESULT_INVALID`, `APPROVAL_REQUEST_UNAVAILABLE`, `APPROVAL_RESULT_UNAVAILABLE` and `APPROVAL_ACK_PENDING` keep their spelling; three are new: `APPROVAL_DENIED`, `APPROVAL_CLOCK` and `APPROVAL_STATE_UNREADABLE`. Exit 4 (a KV key was not found) keeps its meaning.

**BREAKING for scripts: the exit numbers of an approval change.** A script that treats exit 8 as "wait and run it again", or exit 5 as "retry", must be updated:

| exit | before | now, and what a script should do |
| --- | --- | --- |
| 8 | the approval is pending, and also: a result OpenKey already holds, an answer the CLI did not understand, a fetch or acknowledgement that failed | only while OpenKey confirmed the request live in this run (a new request, or a "still pending" answer); stdout carries `{"pending":{"step","of","approvalUrl","expiresAt"}}`. Send the link and run the same command again before `expiresAt`. `Next:` is the last line on stderr with this exit and only with it. |
| 3 | request expired, or its result expired | also an approved result OpenKey says was already collected (was 8) and a request or result the CLI dropped after its retention ended. The request is gone: start a new one. |
| 5 | OpenKey rejected the binding or the requester's proof | the same for a binding, and also for an `invalid_request` answer (a real fault in the request, never treated as an expiry; before, a 400 after the expiry was read as "expired" and before it was retried). The request is dropped. Do not retry; if the owner had approved, the grant may be live: revoke it in OpenKey. |
| 6 | (8) OpenKey could not be reached while waiting for an approval, or for an approved result | the request or the approved result stays saved. Retry the same command with backoff. |
| 7 | (8) OpenKey answered something the CLI does not map, five times in a row | the request stays saved. Retry later, or report it. |
| 11 | new | the owner declined the request in OpenKey. The request is dropped and nothing was granted: stop, and make a new request only if the owner wants one. |
| 12 | new | OpenKey rejected the requester's proof and this machine's clock is more than 45 seconds off OpenKey's, or the CLI's own check of the grant is clock-dependent. The request is kept: fix the clock, then run the same command again. When the grant is already saved (only the acknowledgement was refused) the message says so. |
| 13 | new | reserved for `tc share` (output file exists); nothing in this release exits 13 yet. |
| 0 | (8) an acknowledgement that could not be sent after the grant was saved | success with a warning on stderr; the same acknowledgement is sent the next time the command runs. |

Also changed:

- Without `--timeout`, a wait no longer lasts forever: it ends at the request's own expiry plus 30 seconds (one last check at that moment), as exit 7 (OpenKey still answers "pending" for a request that should be over) or exit 12 (the clocks disagree). A request nobody approved is removed, with its keys, at its expiry plus OpenKey's 10 minute retention (before: kept until the file was cleaned up).
- A request that OpenKey says is gone (404, expired, already collected), refused (400 binding or invalid request) or declined is removed from the pending file together with its keys, and a failed `auth rotate` or a refused result still removes the request that holds its staged key. Nothing that was approved is dropped for a network error, an unmapped answer or a failed acknowledgement.
- `approval-pending.json` is now version 2 (`{ "version": 2, "entries": [...], "unrecognized": [...] }`, mode 0600 in a 0700 directory, written atomically and durably under the profile lock). The first command that writes it migrates a version 1 file; no pending approval, staged key or acknowledged command entry is lost. An entry that cannot be read is moved to `unrecognized` (kept, then purged after 24 hours plus retention); a file that is not JSON is moved aside as `approval-pending.json.corrupt-<time>` (mode 0600, never quoted in a message); a file written by a newer tc is reported (`APPROVAL_STATE_UNREADABLE`, exit 1) and left untouched. `tc auth logout` removes the file, the quarantine, set-aside copies and a killed writer's temp file.
- **Downgrading is not supported.** CLI 1.6.x reads a version 2 file as "no saved approval", then fails on its first write with a JavaScript `TypeError` ("... is not iterable" or "... is not a function") and overwrites nothing; it can create one stray link at the links API first, which expires on its own. Upgrade to `@tinycloud/cli` 1.7.0 or later (the release with this change) to read the file again; to go back to 1.6.x, finish or discard the pending approval first.
- The proof and the three OpenKey calls come from `@tinycloud/share-envelope/links`; the CLI no longer has its own copy.

Details: TC-2377, TC-2378
