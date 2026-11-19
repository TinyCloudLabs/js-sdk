---
"@tinycloud/operations": patch
"@tinycloud/cli": patch
---

Reading a profile's key or session, or reading a profile through the shared operations readers (`readProfile`, `readSession`, and `resolveInvocationProfile` through them), now sets the profile folder to owner-only (700) and its files to 600, the same as `tinycloud profile show` and the other profile reads already did. A link planted in the folder is skipped and its target is left alone.

Details: TC-2653
