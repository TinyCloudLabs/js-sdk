---
"@tinycloud/node-sdk": patch
"@tinycloud/cli": patch
---

Sign the share delivery authorization with the primary session key. The node records the signer as the delivery's sender key, and the SDK binds and countersigns the receipt with the primary session key; when a runtime grant held by another key covered the shared file, `tc share publish --to <email> --notify` rejected its own receipt and the recipient was never emailed (exit 9, `partial-failure`).
