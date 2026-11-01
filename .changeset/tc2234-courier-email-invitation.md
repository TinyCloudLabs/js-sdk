---
"@tinycloud/courier": minor
"@tinycloud/node-sdk": minor
"@tinycloud/cli": patch
---

Courier can send and open an email-bound invitation through the existing Share path (`courier invite --mode email --recipient <email>`, `courier join <share link> --consent [--code-stdin]`). The invitation body, with its existing pairing relay, is encrypted under a fresh `share/<shareId>` key and registered as one path-bound, digested Share policy owned by the Courier `did:key`; OpenCredentials mails the link and only the verified mailbox holder can open it. One invitation opens exactly one conversation; the session join, read and peer-delegation path is the existing one. The mode is not listed in `INVITATION_MODES` or the guide.

Courier's grant check stays exact for existing installs. When the owner is known it additionally accepts one thing: `key.create` and `decrypt` on exactly one canonical `<owner default network>/share/<32 lowercase hex>` key, byte for byte. The `share/` prefix, several keys, half a pair and any other spelling stay "too broad". Courier does not request that authority and nothing binds the signed key to a request: `AGENT_GRANT` and the OpenKey request are unchanged, the invitation's share id is generated when the invitation is made, so no grant signed earlier can name it. Sending therefore needs a per-invitation owner approval that does not exist yet (OpenKey `/delegate` work, not done). Without it `courier invite --mode email` stops with `invite-authority-missing`: by then it has already created a pairing relay delegation and stored invitation state (both unused until they expire), and it created no Share key, link or email and sent nothing. Which scope to request is an open decision.

Opening an invitation (`courier join <link> --consent --code-stdin`) checks everything it can before the one-time code reaches the witness: the signed envelope's exact resource path (`…/to/invite-<id>/envelope/<shareId>.json`), its expiry, its node origin against this profile's host, that its issuer is not this agent, the local profile, grant and node, and whether this invitation id was already joined. A failed check leaves the pending proof untouched. The body is encrypted, so its session, relay and pairing artifact cannot be checked until it is decrypted; then its id, node origin, issuer, expiry and space must equal the envelope's and the join state is checked again. The pending proof follows `courier credential acquire`: it is kept after a recoverable witness rejection (`EmailProofError.recoverable`) so the same request takes another code, and deleted on a terminal failure, once the code was accepted, and on success.

`@tinycloud/node-sdk` adds `@tinycloud/node-sdk/share-publish` (`publishEmailShareV3`, moved unchanged from the CLI), `emailProofDescriptor` in `@tinycloud/node-sdk/credentials`, and `resumeAgentShareReceive` in `@tinycloud/node-sdk/share-receive` for a two-step receive across processes. The CLI imports `publishEmailShareV3` from node-sdk.

Needs a node release containing the Policy/v3 named-key binding (#481) and the refusal of unbound registrations (#485) before it works against production.

Details: TC-2234
