---
"@tinycloud/cli": patch
---

`tc auth login --paste` exits once it has handled the pasted code, even when stdin is still open (TC-1025). Before, a wrapper that wrote the code and kept its pipe open left the CLI running after it printed `authenticated: true`, until the pipe closed.
