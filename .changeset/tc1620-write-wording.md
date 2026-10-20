---
"@tinycloud/cli": patch
---

Reword the `--write` description for `tinycloud auth request --preset apps-agent --write --app <app_id>` in the help, the README, the agent skill, the scope notice and the missing-grant hint (TC-1620). The write grant is described by what it lets the agent do: add and change the app's data under `knowledge/` and `prefs/`, and change its table rows. It cannot change the app's code, manifest or install record. The `tinycloud knowledge` missing-grant hint now also shows the write request for a named app. No grant shapes or behaviour change.
