---
"@tinycloud/cli": patch
---

`tinycloud courier watch` now bundles the Courier that restricts `--home-file` to the model-login file of the agent CLI it starts (refusing symbolic links), reads the Claude login without following links, and removes links an agent planted in its clean HOME before each wake. The bundled Courier is built from the workspace, so a courier-only changeset publishes `@tinycloud/courier` but not `@tinycloud/cli`; this changeset is what puts those fixes in a CLI release.

Details: TC-3014
