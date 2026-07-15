---
"@tinycloud/sdk-core": patch
"@tinycloud/operations": patch
---

Canonicalize JSON object keys using RFC 8785 raw UTF-16 code-unit ordering,
including astral-plane keys. Update operations' exact sdk-core dependency at
release so retry digests use the corrected canonicalization.
