---
"@tinycloud/cli": patch
---

`tc init` and other spinner steps print one plain progress line per step, with no animation, when the terminal reports 0 columns. Terminals with a normal size keep the animated spinner.

Details: TC-1893
