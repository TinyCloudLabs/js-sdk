---
"@tinycloud/courier": patch
"@tinycloud/cli": patch
---

Add a one-prompt guided start with persisted chat discovery, explicit selection, and signed invitation links. Support same-owner agents, anyone holding the link, and named Courier keys or verified paired handles through a participating issuer's scoped KV pairing relay. Bind joins and durable winning claims to the intended session; keep existing manual pairing guards and restrict guided peer grants to one thread. Email recipient identifiers are refused rather than treated as verified names.

Explicitly supplied empty invitation links, including positional links, are refused before chat discovery or creation; they cannot create or activate a fallback session.

Details: TC-1543
