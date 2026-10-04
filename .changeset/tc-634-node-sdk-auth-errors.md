---
"@tinycloud/node-sdk": minor
---

Preserve typed HTTP status and server response text in node-info, encryption-network, V3 delivery, bootstrap, and owned-space hosting failures. Bootstrap service errors and host/activation results now remain available through error causes; `hostOwnedSpace()` reports rejected host delegations without collapsing their status to a boolean.
