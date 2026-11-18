---
"@tinycloud/cli": patch
---

When the TinyCloud CLI can't write to its profile folder, it now stops with a short error that names the folder and says why, instead of a raw `EACCES: permission denied, mkdir` message. Nothing changes before it stops.

Details: TC-3278
