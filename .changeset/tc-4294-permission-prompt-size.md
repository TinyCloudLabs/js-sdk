---
"@tinycloud/web-sdk": patch
---

The permission prompt loads about 50 KB again instead of 0.9 MB. Since the prompt began stating exactly what each request grants, opening it also loaded a second copy of much of the SDK. It now uses the copy the page already has. What the prompt shows is unchanged.

Details: TC-4294
