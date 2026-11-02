---
"@tinycloud/cli": patch
---

`tc auth login --paste`, `tc auth rotate --paste` (on a profile without named keys), `tc init --paste` and `tc auth request --grant --paste` (custom `--cap`, `--permission` and `--manifest` grants) now let you choose the session lifetime on the OpenKey page: their link carries `expiryChangeable=true`, so a lifetime longer than `--expiry` can be signed. The CLI saves the lifetime that was signed and accepts it only if it is more than 60 seconds away and at most 10 years away; beyond that it refuses with `OPENKEY_EXPIRY_EXCEEDED` (the message names the 10-year limit), and a signed lifetime of 60 seconds or less is refused with `OPENKEY_EXPIRY_TOO_SHORT`. A paste login no longer refuses before approval because `--expiry` is shorter than a live session; the check runs again on the signed lifetime when the login is saved. Signed approval requests, device login, `tc onboard` (including a pasted code) and the prepared replica and `--keys` logins never send the opt-in and keep the `--expiry` ceiling; that includes `tc auth login --paste` with `--keys` or replication prefixes, and `tc auth rotate --paste` on a profile that has named keys (it uses the prepared login).

`tc auth request --grant --preset apps-agent --paste` does not send the opt-in: agent presets keep the 7-day agent policy, so the lifetime can be shortened on the OpenKey page but not extended, and custom `--cap`, `--permission` and `--manifest` grants are the ones that can choose longer.

A long paste session makes a later, shorter scoped login on the same profile ask for `--replace-session`. That is the existing policy for replacing a live session with a shorter one, and the error message names the flag.

Details: TC-2276
