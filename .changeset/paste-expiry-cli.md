---
"@tinycloud/cli": patch
---

A login by paste now accepts the lifetime the owner chose in OpenKey, longer than 10 years included. `tc auth login --paste`, `tc auth rotate --paste` (on a profile without named keys), `tc init --paste` and `tc auth request --grant --paste` (custom `--cap`, `--permission` and `--manifest` grants) tell OpenKey the owner may choose the session lifetime (their link carries `expiryChangeable=true`), and the CLI saves the lifetime that was signed, however long, with no upper cap. It refuses only a signed lifetime of 60 seconds or less (`OPENKEY_EXPIRY_TOO_SHORT`), one a signed message cannot carry (after 9999-12-31, `OPENKEY_EXPIRY_UNREPRESENTABLE`), and one that has already ended (`AUTH_EXPIRED`). The first two are refusals of an approval OpenKey already granted, so they get the same cleanup and notice as the other refusals (no saved code, no key this login created, one notice).

Logins that do not send the opt-in keep the `--expiry` ceiling, so a longer lifetime is still refused there with `OPENKEY_EXPIRY_EXCEEDED`: the approval-request login, the device login, the prepared replica and `--keys` logins, and `tc auth request --grant --preset apps-agent --paste` (agent presets keep the 7-day agent policy: the lifetime can be shortened on the OpenKey page but not extended).

A paste login no longer refuses before approval because `--expiry` is shorter than a live session; the check runs again on the signed lifetime when the login is saved. A long paste session makes a later, shorter scoped login on the same profile ask for `--replace-session`, which is the existing policy for replacing a live session with a shorter one.

Details: TC-2276
