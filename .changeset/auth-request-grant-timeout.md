---
"@tinycloud/cli": minor
---

`tinycloud auth request ... --grant --timeout 60s` bounds the wait for the owner's OpenKey approval, like `onboard --timeout` and `auth grant --timeout`: it prints the approval link and exits 8 with `{"pending":{"step","of","approvalUrl","expiresAt"}}` on stdout, and running the same command again resumes the same saved request (same link, no new request) and collects the approval. A grant over several spaces is one approval per space (`step` N of M) and activates nothing until the last is approved. `--timeout` without `--grant`, or with `--paste` or `--device`, is a usage error (exit 2). Without `--timeout` nothing changes.

A saved approval request that is past its own expiry no longer has its link printed again, including within OpenKey's 10-minute result retention: the command asks OpenKey first, collects an approval given before the expiry, ends as exit 3 on an expired one (the next run makes a new link), and shows the old link only if OpenKey still reports the request open. While it asks, stderr says `Checking the saved request with OpenKey...` (no link), and a `--timeout` that ends before OpenKey could be asked exits 3, never with a pending link.

Details: TC-3125
