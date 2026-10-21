---
"@tinycloud/cli": patch
---

Reword the `--write` description for `tinycloud auth request --preset apps-agent --write --app <app_id>`. With `--write --app <app_id>`, the agent can add and change that app's data: write its `knowledge/` and `prefs/` files and add, change or delete its table rows. For an app's catalog database it can also create, change and drop tables. The `tinycloud knowledge` missing-grant hint also shows this write request for a named app.

Details: TC-1422
