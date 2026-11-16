---
"@tinycloud/cli": patch
---

`tinycloud courier inbox` now bundles the Courier with the inbox safe-id gate: a message whose thread or message id, taken from the peer's key name, isn't a safe id is skipped (not fetched, listed or receipted) and reported as `bad-message` with the id escaped, so no control or bidi character from a peer reaches the text or `--json` output. The bundled Courier is built from the workspace, so a courier-only changeset publishes `@tinycloud/courier` but not `@tinycloud/cli`; this changeset is what ships the bundled Courier with the inbox safe-id gate in a CLI release.

Details: TC-2951
