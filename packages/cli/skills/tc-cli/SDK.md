# Programmatic access

Use the CLI for ordinary agent operations. The companion `@tinycloud/node-sdk` is useful when implementing an integration, not as an extra dependency for this skill. CLI 0.10.0 pins node-sdk 2.11.0; use the matching package's exported TypeScript declarations and [official SDK source](https://github.com/TinyCloudLabs/web-sdk/tree/adcd71c3857db1dd63c484b598b6203cbaacaaea/packages/node-sdk) when implementing code.

An authenticated `TinyCloudNode` exposes `kv`, `sql`, `kvForSpace(spaceId)` and `sqlForSpace(spaceId)`. A different space must preserve the authenticated owner context. Read/write services return structured result objects; handle the error branch before using returned data. Do not assume an unavailable body is an empty string.

Prefer the supported CLI login and profile store for external agent access. Reconstructing SDK sessions requires a verifiable signed SIWE proof and matching local session key. A copied public JWK, callback status or owner DID alone does not establish a usable session. Session keys, proof headers and private signer keys must not enter source code, prompts or public logs.

The session DID is `did:key:...`; the owner's primary DID is `did:pkh:eip155:CHAIN:ADDRESS`. User-to-user delegation targets the recipient's primary identity after sign-in. Child delegation expiry cannot exceed the parent's expiry and its not-before time cannot precede the parent's.

Application schema and retrieval behavior belong to that application's independently released pack. Keep generic SDK code independent of any particular app's SQL tables or KV prefixes.
