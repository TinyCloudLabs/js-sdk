---
"@tinycloud/courier": patch
---

`courier inbox` skips a message whose thread or message id, taken from the peer's key name, isn't a safe id (letters, digits, `-` and `_`, at most 64 characters), as the watcher already does. Such a message isn't fetched, listed or receipted; it is reported as `bad-message` with the id escaped, so no control or bidi character from a peer reaches the text or `--json` output. The ids in the `bad-message` and `message-too-large` errors are escaped too. Courier's `test` script now fails a test file that runs longer than 2 minutes instead of hanging.

Details: TC-2951
