---
"@tinycloud/cli": patch
---

Reword the `--write` description for `tinycloud auth request --preset apps-agent --write --app <app_id>` (TC-1620). With `--write --app <app_id>`, the agent can add and change that app's data: write its `knowledge/` and `prefs/` files and change its tables. The `tinycloud knowledge` missing-grant hint also shows this write request for a named app. No grant shapes change.

Details: TC-1620
