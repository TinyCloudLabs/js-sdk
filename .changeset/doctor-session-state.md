---
"@tinycloud/cli": patch
---

`tc doctor` reports the session state again instead of "error reading session" for every profile with a session. An owner session with no signed OpenKey proof now shows "not usable (no signed OpenKey proof)" with the sign-in command.
