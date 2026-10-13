---
"@tinycloud/cli": patch
---

`tc` commands now exit once they finish, even when the caller keeps stdin open (TC-1025). Most visibly, `tc auth login --paste` used to stay running after printing `authenticated: true` until a wrapper that wrote the code and kept its pipe open finally closed it. The CLI now releases stdin after the command settles. `tc courier` has its own entry point and is unchanged.
