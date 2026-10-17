---
"@tinycloud/cli": patch
---

A completed prepared OpenKey login now exits promptly under Node even when the browser opened a connection to the loopback callback and never sent a request, as Chromium does when Local Network Access refuses the callback. Closing the callback listener now also drops connections that never sent a request; the ACK's own connection closes after its response.
