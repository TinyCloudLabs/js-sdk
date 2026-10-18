---
"@tinycloud/web-sdk": patch
---

Fix share receivers opened in several tabs at once ending up with different signing keys: a key stored by another tab a moment after this tab started is no longer discarded as future-dated.
