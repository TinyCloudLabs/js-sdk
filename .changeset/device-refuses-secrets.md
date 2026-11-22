---
"@tinycloud/cli": patch
---

`tinycloud auth login --device` refuses a request or manifest that touches the secrets space, before sending anything, with one line that points to `tinycloud auth login --paste`.

Details: TC-3480
