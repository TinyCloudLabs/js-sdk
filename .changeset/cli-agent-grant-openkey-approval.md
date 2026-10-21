---
"@tinycloud/cli": minor
---

`tinycloud auth grant` on an OpenKey owner profile now sends every agent request to OpenKey, including `--preset apps-agent` requests with no extra entries, so the owner approves each one. `--yes` no longer skips that approval; it skips only the extras confirmation. The grant lasts as long as the approval allows, and requests are capped at 7 days. An approval that unchecks any requested ability is refused with `OPENKEY_APPROVAL_NARROWER`, and nothing is stored.

The agent grant is now signed by a fresh node restored from the verified approval session, not by the owner's node. A grant therefore no longer changes the owner's in-process runtime authority.

Without a terminal, the grant prints the OpenKey approval URL and waits for the callback; it does not open a browser.
