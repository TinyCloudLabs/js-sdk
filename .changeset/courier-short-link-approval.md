---
"@tinycloud/courier": minor
"@tinycloud/share-envelope": minor
---

Courier uses the same short-link approval flow as `tinycloud onboard`, so the owner has no code to copy back.

- `courier init --request` creates an OpenKey approval request for the agent key (the `agents` space grant, 30 days), saves it in `$COURIER_HOME/approval-pending.json` (owner-only, fsynced) before printing, and prints the same JSON as before with `openkeyUrl` now a short `https://openkey.so/a/<id>#…` link. Asking again reuses the saved request while it is open and unchanged.
- New `courier init --wait [--timeout <duration, at most 9m>]` polls OpenKey with a proof signed by the agent key, decrypts and checks the result (request id, digest, requester, target, owner, expiry, exact permissions), installs the grant, and only then acknowledges it. The default timeout is 90 s; at the deadline it exits 8 (not a failure: the approval is still pending) with `{"pending":{"step":1,"of":1,"approvalUrl":…,"expiresAt":…}}` on stdout, and the next run resumes the same request, with no second approval. A request that already holds an approval is never replaced by a run with other flags, a renewal approved by a different owner than the one holding the grant is refused (`--rotate-key` binds a new owner), and the granted lifetime may not exceed the requested one. The approved result is saved encrypted before any install work, so a process that is killed at any point resumes from disk. An expired request (`approval-expired`) or an approved result that passed OpenKey's 10-minute retention (`approval-result-expired`) installs nothing and says to run `init --request` again.
- Courier's grant, profile and pending-request files are now written with fsync before anything acknowledges them.
- `--grant-file`, `--paste` (old `XXXX-XXXX` codes) and plain `init` are unchanged.
- `@tinycloud/share-envelope/links` exports the requester side of an approval request as a pure client: `approvalSessionProof`, `discoverApprovalResult`, `fetchApprovalResult`, `ackApprovalResult`, `collectApprovalResult`, `generateRelayKey`, `openRelayResult` and `checkApprovalResultBinding`.

Details: TC-2300
