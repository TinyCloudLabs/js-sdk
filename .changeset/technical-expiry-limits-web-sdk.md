---
"@tinycloud/web-sdk": patch
---

When an app opts in with `openkey.expiryChangeable`, TinyCloudWeb now accepts a changed session expiry of any length up to 9999-12-31, including 11 or 100 years. It no longer refuses an expiry more than 10 years away. An expiry later than 9999-12-31, or one that is not a date, is refused with a message that names the date.

Details: TC-2272
