---
"@tinycloud/courier": minor
"@tinycloud/node-sdk": minor
"@tinycloud/cli": patch
---

Courier's grant check is stricter. It is exact: the base grant is exactly `AGENT_GRANT`, and any `share/` entry (one exact key, the prefix, several keys, half a pair) is refused at grant load as `grant-too-broad`. The standing base grant never carries a share key.

`@tinycloud/node-sdk` adds `@tinycloud/node-sdk/share-publish` (`publishEmailShareV3`, moved unchanged from the CLI), `emailProofDescriptor` in `@tinycloud/node-sdk/credentials`, and `resumeAgentShareReceive` in `@tinycloud/node-sdk/share-receive` for a two-step receive across processes. The CLI imports `publishEmailShareV3` from node-sdk.

The node side (the Policy/v3 named-key binding, #481, and the refusal of unbound registrations, #485) is in production node 1.26.8.

Details: TC-2234
