---
"@tinycloud/cli": patch
---

`auth request --preset apps-agent` now accepts any number of `--app` values (it used to stop at 5 and suggest read-only access to the whole space instead), and a preset request naming more than 5 apps is shown with the standard preset wording.

Details: TC-2533
