---
"@tinycloud/cli": minor
---

`tinycloud auth login --method openkey --timeout 60s` and `tinycloud init --timeout 60s` bound the wait for the owner's OpenKey approval, like `onboard --timeout` and `auth grant --timeout`: a new approval link exits 8 at once with `{"pending":{"step","of","approvalUrl","expiresAt"}}` on stdout, and running the same command again resumes the same saved request (same link, no new request), waits until the deadline, and collects the approval once the owner has given it. For a new account the space setup after the approval is bounded the same way as in `onboard`. `--timeout` with `--device`, `--paste`, `--keys`, `--method local` or a replication sign-in (`auth login`), or with `--paste` or `--key-only` (`init`), is a usage error (exit 2). `init` run again for a profile it created whose sign-in is still waiting resumes that sign-in instead of failing with `PROFILE_EXISTS`; any other existing profile is still refused. Without `--timeout` nothing else changes.

Details: TC-2433
