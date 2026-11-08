---
"@tinycloud/cli": patch
---

The CLI no longer asks "Approve local-key delegation? [y/N]" or "Sign the N entries marked ! above, and the rest of the request? [y/N]" before signing a permission grant, and no longer refuses a run without a terminal with `CONFIRMATION_REQUIRED` (exit 2). This covers `auth request --grant` and `auth grant` on a local-key profile, and the one-use revoke authority behind `delegation revoke` and `auth grants remove --revoke`. On an OpenKey profile the OpenKey approval is unchanged and still required.

`--yes` is still accepted on `auth request`, `auth grant` and `auth grants remove` and does nothing; on a terminal it prints `--yes is no longer needed and has no effect.` (nothing in JSON mode, so stderr stays machine-readable). `delegation revoke --yes` still confirms revoking the current sign-in session, as before.

Details: TC-2531
