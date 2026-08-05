---
sidebar_position: 4
---

# OAuth canonical-key sessions

Use `tinycloud:manage-key` only after your OAuth client has requested and
received that explicit scope. Parse the validated token's canonical-identity
claim, then call `establishManageKeySession` from `@tinycloud/web-sdk`. The
helper signs the normal TinyCloud SIWE session with a bearer-only request and
cannot bootstrap an account or use another wallet.

The complete integration reference, including the canonical claim shape,
terminal error handling, runnable two-client example, and real HTTP smoke
command, is maintained in the repository's
[manage-key integration guide](https://github.com/TinyCloudLabs/web-sdk/blob/master/docs/manage-key-sdk.md).
